import type { Decision, NormalizedAction } from '../core/types.js';
import type { CliRecord } from './run.js';

export interface CliJsonOutput {
  decision: Decision;
  exitCode: number;
  commitmentsFile: string;
  action: NormalizedAction;
  records: CliRecord[];
  warnings: string[];
}

export interface ReportInput {
  decision: Decision;
  exitCode: number;
  commitmentsFile: string;
  action: NormalizedAction;
  records: CliRecord[];
  warnings: string[];
  json: boolean;
  explain: boolean;
  /** Only consulted by --explain's judge-unavailable tier annotation. */
  failMode?: string;
}

export interface ReportOutput {
  stdout: string;
  stderr: string;
}

function formatDefault(decision: Decision, records: CliRecord[]): string {
  const lines = [decision.toUpperCase()];
  for (const r of records) {
    const pattern = r.pattern !== null ? `"${r.pattern}"` : '(none)';
    lines.push(`${r.commitmentId}  tier=${r.tier}  pattern=${pattern}`);
  }
  return `${lines.join('\n')}\n`;
}

function tierAnnotation(record: CliRecord, failMode: string): string {
  if (record.tier === 1) return '1 (structural)';
  if (record.cause === 'judged') return '2 (judged)';
  return `2 (judge-unavailable, failMode: ${failMode})`;
}

function formatExplain(
  decision: Decision,
  exitCode: number,
  action: NormalizedAction,
  records: CliRecord[],
  failMode: string,
): string {
  const target =
    action.command !== undefined ? `command="${action.command}"` : `paths=[${(action.paths ?? []).join(', ')}]`;
  const lines = [`action: tool=${action.tool} kind=${action.kind} ${target}`, ''];
  for (const r of records) {
    lines.push(
      `commitment: ${r.commitmentId}`,
      `statement: ${r.statement}`,
      `severity: ${r.severity}`,
      `tier: ${tierAnnotation(r, failMode)}`,
      `pattern: ${r.pattern !== null ? `"${r.pattern}"` : '(semantic - no structural pattern)'}`,
      `rationale: ${r.rationale}`,
      '',
    );
  }
  lines.push(`decision: ${decision.toUpperCase()} (exit ${exitCode})`);
  return `${lines.join('\n')}\n`;
}

/**
 * --json: stdout carries ONLY the JSON document, all advisory text on stderr,
 * so `| jq .` is safe. --explain is a documented no-op when --json is set:
 * this function must never let `explain` influence the json branch.
 */
export function formatReport(input: ReportInput): ReportOutput {
  const stderr = input.warnings.map((w) => `warning: ${w}\n`).join('');

  if (input.json) {
    const doc: CliJsonOutput = {
      decision: input.decision,
      exitCode: input.exitCode,
      commitmentsFile: input.commitmentsFile,
      action: input.action,
      records: input.records,
      warnings: input.warnings,
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr };
  }

  const stdout = input.explain
    ? formatExplain(input.decision, input.exitCode, input.action, input.records, input.failMode ?? 'closed')
    : formatDefault(input.decision, input.records);

  return { stdout, stderr };
}
