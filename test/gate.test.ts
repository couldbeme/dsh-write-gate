import { describe, expect, it, vi } from 'vitest';
import { loadCommitments } from '../src/core/commitments.js';
import { createGate } from '../src/core/gate.js';
import type { ContradictionRecord, Judge, NormalizedAction } from '../src/core/types.js';

const SET_YAML = `
version: 1
commitments:
  - id: no-prod-config
    statement: Never modify production configuration files.
    match:
      kinds: [fs-write]
      paths: ["config/prod/**"]
  - id: stay-on-task
    statement: Do not modify files unrelated to the assigned task.
    semantic: true
    match:
      kinds: [fs-write]
`;

const write = (path: string): NormalizedAction => ({
  kind: 'fs-write',
  tool: 'fs/write',
  paths: [path],
  summary: `write ${path}`,
});

const violationJudge: Judge = async () => ({
  violation: true,
  confidence: 0.9,
  rationale: 'unrelated to task',
});

const cleanJudge: Judge = async () => ({
  violation: false,
  confidence: 0.8,
  rationale: 'in scope',
});

describe('createGate', () => {
  it('short-circuits on a tier-1 block without consulting the judge', async () => {
    const judge = vi.fn(cleanJudge);
    const gate = createGate(loadCommitments(SET_YAML), { judge });
    const result = await gate.check(write('config/prod/db.yaml'));
    expect(result.decision).toBe('block');
    expect(judge).not.toHaveBeenCalled();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ commitmentId: 'no-prod-config', tier: 1, outcome: 'block' });
  });

  it('escalates to the judge and blocks on a tier-2 violation verdict', async () => {
    const judge = vi.fn(violationJudge);
    const gate = createGate(loadCommitments(SET_YAML), { judge });
    const result = await gate.check(write('random/other.txt'));
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]![0]).toMatchObject({
      statement: 'Do not modify files unrelated to the assigned task.',
    });
    expect(result.decision).toBe('block');
    expect(result.records[0]).toMatchObject({ commitmentId: 'stay-on-task', tier: 2, outcome: 'block' });
    expect(result.records[0]!.judged).toMatchObject({ violation: true });
  });

  it('allows when the judge finds no violation, with no contradiction records', async () => {
    const gate = createGate(loadCommitments(SET_YAML), { judge: cleanJudge });
    const result = await gate.check(write('src/index.ts'));
    expect(result.decision).toBe('allow');
    expect(result.records).toHaveLength(0);
  });

  it('fails closed when the judge throws and failMode is closed (default)', async () => {
    const gate = createGate(loadCommitments(SET_YAML), {
      judge: async () => {
        throw new Error('provider down');
      },
    });
    const result = await gate.check(write('src/index.ts'));
    expect(result.decision).toBe('block');
    expect(result.records[0]).toMatchObject({ tier: 2, outcome: 'block' });
    expect(result.records[0]!.rationale).toMatch(/unavailable/i);
  });

  it('fails open with an allow-open record when failMode is open', async () => {
    const openSet = loadCommitments(SET_YAML.replace('version: 1', 'version: 1\ndefaults: { failMode: open }'));
    const gate = createGate(openSet, {
      judge: async () => {
        throw new Error('provider down');
      },
    });
    const result = await gate.check(write('src/index.ts'));
    expect(result.decision).toBe('allow');
    expect(result.records[0]).toMatchObject({ outcome: 'allow-open' });
  });

  it('treats a judge slower than judgeTimeoutMs as unavailable', async () => {
    const slow: Judge = () => new Promise((resolve) => setTimeout(() => resolve({ violation: false, confidence: 1, rationale: 'late' }), 80));
    const gate = createGate(loadCommitments(SET_YAML), { judge: slow, judgeTimeoutMs: 10 });
    const result = await gate.check(write('src/index.ts'));
    expect(result.decision).toBe('block');
    expect(result.records[0]!.rationale).toMatch(/unavailable/i);
  });

  it('enforces the per-step judge budget across checks and resets on newStep', async () => {
    const judge = vi.fn(cleanJudge);
    const budgetSet = loadCommitments(SET_YAML.replace('version: 1', 'version: 1\ndefaults: { judgeBudgetPerStep: 1 }'));
    const gate = createGate(budgetSet, { judge });
    await gate.check(write('a.ts'));
    const second = await gate.check(write('b.ts'));
    expect(judge).toHaveBeenCalledTimes(1); // budget spent on first check
    expect(second.decision).toBe('block'); // fail-closed on budget exhaustion
    expect(second.records[0]!.rationale).toMatch(/budget/i);
    gate.newStep();
    const third = await gate.check(write('c.ts'));
    expect(judge).toHaveBeenCalledTimes(2); // budget reset
    expect(third.decision).toBe('allow');
  });

  it('memoizes identical (commitment, action) judgements', async () => {
    const judge = vi.fn(cleanJudge);
    const gate = createGate(loadCommitments(SET_YAML), { judge });
    await gate.check(write('same.ts'));
    gate.newStep();
    await gate.check(write('same.ts'));
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('emits every record through the injected sink as it is produced', async () => {
    const seen: ContradictionRecord[] = [];
    const gate = createGate(loadCommitments(SET_YAML), {
      judge: violationJudge,
      emit: (r) => seen.push(r),
      now: () => '2026-08-17T12:00:00.000Z',
    });
    const result = await gate.check(write('config/prod/db.yaml'));
    expect(seen).toEqual(result.records);
    expect(seen[0]!.at).toBe('2026-08-17T12:00:00.000Z');
  });
});
