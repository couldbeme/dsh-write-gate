import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCommitments } from '../src/core/commitments.js';
import { evaluateTier1 } from '../src/core/tier1.js';

describe('commitments.example.yaml', () => {
  const set = loadCommitments(readFileSync(join(import.meta.dirname, '..', 'commitments.example.yaml'), 'utf8'));

  it('parses (a broken shipped example is a broken front door)', () => {
    expect(set.commitments.length).toBeGreaterThanOrEqual(5);
    expect(set.defaults.failMode).toBe('closed');
  });

  it('catches the canonical structural violations it documents', () => {
    expect(
      evaluateTier1(set, { kind: 'shell', tool: 'bash', command: 'git push -f origin HEAD:main', summary: 'force push' })
        .decision,
    ).toBe('block');
    expect(
      evaluateTier1(set, { kind: 'shell', tool: 'bash', command: 'psql -c "DROP TABLE users"', summary: 'drop table' })
        .decision,
    ).toBe('block');
    expect(
      evaluateTier1(set, { kind: 'fs-write', tool: 'fs/write', paths: ['api/.env'], summary: 'write .env' }).decision,
    ).toBe('block');
    // command matching is case-insensitive by design
    expect(
      evaluateTier1(set, { kind: 'shell', tool: 'bash', command: 'delete from users where 1=1', summary: 'sql' })
        .decision,
    ).toBe('block');
  });

  it('stays quiet on the canonical clean actions', () => {
    expect(
      evaluateTier1(set, { kind: 'shell', tool: 'bash', command: 'git push origin main', summary: 'normal push' })
        .decision,
    ).toBe('allow');
    expect(
      evaluateTier1(set, { kind: 'shell', tool: 'bash', command: 'git status', summary: 'status' }).decision,
    ).toBe('allow');
  });
});
