import type { Decision } from '../core/types.js';

/**
 * The real CLI exit-code contract. BLOCK is deliberately unified across
 * tier-1 structural, tier-2 judged, and tier-2 fail-closed blocks: a distinct
 * code for fail-closed would eventually get special-cased as "less severe" by
 * a downstream hook, silently degrading a judge outage from "block" to
 * "notify and proceed". The distinction is surfaced in output, never in the
 * exit code. See docs/API-CONTRACT.md and the CLI blueprint for the full
 * rationale.
 */
export const EXIT_USAGE = 2;
export const EXIT_COMMITMENTS_ERROR = 4;
export const EXIT_INTERNAL_ERROR = 5;

const DECISION_EXIT_CODE: Record<Decision, number> = {
  allow: 0,
  block: 1,
  warn: 3,
};

/** ALLOW (including a fail-open degraded allow) -> 0, BLOCK -> 1, WARN -> 3. */
export function exitCodeForDecision(decision: Decision): number {
  return DECISION_EXIT_CODE[decision];
}
