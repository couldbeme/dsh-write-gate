import { digestOf } from './digest.js';
import { evaluateTier1 } from './tier1.js';
import type {
  Commitment,
  CommitmentSet,
  ContradictionRecord,
  Decision,
  Gate,
  GateOptions,
  GateResult,
  JudgeVerdict,
  NormalizedAction,
} from './types.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;

function raise(current: Decision, next: Decision): Decision {
  const rank: Record<Decision, number> = { allow: 0, warn: 1, block: 2 };
  return rank[next] > rank[current] ? next : current;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createGate(set: CommitmentSet, opts: GateOptions = {}): Gate {
  const timeoutMs = opts.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  const memo = new Map<string, JudgeVerdict>();
  let budgetLeft = set.defaults.judgeBudgetPerStep;

  function record(
    records: ContradictionRecord[],
    c: Commitment,
    action: NormalizedAction,
    actionDigest: string,
    tier: 1 | 2,
    outcome: ContradictionRecord['outcome'],
    rationale: string,
    judged?: JudgeVerdict,
  ): void {
    const entry: ContradictionRecord = {
      at: now(),
      commitmentId: c.id,
      statement: c.statement,
      action: { tool: action.tool, kind: action.kind, summary: action.summary, digest: actionDigest },
      tier,
      outcome,
      rationale,
      ...(judged ? { judged } : {}),
    };
    records.push(entry);
    opts.emit?.(entry);
  }

  async function judgeOnce(
    c: Commitment,
    action: NormalizedAction,
    actionDigest: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'verdict'; verdict: JudgeVerdict } | { kind: 'unavailable'; reason: string }> {
    const key = `${c.id}:${actionDigest}`;
    const cached = memo.get(key);
    if (cached) return { kind: 'verdict', verdict: cached };

    if (!opts.judge) return { kind: 'unavailable', reason: 'no judge configured' };
    if (budgetLeft <= 0) {
      return {
        kind: 'unavailable',
        reason: `judge budget exhausted (${set.defaults.judgeBudgetPerStep} per step)`,
      };
    }

    budgetLeft -= 1;
    try {
      const verdict = await withTimeout(
        opts.judge({ statement: c.statement, action, ...(signal ? { signal } : {}) }),
        timeoutMs,
      );
      memo.set(key, verdict);
      return { kind: 'verdict', verdict };
    } catch (cause) {
      return { kind: 'unavailable', reason: (cause as Error).message };
    }
  }

  return {
    newStep(): void {
      budgetLeft = set.defaults.judgeBudgetPerStep;
    },

    async check(action: NormalizedAction, checkOpts: { signal?: AbortSignal } = {}): Promise<GateResult> {
      const records: ContradictionRecord[] = [];
      const actionDigest = digestOf({
        tool: action.tool,
        kind: action.kind,
        paths: action.paths,
        command: action.command,
        summary: action.summary,
      });

      const t1 = evaluateTier1(set, action);
      const byId = new Map(set.commitments.map((c) => [c.id, c]));
      for (const hit of t1.hits) {
        const c = byId.get(hit.commitmentId)!;
        record(records, c, action, actionDigest, 1, hit.severity, `structural match: ${hit.matched}`);
      }
      if (t1.decision === 'block') {
        return { decision: 'block', records };
      }

      let decision: Decision = t1.decision;
      for (const c of t1.escalate) {
        const outcome = await judgeOnce(c, action, actionDigest, checkOpts.signal);
        if (outcome.kind === 'verdict') {
          if (outcome.verdict.violation) {
            record(records, c, action, actionDigest, 2, c.severity, outcome.verdict.rationale, outcome.verdict);
            decision = raise(decision, c.severity);
          }
          continue;
        }
        // Judge unavailable: budget exhaustion is reported in its own words so
        // the operator can distinguish cost ceilings from provider failures.
        const budgetHit = outcome.reason.startsWith('judge budget exhausted');
        const reason = budgetHit
          ? `${outcome.reason}; treated as unavailable`
          : `judge unavailable (${outcome.reason})`;
        if (set.defaults.failMode === 'closed') {
          record(records, c, action, actionDigest, 2, c.severity, `${reason}; failing closed`);
          decision = raise(decision, c.severity);
        } else {
          record(records, c, action, actionDigest, 2, 'allow-open', `${reason}; failing open`);
        }
      }

      return { decision, records };
    },
  };
}
