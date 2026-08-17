import { describe, expect, it } from 'vitest';
import { CommitmentParseError, loadCommitments } from '../src/core/commitments.js';

const MINIMAL = `
version: 1
commitments:
  - id: no-prod-config
    statement: Never modify production configuration files.
    match:
      kinds: [fs-write]
      paths: ["config/prod/**", "**/*.prod.*"]
`;

describe('loadCommitments', () => {
  it('parses a minimal document and applies defaults', () => {
    const set = loadCommitments(MINIMAL);
    expect(set.version).toBe(1);
    expect(set.commitments).toHaveLength(1);
    const c = set.commitments[0]!;
    expect(c.id).toBe('no-prod-config');
    expect(c.statement).toMatch(/production configuration/);
    expect(c.severity).toBe('block'); // default
    expect(c.semantic).toBe(false); // default
    expect(set.defaults.failMode).toBe('closed'); // default
    expect(set.defaults.judgeBudgetPerStep).toBeGreaterThan(0);
  });

  it('honours explicit severity, semantic flag, and defaults block', () => {
    const set = loadCommitments(`
version: 1
defaults:
  failMode: open
  judgeBudgetPerStep: 3
commitments:
  - id: stay-on-task
    statement: Do not start work unrelated to the current task.
    severity: warn
    semantic: true
`);
    const c = set.commitments[0]!;
    expect(c.severity).toBe('warn');
    expect(c.semantic).toBe(true);
    expect(set.defaults.failMode).toBe('open');
    expect(set.defaults.judgeBudgetPerStep).toBe(3);
  });

  it('rejects a commitment without a statement', () => {
    expect(() =>
      loadCommitments(`
version: 1
commitments:
  - id: empty
`),
    ).toThrow(CommitmentParseError);
  });

  it('rejects duplicate commitment ids', () => {
    expect(() =>
      loadCommitments(`
version: 1
commitments:
  - id: twin
    statement: a
    semantic: true
  - id: twin
    statement: b
    semantic: true
`),
    ).toThrow(/duplicate/i);
  });

  it('rejects a non-semantic commitment with no match as unenforceable', () => {
    expect(() =>
      loadCommitments(`
version: 1
commitments:
  - id: dead
    statement: be good
`),
    ).toThrow(/semantic: true|never be enforced/);
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      loadCommitments(`
version: 99
commitments: []
`),
    ).toThrow(/version/i);
  });

  it('rejects an invalid command regex with a pointed error', () => {
    expect(() =>
      loadCommitments(`
version: 1
commitments:
  - id: bad-re
    statement: no force pushes
    match:
      kinds: [shell]
      commands: ["git push --force ("]
`),
    ).toThrow(/regex/i);
  });
});
