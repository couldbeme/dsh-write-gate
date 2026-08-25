// Claims gate: published docs must carry the canonical benchmark numbers and
// must not resurrect stale or withdrawn ones. The README shipped "kappa 0.80"
// for weeks while the settled number was 0.95, and the scaled ODCV result
// (0.64 on 548) appeared nowhere; a written rule did not prevent that — only
// an enforced check does. Runs in CI after the test suite.
// Usage: node scripts/check-claims.mjs [repo-root]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const failures = [];

const readme = read('README.md');
for (const canonical of ['0.95', '0.64', '548']) {
  if (!readme.includes(canonical)) {
    failures.push(`README.md must state the canonical holdline numbers (missing "${canonical}").`);
  }
}

const mdFiles = [
  ...readdirSync(root).filter((f) => f.endsWith('.md')),
  ...readdirSync(join(root, 'docs')).map((f) => join('docs', f)).filter((f) => f.endsWith('.md')),
];
for (const f of mdFiles) {
  const text = read(f);
  if (/kappa\s+0\.80/.test(text)) {
    failures.push(`${f} cites kappa 0.80 — stale pre-final number; the authored-corpus result is 0.95.`);
  }
  if (/0\.82/.test(text)) {
    failures.push(`${f} mentions 0.82 — withdrawn small-slice number; the public ODCV claim is 0.64.`);
  }
}

if (failures.length) {
  console.error('claims gate FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`claims gate OK (${mdFiles.length} markdown files checked)`);
