/**
 * dsh-write-gate — DeepSeek Harness adapter for the commitment write-gate.
 *
 * Function-style Cordis plugin (spill-policy shape): the module namespace IS
 * the plugin object, so this file must have NO default export.
 *
 * Enforcement mapping, deliberately two-slot:
 *  - tier 1 (deterministic) lives in `ctx.tools.guard()` — the monotonic slot
 *    where no listener ordering can turn a denial back into permission;
 *  - tier 2 (semantic judge) lives on the `tools/pre-execute` waterfall,
 *    which is async-capable and short-circuits with a decision object.
 * `agent/pre-step` is the judge-budget boundary.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent';
import { loadCommitments } from '../core/commitments.js';
import { digestOf } from '../core/digest.js';
import { createGate } from '../core/gate.js';
import { createLlmJudge } from '../core/judge-llm.js';
import { evaluateTier1 } from '../core/tier1.js';
import type { CommitmentSet, ContradictionRecord, Judge, NormalizedAction } from '../core/types.js';
import { normalizeExec } from './normalize.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A write-gate contradiction record was produced (tier-1 structural block
     * or a tier-2 judged violation / fail-closed outcome). Live-only
     * coordination signal; the durable copy goes to the contradictions log.
     * @mode emit
     */
    'write-gate/contradiction'(record: ContradictionRecord): void;
  }
}

/** Plugin config. */
export interface Config {
  /** Commitments file path, resolved from the process cwd. */
  commitmentsFile?: string;
  /** JSONL contradictions-log path; every record is appended as one line. */
  contradictionsLog?: string;
  judgeTimeoutMs?: number;
  /** Tier-2 judge model route; omit to run tier 1 only (escalations then follow failMode). */
  judge?: {
    provider: string;
    model: string;
    maxTokens?: number;
  };
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'write-gate';

/** Require the tool registry — both enforcement slots live on it. */
export const inject = ['tools'];

export const Config: z<Config> = z.object({
  commitmentsFile: z.string().default('COMMITMENTS.yaml'),
  contradictionsLog: z.string().default('write-gate.contradictions.jsonl'),
  judgeTimeoutMs: z.number().default(15_000),
  judge: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().default(300),
  }),
});

function summarizeBlocks(records: ContradictionRecord[]): string {
  const blocking = records.filter((r) => r.outcome === 'block');
  return blocking.map((r) => `"${r.commitmentId}" (${r.rationale})`).join('; ');
}

function makeJudge(ctx: Context, judgeConfig: NonNullable<Config['judge']>): Judge {
  return createLlmJudge(async (prompt, signal) => {
    const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const assembler = new BlockAssembler();
    const stream = ctx.llm.stream({
      provider: judgeConfig.provider,
      model: judgeConfig.model,
      maxTokens: judgeConfig.maxTokens ?? 300,
      temperature: 0,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      ...(signal ? { signal } : {}),
    });
    for await (const chunk of stream) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`judge model call finished with ${finish.kind}`);
    }
    return assembler
      .blocks()
      .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
      .join('');
  });
}

export function apply(ctx: Context, config: Config): void {
  const commitmentsPath = resolve(config?.commitmentsFile ?? 'COMMITMENTS.yaml');
  let yamlText: string;
  try {
    yamlText = readFileSync(commitmentsPath, 'utf8');
  } catch (cause) {
    // Fail the deployment, not the tool: a mounted gate that silently guards
    // nothing would be worse than a loud missing file.
    throw new Error(`write-gate: cannot read commitments file at ${commitmentsPath}: ${(cause as Error).message}`);
  }
  const set: CommitmentSet = loadCommitments(yamlText); // parse errors also fail the mount

  const logPath = resolve(config?.contradictionsLog ?? 'write-gate.contradictions.jsonl');
  const emitRecord = (record: ContradictionRecord): void => {
    try {
      ctx.emit('write-gate/contradiction', record);
    } catch {
      // observers must never break the pipeline
    }
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    } catch {
      // logging is best-effort by design; the decision already stands
    }
  };

  const judge = config?.judge?.provider && config.judge.model ? makeJudge(ctx, config.judge) : undefined;
  const gate = createGate(set, {
    ...(judge ? { judge } : {}),
    emit: emitRecord,
    ...(config?.judgeTimeoutMs ? { judgeTimeoutMs: config.judgeTimeoutMs } : {}),
  });

  const guardRecord = (action: NormalizedAction, commitmentId: string, statement: string, matched: string): void => {
    emitRecord({
      at: new Date().toISOString(),
      commitmentId,
      statement,
      action: {
        tool: action.tool,
        kind: action.kind,
        summary: action.summary,
        digest: digestOf({
          tool: action.tool,
          kind: action.kind,
          paths: action.paths,
          command: action.command,
          summary: action.summary,
        }),
      },
      tier: 1,
      outcome: 'block',
      rationale: `structural match (monotonic guard): ${matched}`,
    });
  };

  // Tier 1 in the monotonic slot: runs after every pre-execute listener, and
  // no listener ordering can re-allow what it denies.
  ctx.tools.guard((exec) => {
    try {
      const action = normalizeExec(exec);
      const t1 = evaluateTier1(set, action);
      if (t1.decision !== 'block') return undefined;
      const byId = new Map(set.commitments.map((c) => [c.id, c] as const));
      for (const hit of t1.hits) {
        if (hit.severity !== 'block') continue;
        const c = byId.get(hit.commitmentId)!;
        guardRecord(action, c.id, c.statement, hit.matched);
      }
      const reasons = t1.hits
        .filter((h) => h.severity === 'block')
        .map((h) => `"${h.commitmentId}" (${h.matched})`)
        .join('; ');
      return `write-gate: blocked by commitment ${reasons}`;
    } catch (cause) {
      // A guard must stay synchronous and total; on internal error follow failMode.
      return set.defaults.failMode === 'closed'
        ? `write-gate: internal error while evaluating commitments (failing closed): ${(cause as Error).message}`
        : undefined;
    }
  });

  // Tier 2 (plus tier-1 short-circuit) on the extensible waterfall. `prepend`
  // so a later-registered allow-short-circuit cannot skip the semantic check;
  // the monotonic guard above backstops tier 1 in every ordering.
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      try {
        if (exec.signal.aborted) return next();
        const action = normalizeExec(exec);
        const result = await gate.check(action, { signal: exec.signal });
        if (result.decision === 'block') {
          return { kind: 'deny' as const, reason: `write-gate: blocked by commitment ${summarizeBlocks(result.records)}` };
        }
        return next();
      } catch (cause) {
        // Waterfall throws are uncontained in dsh — contain ours and follow failMode.
        if (set.defaults.failMode === 'closed') {
          return {
            kind: 'deny' as const,
            reason: `write-gate: internal error (failing closed): ${(cause as Error).message}`,
          };
        }
        return next();
      }
    },
    { prepend: true },
  );

  // Step boundary = judge-budget boundary. Annotate-only listener: always delegate.
  ctx.on('agent/pre-step', (_payload, next) => {
    gate.newStep();
    return next();
  });
}
