import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression coverage for scripts/check-claims.mjs itself: the README shipped
// a stale "kappa 0.80" for weeks before this gate existed (see the script's
// own header comment). These tests prove the gate still passes the real repo
// and still fails a copy carrying the stale number, run as a real spawned
// process (the gate's own contract with CI).
const REPO_ROOT = join(import.meta.dirname, '..');
const CHECK_CLAIMS = join(REPO_ROOT, 'scripts', 'check-claims.mjs');

function runClaimsGate(root: string) {
  return spawnSync('node', [CHECK_CLAIMS, root], { encoding: 'utf8' });
}

describe('scripts/check-claims.mjs', () => {
  it('passes against the real repo root, exit 0', () => {
    const result = runClaimsGate(REPO_ROOT);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('fails, exit 1, with the failure message on stderr, when a copy carries a stale "kappa 0.80"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-claims-'));
    mkdirSync(join(dir, 'docs'));

    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    writeFileSync(join(dir, 'README.md'), `${readme}\n\nkappa 0.80\n`);
    copyFileSync(join(REPO_ROOT, 'SECURITY.md'), join(dir, 'SECURITY.md'));
    for (const f of readdirSync(join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
      copyFileSync(join(REPO_ROOT, 'docs', f), join(dir, 'docs', f));
    }

    const result = runClaimsGate(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('claims gate FAILED');
    expect(result.stderr).toMatch(/kappa 0\.80/);
  });
});
