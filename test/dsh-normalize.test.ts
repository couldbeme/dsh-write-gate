import { describe, expect, it } from 'vitest';
import { normalizeExec } from '../src/dsh/normalize.js';

describe('normalizeExec', () => {
  it('maps bash calls to shell actions carrying the command', () => {
    const a = normalizeExec({ name: 'bash', arguments: { command: 'git push --force origin main' } });
    expect(a).toMatchObject({ kind: 'shell', tool: 'bash', command: 'git push --force origin main' });
  });

  it('maps write/edit calls to fs-write actions carrying paths', () => {
    expect(normalizeExec({ name: 'write', arguments: { path: 'config/prod/db.yaml', content: 'x' } })).toMatchObject({
      kind: 'fs-write',
      paths: ['config/prod/db.yaml'],
    });
    expect(normalizeExec({ name: 'edit', arguments: { file_path: 'src/a.ts' } })).toMatchObject({
      kind: 'fs-write',
      paths: ['src/a.ts'],
    });
  });

  it('maps read-family tools to fs-read and web tools to net', () => {
    expect(normalizeExec({ name: 'read', arguments: { path: 'a.ts' } }).kind).toBe('fs-read');
    expect(normalizeExec({ name: 'web-fetch', arguments: { url: 'https://x' } }).kind).toBe('net');
  });

  it('degrades unknown tools to kind other with a full summary, never silently blind', () => {
    const a = normalizeExec({ name: 'mystery', arguments: { foo: 1 } });
    expect(a.kind).toBe('other');
    expect(a.summary).toContain('mystery');
    expect(a.summary).toContain('foo');
  });

  it('tolerates non-object arguments', () => {
    const a = normalizeExec({ name: 'bash', arguments: 'raw-string' });
    expect(a.kind).toBe('shell');
    expect(a.command).toContain('raw-string');
  });
});
