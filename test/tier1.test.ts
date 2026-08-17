import { describe, expect, it } from 'vitest';
import { loadCommitments } from '../src/core/commitments.js';
import { evaluateTier1 } from '../src/core/tier1.js';
import type { NormalizedAction } from '../src/core/types.js';

const SET = loadCommitments(`
version: 1
commitments:
  - id: no-prod-config
    statement: Never modify production configuration files.
    match:
      kinds: [fs-write]
      paths: ["config/prod/**", "**/*.prod.*"]
  - id: no-force-push
    statement: Never force-push.
    severity: warn
    match:
      kinds: [shell]
      commands: ["git\\\\s+push\\\\s+.*--force"]
  - id: stay-in-workspace
    statement: Only write inside the workspace.
    semantic: true
    match:
      kinds: [fs-write]
`);

const write = (path: string): NormalizedAction => ({
  kind: 'fs-write',
  tool: 'fs/write',
  paths: [path],
  summary: `write ${path}`,
});

const shell = (command: string): NormalizedAction => ({
  kind: 'shell',
  tool: 'bash',
  command,
  summary: command,
});

describe('evaluateTier1', () => {
  it('blocks a path-glob match on an fs-write action', () => {
    const r = evaluateTier1(SET, write('config/prod/db.yaml'));
    expect(r.decision).toBe('block');
    expect(r.hits.map((h) => h.commitmentId)).toContain('no-prod-config');
  });

  it('matches nested prod-suffixed files via the second glob', () => {
    const r = evaluateTier1(SET, write('services/api/settings.prod.json'));
    expect(r.decision).toBe('block');
  });

  it('warns on a command regex match when severity is warn', () => {
    const r = evaluateTier1(SET, shell('git push origin main --force'));
    expect(r.decision).toBe('warn');
    expect(r.hits.map((h) => h.commitmentId)).toContain('no-force-push');
  });

  it('does not apply a shell-scoped commitment to an fs-write action', () => {
    const r = evaluateTier1(SET, write('git push --force')); // pathological path, wrong kind
    expect(r.hits.map((h) => h.commitmentId)).not.toContain('no-force-push');
  });

  it('escalates kind-compatible semantic commitments when structure is inconclusive', () => {
    const r = evaluateTier1(SET, write('src/index.ts'));
    expect(r.decision).toBe('allow');
    expect(r.escalate.map((c) => c.id)).toEqual(['stay-in-workspace']);
  });

  it('does not escalate semantic commitments of an incompatible kind', () => {
    const r = evaluateTier1(SET, shell('ls -la'));
    expect(r.decision).toBe('allow');
    expect(r.escalate).toHaveLength(0);
  });

  it('block outranks warn when both hit', () => {
    const both = loadCommitments(`
version: 1
commitments:
  - id: warn-all-writes
    statement: warn on any write
    severity: warn
    match: { kinds: [fs-write] }
  - id: block-secrets
    statement: never touch .env
    match: { kinds: [fs-write], paths: ["**/.env"] }
`);
    const r = evaluateTier1(both, write('api/.env'));
    expect(r.decision).toBe('block');
    expect(r.hits).toHaveLength(2);
  });
});
