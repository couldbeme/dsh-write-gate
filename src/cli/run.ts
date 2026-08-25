import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCommitments } from '../core/commitments.js';
import { createGate } from '../core/gate.js';
import { evaluateTier1 } from '../core/tier1.js';
import type { CommitmentSet, ContradictionRecord, JudgeVerdict } from '../core/types.js';
import { buildAction } from './action.js';
import type { CliArgs } from './args.js';
import { exitCodeForDecision } from './exit-codes.js';
import { formatReport } from './report.js';

export type RunCheckInput = CliArgs;

export interface RunCheckDeps {
  /** Mirrors GateOptions.now: injectable so tests never touch the real filesystem. */
  readCommitmentsFile?: (path: string) => string;
}

export interface RunCheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One record in the CLI's JSON `records` array (schema fixed by the blueprint). */
export interface CliRecord {
  commitmentId: string;
  statement: string;
  severity: 'block' | 'warn';
  tier: 1 | 2;
  outcome: 'block' | 'warn' | 'allow-open';
  cause: 'structural' | 'judged' | 'judge-unavailable';
  pattern: string | null;
  rationale: string;
  judged: JudgeVerdict | null;
}

const defaultReadCommitmentsFile = (path: string): string => readFileSync(path, 'utf8');

/**
 * Distinguish record causes structurally, never by parsing rationale text.
 * gate.ts builds exactly one ContradictionRecord per tier-1 hit, in order,
 * before appending tier-2 records — so the first `t1Hits.length` gate
 * records line up index-for-index with an independent evaluateTier1(set,
 * action) call.
 */
function buildCliRecords(
  set: CommitmentSet,
  t1Hits: ReturnType<typeof evaluateTier1>['hits'],
  gateRecords: ContradictionRecord[],
): CliRecord[] {
  const byId = new Map(set.commitments.map((c) => [c.id, c] as const));
  return gateRecords.map((record, i) => {
    const commitment = byId.get(record.commitmentId)!;
    const hit = i < t1Hits.length ? t1Hits[i] : undefined;
    const cause: CliRecord['cause'] = hit ? 'structural' : record.judged ? 'judged' : 'judge-unavailable';
    return {
      commitmentId: record.commitmentId,
      statement: record.statement,
      severity: commitment.severity,
      tier: record.tier,
      outcome: record.outcome,
      cause,
      pattern: hit ? hit.matched : null,
      rationale: record.rationale,
      judged: record.judged ?? null,
    };
  });
}

export async function runCheck(input: RunCheckInput, deps: RunCheckDeps = {}): Promise<RunCheckResult> {
  const readCommitmentsFile = deps.readCommitmentsFile ?? defaultReadCommitmentsFile;
  const commitmentsPath = resolve(input.commitments);

  let set: CommitmentSet;
  try {
    const yamlText = readCommitmentsFile(commitmentsPath);
    set = loadCommitments(yamlText);
  } catch (cause) {
    return { exitCode: 4, stdout: '', stderr: `error: ${(cause as Error).message}\n` };
  }

  const action = buildAction({
    tool: input.tool,
    paths: input.paths,
    ...(input.command !== undefined ? { command: input.command } : {}),
  });

  const warnings: string[] = [];
  if (input.paths.length > 0 && input.command !== undefined && action.kind === 'shell') {
    warnings.push(
      `--path is ignored: tool "${input.tool}" resolves to kind shell, which reads from --command only`,
    );
  }

  const t1 = evaluateTier1(set, action);
  const gate = createGate(set, {});
  const gateResult = await gate.check(action);
  const records = buildCliRecords(set, t1.hits, gateResult.records);

  for (const r of records) {
    if (r.outcome === 'allow-open') {
      warnings.push(`degraded allow: commitment "${r.commitmentId}" judge unavailable, failing open (${r.rationale})`);
    }
  }

  const exitCode = exitCodeForDecision(gateResult.decision);

  const { stdout, stderr } = formatReport({
    decision: gateResult.decision,
    exitCode,
    commitmentsFile: commitmentsPath,
    action,
    records,
    warnings,
    json: input.json,
    explain: input.explain,
    failMode: set.defaults.failMode,
  });

  return { exitCode, stdout, stderr };
}
