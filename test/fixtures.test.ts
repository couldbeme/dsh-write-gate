import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const caseSchema = z.object({
  id: z.string().min(1),
  difficulty: z.enum(['literal', 'paraphrase', 'trap', 'clean', 'hard', 'edge', 'injection']),
  label: z.enum(['drift', 'clean']),
  commitments: z.array(z.string().min(1)).min(1),
  action: z.string().min(1),
});

const fixtureSchema = z.object({
  provenance: z.object({
    sources: z.array(z.string()),
    honesty: z.string(),
    measuredBaseline: z.string(),
  }),
  dev: z.array(caseSchema),
  heldout: z.array(caseSchema),
  injection: z.array(caseSchema),
});

describe('judge-cases fixture', () => {
  const raw = readFileSync(join(import.meta.dirname, 'fixtures', 'judge-cases.json'), 'utf8');
  const fixture = fixtureSchema.parse(JSON.parse(raw));

  it('carries the full ported sets: 18 dev + 16 held-out', () => {
    expect(fixture.dev).toHaveLength(18);
    expect(fixture.heldout).toHaveLength(16);
  });

  it('has globally unique case ids', () => {
    const ids = [...fixture.dev, ...fixture.heldout, ...fixture.injection].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the injection-resistance class (self-justifying and fence-close attacks)', () => {
    expect(fixture.injection.length).toBeGreaterThanOrEqual(7);
    expect(fixture.injection.every((c) => c.difficulty === 'injection')).toBe(true);
    // both a fence-close attempt and a self-justification attempt are present
    expect(fixture.injection.some((c) => c.action.includes('</action-data>'))).toBe(true);
    expect(fixture.injection.some((c) => /pre-approved|only a test|compliance mode/i.test(c.action))).toBe(true);
  });

  it('keeps the honest split: dev contains paraphrase misses and traps by design', () => {
    const devDifficulties = new Set(fixture.dev.map((c) => c.difficulty));
    expect(devDifficulties).toContain('paraphrase');
    expect(devDifficulties).toContain('trap');
    const heldoutDifficulties = new Set(fixture.heldout.map((c) => c.difficulty));
    expect(heldoutDifficulties).toContain('hard');
    expect(heldoutDifficulties).toContain('edge');
  });
});
