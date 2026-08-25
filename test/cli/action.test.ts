import { describe, expect, it } from 'vitest';
import { digestOf } from '../../src/core/digest.js';
import type { NormalizedAction } from '../../src/core/types.js';
import { buildAction, buildExecLike } from '../../src/cli/action.js';
import { normalizeExec } from '../../src/dsh/normalize.js';

const digestInput = (a: NormalizedAction): unknown => ({
  tool: a.tool,
  kind: a.kind,
  paths: a.paths,
  command: a.command,
  summary: a.summary,
});

describe('buildExecLike', () => {
  it('puts a single --path into the plural arguments.paths array, never a singular path key', () => {
    const exec = buildExecLike({ tool: 'write', paths: ['src/a.ts'] });
    expect(exec.arguments).toMatchObject({ paths: ['src/a.ts'] });
    expect(Object.hasOwn(exec.arguments as object, 'path')).toBe(false);
  });

  it('omits the paths key entirely when zero paths are given', () => {
    const exec = buildExecLike({ tool: 'bash', paths: [], command: 'ls' });
    expect(Object.hasOwn(exec.arguments as object, 'paths')).toBe(false);
  });

  it('collects two --path values in order', () => {
    const exec = buildExecLike({ tool: 'write', paths: ['a.ts', 'b.ts'] });
    expect(exec.arguments).toMatchObject({ paths: ['a.ts', 'b.ts'] });
  });
});

describe('buildAction', () => {
  it('maps a bash tool with a command to kind shell, carrying the command verbatim', () => {
    const action = buildAction({ tool: 'bash', paths: [], command: 'git push --force origin main' });
    expect(action).toMatchObject({ kind: 'shell', command: 'git push --force origin main' });
  });

  it('maps a write tool with a path to kind fs-write', () => {
    const action = buildAction({ tool: 'write', paths: ['config/prod/db.yaml'] });
    expect(action.kind).toBe('fs-write');
    expect(action.paths).toEqual(['config/prod/db.yaml']);
  });

  it('maps a read tool with a path to kind fs-read', () => {
    const action = buildAction({ tool: 'read', paths: ['src/a.ts'] });
    expect(action.kind).toBe('fs-read');
  });

  it('degrades an unknown tool to kind other without throwing', () => {
    expect(() => buildAction({ tool: 'mystery-tool', paths: ['x'] })).not.toThrow();
    const action = buildAction({ tool: 'mystery-tool', paths: ['x'] });
    expect(action.kind).toBe('other');
  });

  it('drops the paths key for a shell tool given a --path (paths are ignored for shell)', () => {
    const action = buildAction({ tool: 'bash', paths: ['ignored.txt'] });
    expect(action.kind).toBe('shell');
    expect(Object.hasOwn(action, 'paths')).toBe(false);
  });

  it('produces a digest identical to a hand-built ExecLike run through normalizeExec (parity)', () => {
    const viaBuild = buildAction({ tool: 'bash', paths: [], command: 'git push --force origin main' });
    const viaHand = normalizeExec({ name: 'bash', arguments: { command: 'git push --force origin main' } });
    expect(digestOf(digestInput(viaBuild))).toBe(digestOf(digestInput(viaHand)));
  });
});
