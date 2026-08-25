import { describe, expect, it } from 'vitest';
import type { NormalizedAction } from '../../src/core/types.js';
import { formatReport } from '../../src/cli/report.js';
import type { CliRecord } from '../../src/cli/run.js';

const ACTION: NormalizedAction = {
  kind: 'fs-write',
  tool: 'write',
  paths: ['config/prod/db.yaml'],
  summary: 'write config/prod/db.yaml',
};

const BLOCK_RECORD: CliRecord = {
  commitmentId: 'no-prod-config',
  statement: 'Never modify production configuration files.',
  severity: 'block',
  tier: 1,
  outcome: 'block',
  cause: 'structural',
  pattern: 'config/prod/**',
  rationale: 'structural match: config/prod/**',
  judged: null,
};

const JUDGE_UNAVAILABLE_RECORD: CliRecord = {
  commitmentId: 'stay-on-task',
  statement: 'Do not modify files unrelated to the assigned task.',
  severity: 'block',
  tier: 2,
  outcome: 'block',
  cause: 'judge-unavailable',
  pattern: null,
  rationale: 'judge unavailable (no judge configured); failing closed',
  judged: null,
};

describe('formatReport', () => {
  it('renders the exact default one-line-plus-attributions format for a BLOCK', () => {
    const { stdout } = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [BLOCK_RECORD],
      warnings: [],
      json: false,
      explain: false,
    });
    expect(stdout).toBe('BLOCK\nno-prod-config  tier=1  pattern="config/prod/**"\n');
  });

  it('renders stdout exactly ALLOW\\n for a clean allow with no records', () => {
    const { stdout } = formatReport({
      decision: 'allow',
      exitCode: 0,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [],
      warnings: [],
      json: false,
      explain: false,
    });
    expect(stdout).toBe('ALLOW\n');
  });

  it('routes warnings to stderr, never stdout, in default mode', () => {
    const { stdout, stderr } = formatReport({
      decision: 'allow',
      exitCode: 0,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [],
      warnings: ['degraded allow: commitment "x" judge unavailable'],
      json: false,
      explain: false,
    });
    expect(stdout).toBe('ALLOW\n');
    expect(stderr).toContain('degraded allow');
  });

  it('--explain expands each record with id, statement, severity, structural tier annotation, and pattern', () => {
    const { stdout } = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [BLOCK_RECORD],
      warnings: [],
      json: false,
      explain: true,
    });
    expect(stdout).toContain('no-prod-config');
    expect(stdout).toContain('Never modify production configuration files.');
    expect(stdout).toContain('severity: block');
    expect(stdout).toContain('1 (structural)');
    expect(stdout).toContain('"config/prod/**"');
    expect(stdout).toContain('decision: BLOCK (exit 1)');
  });

  it('--explain annotates a judge-unavailable tier-2 record with the failMode and marks pattern as semantic', () => {
    const { stdout } = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [JUDGE_UNAVAILABLE_RECORD],
      warnings: [],
      json: false,
      explain: true,
      failMode: 'closed',
    });
    expect(stdout).toContain('2 (judge-unavailable, failMode: closed)');
    expect(stdout).toContain('(semantic - no structural pattern)');
  });

  it('emits only the JSON document on stdout, and round-trips every field', () => {
    const { stdout, stderr } = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [BLOCK_RECORD],
      warnings: ['an advisory'],
      json: true,
      explain: false,
    });
    const doc = JSON.parse(stdout);
    expect(doc.decision).toBe('block');
    expect(doc.exitCode).toBe(1);
    expect(doc.commitmentsFile).toBe('/abs/commitments.yaml');
    expect(doc.action).toEqual(ACTION);
    expect(doc.records).toEqual([BLOCK_RECORD]);
    expect(doc.warnings).toEqual(['an advisory']);
    expect(stderr).toContain('an advisory');
  });

  it('--json --explain is byte-identical to --json alone (explain is a documented no-op under json)', () => {
    const withoutExplain = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [BLOCK_RECORD],
      warnings: [],
      json: true,
      explain: false,
    });
    const withExplain = formatReport({
      decision: 'block',
      exitCode: 1,
      commitmentsFile: '/abs/commitments.yaml',
      action: ACTION,
      records: [BLOCK_RECORD],
      warnings: [],
      json: true,
      explain: true,
    });
    expect(withExplain.stdout).toBe(withoutExplain.stdout);
  });
});
