import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spawns the real, built binary — proves the shebang, the chmod exec bit,
// and that nothing leaks onto stdout alongside --json. `pnpm test:e2e`
// builds first; this file is excluded from `pnpm test` (see vitest.config.ts)
// because it depends on dist/ existing.
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const COMMITMENTS = fileURLToPath(new URL('../../commitments.example.yaml', import.meta.url));

function run(args: string[]) {
  return spawnSync(CLI, args, { encoding: 'utf8' });
}

describe('dsh-write-gate check (e2e, real spawned binary)', () => {
  it('executes directly as ./dist/cli/index.js, proving the shebang and the exec bit', () => {
    const result = run(['check', '--commitments', COMMITMENTS, '--tool', 'bash', '--command', 'ls -la']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('blocks a force-push through the real process boundary', () => {
    const result = run([
      'check',
      '--commitments',
      COMMITMENTS,
      '--tool',
      'bash',
      '--command',
      'git push --force origin main',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('BLOCK');
  });

  it('allows a benign command through the real process boundary, stdout exactly ALLOW\\n', () => {
    const result = run(['check', '--commitments', COMMITMENTS, '--tool', 'bash', '--command', 'ls -la']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ALLOW\n');
  });

  it('emits only a parseable JSON document on stdout with --json, nothing else leaking onto stdout', () => {
    const result = run([
      'check',
      '--commitments',
      COMMITMENTS,
      '--tool',
      'write',
      '--path',
      'config/prod/db.yaml',
      '--json',
    ]);
    expect(result.status).toBe(1);
    const doc = JSON.parse(result.stdout);
    expect(doc.decision).toBe('block');
    expect(doc.exitCode).toBe(1);
  });
});
