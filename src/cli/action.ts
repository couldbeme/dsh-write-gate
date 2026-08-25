import type { NormalizedAction } from '../core/types.js';
import type { ExecLike } from '../dsh/normalize.js';
import { normalizeExec } from '../dsh/normalize.js';

export interface BuildActionInput {
  tool: string;
  paths: string[];
  command?: string;
}

/**
 * The critical seam between CLI flags and the engine-agnostic action model.
 * NEVER set `args.paths = []` or a singular `path` key: digest.ts canonicalize
 * strips `undefined` but not empty arrays, so `paths: []` would hash
 * differently from an omitted key and diverge the judge memoization cache key
 * from the real dsh plugin path.
 */
export function buildExecLike(input: BuildActionInput): ExecLike {
  const args: Record<string, unknown> = {};
  if (input.paths.length > 0) args.paths = input.paths; // PLURAL array key only
  if (input.command !== undefined) args.command = input.command;
  return { name: input.tool, arguments: args };
}

export function buildAction(input: BuildActionInput): NormalizedAction {
  return normalizeExec(buildExecLike(input));
}
