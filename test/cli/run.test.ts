import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCommitments } from '../../src/core/commitments.js';
import { evaluateTier1 } from '../../src/core/tier1.js';
import { buildAction } from '../../src/cli/action.js';
import { runCheck } from '../../src/cli/run.js';
import type { CliArgs } from '../../src/cli/args.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../../commitments.example.yaml', import.meta.url));
const EXAMPLE_YAML = readFileSync(EXAMPLE_PATH, 'utf8');

const WARN_STRUCTURAL_YAML = `
version: 1
commitments:
  - id: warn-env-write
    statement: Warn before writing to a .env file.
    severity: warn
    match:
      kinds: [fs-write]
      paths: ["**/.env"]
`;

const SEMANTIC_CLOSED_YAML = `
version: 1
commitments:
  - id: stay-on-task
    statement: Do not modify files unrelated to the assigned task.
    semantic: true
    match:
      kinds: [fs-write]
`;

const SEMANTIC_OPEN_YAML = `
version: 1
defaults:
  failMode: open
commitments:
  - id: stay-on-task
    statement: Do not modify files unrelated to the assigned task.
    semantic: true
    match:
      kinds: [fs-write]
`;

const ORDERING_YAML = `
version: 1
commitments:
  - id: warn-a
    statement: warn A
    severity: warn
    match:
      kinds: [fs-write]
      paths: ["**/*.secret"]
  - id: warn-b
    statement: warn B
    severity: warn
    match:
      kinds: [fs-write]
      paths: ["**/config.secret"]
  - id: stay-on-task
    statement: stay on task
    semantic: true
    match:
      kinds: [fs-write]
`;

const MALFORMED_YAML = `version: 1\ncommitments: [`;

const DUPLICATE_ID_YAML = `
version: 1
commitments:
  - id: twin
    statement: a
    semantic: true
  - id: twin
    statement: b
    semantic: true
`;

const BAD_REGEX_YAML = `
version: 1
commitments:
  - id: bad-re
    statement: no force pushes
    match:
      kinds: [shell]
      commands: ["git push --force ("]
`;

const deps = (yaml: string) => ({ readCommitmentsFile: () => yaml });

const baseArgs = (overrides: Partial<CliArgs>): CliArgs => ({
  commitments: 'commitments.yaml',
  tool: 'bash',
  paths: [],
  explain: false,
  json: false,
  ...overrides,
});

