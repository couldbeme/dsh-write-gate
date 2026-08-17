import type { NormalizedAction, NormalizedKind } from '../core/types.js';

/** Structural view of a dsh ToolExecution — only what normalization reads. */
export interface ExecLike {
  readonly name: string;
  readonly arguments: unknown;
}

const SHELL_NAMES = new Set(['bash', 'pwsh', 'shell', 'terminal']);
const FS_WRITE_NAMES = new Set(['write', 'edit', 'create', 'mkdir', 'move', 'copy', 'rm', 'delete', 'patch']);
const FS_READ_NAMES = new Set(['read', 'ls', 'glob', 'grep', 'search', 'find']);
const NET_PATTERN = /web|fetch|http|browse|download/i;

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function stringField(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pathFields(args: Record<string, unknown>): string[] {
  const single = stringField(args, ['path', 'file_path', 'filePath', 'file', 'target']);
  const paths = single ? [single] : [];
  for (const key of ['paths', 'files', 'targets']) {
    const value = args[key];
    if (Array.isArray(value)) paths.push(...value.filter((v): v is string => typeof v === 'string'));
  }
  return paths;
}

/**
 * Map a dsh tool call onto the engine-agnostic action model. The tool-name
 * table is a v0 heuristic over dsh's in-tree tools (`read`/`write`/`edit`
 * from tool-fs, `bash` from tool-bash — the names spill-policy also keys on);
 * unrecognized tools degrade to kind `other` and still carry a full summary,
 * so scope-filtered commitments stay conservative rather than silently blind.
 */
export function normalizeExec(exec: ExecLike): NormalizedAction {
  const name = exec.name.toLowerCase();
  const args =
    exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? (exec.arguments as Record<string, unknown>)
      : {};

  if (SHELL_NAMES.has(name) || /terminal/.test(name)) {
    const command = stringField(args, ['command', 'cmd', 'script', 'input']) ?? JSON.stringify(exec.arguments);
    return { kind: 'shell', tool: exec.name, command, summary: truncate(command, 200) };
  }

  const kind: NormalizedKind = FS_WRITE_NAMES.has(name)
    ? 'fs-write'
    : FS_READ_NAMES.has(name)
      ? 'fs-read'
      : NET_PATTERN.test(name)
        ? 'net'
        : 'other';

  const paths = pathFields(args);
  const summary =
    paths.length > 0
      ? truncate(`${exec.name} ${paths.join(', ')}`, 200)
      : truncate(`${exec.name} ${JSON.stringify(exec.arguments) ?? ''}`, 200);

  return { kind, tool: exec.name, ...(paths.length > 0 ? { paths } : {}), summary };
}
