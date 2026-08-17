/**
 * Engine-agnostic core types. Nothing in src/core may import from any harness;
 * adapters (dsh, claude-code, ...) map their tool calls into NormalizedAction
 * and inject a Judge implementation.
 */

export type NormalizedKind = 'fs-write' | 'fs-read' | 'shell' | 'net' | 'other';

export interface NormalizedAction {
  kind: NormalizedKind;
  /** Harness-native tool name, kept for attribution (e.g. "fs/write", "bash"). */
  tool: string;
  paths?: string[];
  command?: string;
  /** One-line human-readable description used in records and judge prompts. */
  summary: string;
}

export type Severity = 'block' | 'warn';
export type FailMode = 'closed' | 'open';

export interface CommitmentMatch {
  kinds?: NormalizedKind[];
  tools?: string[];
  /** Glob patterns evaluated against NormalizedAction.paths. */
  paths?: string[];
  /** Regular-expression sources evaluated against NormalizedAction.command. */
  commands?: string[];
}

export interface Commitment {
  id: string;
  /** The operator-authored constraint, verbatim. This is what the judge reads. */
  statement: string;
  severity: Severity;
  /** Eligible for tier-2 semantic judgement when tier-1 is inconclusive. */
  semantic: boolean;
  match?: CommitmentMatch;
  /** Internal: matchers compiled once at load time. */
  compiled: CompiledMatch;
}

export interface CompiledMatch {
  paths: Array<(candidate: string) => boolean>;
  commands: RegExp[];
}

export interface CommitmentSetDefaults {
  failMode: FailMode;
  judgeBudgetPerStep: number;
}

export interface CommitmentSet {
  version: 1;
  defaults: CommitmentSetDefaults;
  commitments: Commitment[];
}

export interface Hit {
  commitmentId: string;
  severity: Severity;
  /** What matched, for attribution (glob or regex source). */
  matched: string;
}

export type Decision = 'allow' | 'warn' | 'block';

export interface Tier1Result {
  decision: Decision;
  hits: Hit[];
  /** Semantic commitments that structural matching could not settle. */
  escalate: Commitment[];
}

export interface JudgeInput {
  statement: string;
  action: NormalizedAction;
}

export interface JudgeVerdict {
  violation: boolean;
  /** 0..1 */
  confidence: number;
  rationale: string;
}

export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>;

export type RecordOutcome = 'block' | 'warn' | 'allow-open';

export interface ContradictionRecord {
  at: string;
  commitmentId: string;
  statement: string;
  action: {
    tool: string;
    kind: NormalizedKind;
    summary: string;
    digest: string;
  };
  tier: 1 | 2;
  outcome: RecordOutcome;
  rationale: string;
  judged?: JudgeVerdict;
}

export interface GateResult {
  decision: Decision;
  records: ContradictionRecord[];
}

export interface GateOptions {
  judge?: Judge;
  /** Sink invoked for every record as it is produced (e.g. contradictions log). */
  emit?: (record: ContradictionRecord) => void;
  /** Injectable clock for deterministic records. */
  now?: () => string;
  judgeTimeoutMs?: number;
}

export interface Gate {
  check(action: NormalizedAction): Promise<GateResult>;
  /** Reset the per-step judge budget. Adapters call this at step boundaries. */
  newStep(): void;
}