describe('runCheck', () => {
  it('blocks a force-push command against commitments.example.yaml, tier 1, cause structural, matched pattern equal to the file regex source', async () => {
    const args = baseArgs({ tool: 'bash', command: 'git push --force origin main', json: true });
    const result = await runCheck(args, deps(EXAMPLE_YAML));
    expect(result.exitCode).toBe(1);
    const doc = JSON.parse(result.stdout);
    expect(doc.decision).toBe('block');
    expect(doc.exitCode).toBe(1);
    const rec = doc.records.find((r: { commitmentId: string }) => r.commitmentId === 'no-force-push');
    expect(rec).toMatchObject({ tier: 1, cause: 'structural' });
    const set = loadCommitments(EXAMPLE_YAML);
    const expectedPattern = set.commitments.find((c) => c.id === 'no-force-push')!.match!.commands![0]!;
    expect(rec.pattern).toBe(expectedPattern);
  });

  it('blocks a prod config write against commitments.example.yaml with the config/prod/** pattern', async () => {
    const args = baseArgs({ tool: 'write', paths: ['config/prod/db.yaml'], json: true });
    const result = await runCheck(args, deps(EXAMPLE_YAML));
    expect(result.exitCode).toBe(1);
    const doc = JSON.parse(result.stdout);
    const rec = doc.records.find((r: { commitmentId: string }) => r.commitmentId === 'no-prod-config');
    expect(rec).toMatchObject({ tier: 1, cause: 'structural', pattern: 'config/prod/**' });
  });

  it('allows a benign command with stdout exactly ALLOW\\n', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls -la' });
    const result = await runCheck(args, deps(EXAMPLE_YAML));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ALLOW\n');
  });

  it('warns on a warn-severity structural hit, exit 3', async () => {
    const args = baseArgs({ tool: 'write', paths: ['api/.env'] });
    const result = await runCheck(args, deps(WARN_STRUCTURAL_YAML));
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('WARN');
  });

  it('blocks a semantic escalation with judge-unavailable cause when failMode is closed (default)', async () => {
    const args = baseArgs({ tool: 'write', paths: ['random/other.txt'], json: true });
    const result = await runCheck(args, deps(SEMANTIC_CLOSED_YAML));
    expect(result.exitCode).toBe(1);
    const doc = JSON.parse(result.stdout);
    const rec = doc.records.find((r: { commitmentId: string }) => r.commitmentId === 'stay-on-task');
    expect(rec).toMatchObject({ tier: 2, cause: 'judge-unavailable', judged: null });
    expect(rec.rationale).toMatch(/no judge configured/);
  });

  it('allows with a fail-open degradation warning and outcome allow-open when failMode is open', async () => {
    const args = baseArgs({ tool: 'write', paths: ['random/other.txt'], json: true });
    const result = await runCheck(args, deps(SEMANTIC_OPEN_YAML));
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.decision).toBe('allow');
    const rec = doc.records.find((r: { commitmentId: string }) => r.commitmentId === 'stay-on-task');
    expect(rec).toMatchObject({ outcome: 'allow-open', cause: 'judge-unavailable' });
    expect(doc.warnings.length).toBeGreaterThan(0);
  });

  it('returns exit 4 when the commitments file is unreadable', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls' });
    const result = await runCheck(args, {
      readCommitmentsFile: () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    expect(result.exitCode).toBe(4);
  });

  it('returns exit 4 on malformed YAML', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls' });
    const result = await runCheck(args, deps(MALFORMED_YAML));
    expect(result.exitCode).toBe(4);
  });

  it('returns exit 4 on a duplicate commitment id', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls' });
    const result = await runCheck(args, deps(DUPLICATE_ID_YAML));
    expect(result.exitCode).toBe(4);
  });

  it('returns exit 4 on an invalid command regex', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls' });
    const result = await runCheck(args, deps(BAD_REGEX_YAML));
    expect(result.exitCode).toBe(4);
  });

  it('--json output exitCode field equals the real process exit code, and pattern matches an independent evaluateTier1 call', async () => {
    const args = baseArgs({ tool: 'write', paths: ['config/prod/db.yaml'], json: true });
    const result = await runCheck(args, deps(EXAMPLE_YAML));
    const doc = JSON.parse(result.stdout);
    expect(doc.exitCode).toBe(result.exitCode);
    const set = loadCommitments(EXAMPLE_YAML);
    const action = buildAction({ tool: args.tool, paths: args.paths, ...(args.command !== undefined ? { command: args.command } : {}) });
    const t1 = evaluateTier1(set, action);
    const structuralRecords = doc.records.filter((r: { cause: string }) => r.cause === 'structural');
    expect(structuralRecords.map((r: { pattern: string }) => r.pattern)).toEqual(t1.hits.map((h) => h.matched));
  });

  it('--json --explain is byte-identical to --json alone', async () => {
    const args = baseArgs({ tool: 'bash', command: 'git push --force origin main', json: true });
    const jsonOnly = await runCheck(args, deps(EXAMPLE_YAML));
    const jsonExplain = await runCheck({ ...args, explain: true }, deps(EXAMPLE_YAML));
    expect(jsonExplain.stdout).toBe(jsonOnly.stdout);
  });

  it('orders tier-1 records before tier-2 records, matching evaluateTier1 order exactly (regression)', async () => {
    const args = baseArgs({ tool: 'write', paths: ['config.secret'], json: true });
    const result = await runCheck(args, deps(ORDERING_YAML));
    const doc = JSON.parse(result.stdout);
    const set = loadCommitments(ORDERING_YAML);
    const action = buildAction({ tool: args.tool, paths: args.paths });
    const t1 = evaluateTier1(set, action);
    expect(doc.records).toHaveLength(t1.hits.length + 1); // 2 structural + 1 semantic escalation
    for (let i = 0; i < t1.hits.length; i++) {
      expect(doc.records[i]).toMatchObject({
        commitmentId: t1.hits[i]!.commitmentId,
        tier: 1,
        cause: 'structural',
        pattern: t1.hits[i]!.matched,
      });
    }
    expect(doc.records[t1.hits.length]).toMatchObject({ commitmentId: 'stay-on-task', tier: 2, cause: 'judge-unavailable', pattern: null });
  });

  it('prints a stderr advisory (not an error) when both --path and --command are given for a shell tool', async () => {
    const args = baseArgs({ tool: 'bash', command: 'ls', paths: ['ignored.txt'] });
    const result = await runCheck(args, deps(EXAMPLE_YAML));
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.toLowerCase()).toContain('ignored');
  });
});
