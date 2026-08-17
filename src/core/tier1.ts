import type { Commitment, CommitmentSet, Decision, Hit, NormalizedAction, Tier1Result } from './types.js';

function applies(c: Commitment, action: NormalizedAction): boolean {
  if (c.match?.kinds && !c.match.kinds.includes(action.kind)) return false;
  if (c.match?.tools && !c.match.tools.includes(action.tool)) return false;
  return true;
}

/**
 * kinds/tools are scope FILTERS; paths/commands are structural EVIDENCE.
 * A commitment fires structurally only on evidence. A semantic commitment
 * that is in scope but has no firing evidence escalates to tier 2.
 */
function structuralHit(c: Commitment, action: NormalizedAction): Hit | undefined {
  for (let i = 0; i < c.compiled.paths.length; i++) {
    const matcher = c.compiled.paths[i]!;
    for (const path of action.paths ?? []) {
      if (matcher(path.replaceAll('\\', '/'))) {
        return { commitmentId: c.id, severity: c.severity, matched: c.match?.paths?.[i] ?? 'path' };
      }
    }
  }
  if (action.command !== undefined) {
    for (let i = 0; i < c.compiled.commands.length; i++) {
      if (c.compiled.commands[i]!.test(action.command)) {
        return { commitmentId: c.id, severity: c.severity, matched: c.match?.commands?.[i] ?? 'command' };
      }
    }
  }
  return undefined;
}

export function evaluateTier1(set: CommitmentSet, action: NormalizedAction): Tier1Result {
  const hits: Hit[] = [];
  const escalate: Commitment[] = [];

  for (const c of set.commitments) {
    if (!applies(c, action)) continue;
    const hasEvidence = c.compiled.paths.length > 0 || c.compiled.commands.length > 0;
    if (!hasEvidence) {
      // Filter-only commitment: for non-semantic ones the scope IS the trigger;
      // semantic ones escalate to the judge instead.
      if (c.semantic) escalate.push(c);
      else hits.push({ commitmentId: c.id, severity: c.severity, matched: 'scope' });
      continue;
    }
    const hit = structuralHit(c, action);
    if (hit) {
      hits.push(hit);
    } else if (c.semantic) {
      escalate.push(c);
    }
  }

  let decision: Decision = 'allow';
  if (hits.some((h) => h.severity === 'block')) decision = 'block';
  else if (hits.some((h) => h.severity === 'warn')) decision = 'warn';

  return { decision, hits, escalate };
}
