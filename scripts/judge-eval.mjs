// Live judge evaluation over the 34 shipped fixture cases.
// Usage:  node scripts/judge-eval.mjs [--url http://127.0.0.1:1234] [--model qwen3-vl-8b]
// Talks to any OpenAI-compatible /v1/chat/completions endpoint (LM Studio default).
// Reports per-set accuracy, abstains, and failures; writes JSONL results next to itself.
// Baseline to compare against: 18/18 dev + 16/16 held-out, 100% precision, 0 abstains
// (local qwen3-vl-8b; see test/fixtures/judge-cases.json provenance).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmJudge } from '../dist/core/judge-llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const baseUrl = flag('url', 'http://127.0.0.1:1234');
const model = flag('model', 'qwen3-vl-8b');

const fixture = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'judge-cases.json'), 'utf8'));

const complete = async (prompt, signal) => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`judge endpoint ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('judge endpoint returned no message content');
  return content;
};

const judge = createLlmJudge(complete);

async function runSet(setName, cases) {
  const rows = [];
  let correct = 0;
  let abstains = 0;
  let errors = 0;
  for (const c of cases) {
    let predictedDrift = false;
    let abstained = false;
    let error;
    try {
      for (const statement of c.commitments) {
        const verdict = await judge({
          statement,
          action: { kind: 'other', tool: 'transcript', summary: c.action },
        });
        if (verdict.abstained) abstained = true;
        if (verdict.violation) predictedDrift = true;
      }
    } catch (cause) {
      error = String(cause?.message ?? cause);
    }
    const expected = c.label === 'drift';
    const ok = error === undefined && predictedDrift === expected;
    if (ok) correct += 1;
    if (abstained) abstains += 1;
    if (error) errors += 1;
    rows.push({ set: setName, id: c.id, difficulty: c.difficulty, expected: c.label, predictedDrift, abstained, ok, error });
    console.log(`${ok ? '  ok ' : error ? ' ERR ' : 'MISS '}[${setName}] ${c.id} (${c.difficulty}) expected=${c.label} predicted=${predictedDrift ? 'drift' : 'clean'}${abstained ? ' ABSTAIN' : ''}${error ? ` · ${error}` : ''}`);
  }
  console.log(`-- ${setName}: ${correct}/${cases.length} correct, ${abstains} abstains, ${errors} endpoint errors`);
  return rows;
}

console.log(`judge-eval · endpoint ${baseUrl} · model ${model}`);
const results = [...(await runSet('dev', fixture.dev)), ...(await runSet('heldout', fixture.heldout))];
const out = join(here, `judge-eval-results-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`results → ${out}`);
console.log('Honesty rails: hand-authored cases; the signals are paraphrase misses, trap false-positives, and held-out generalization, not the headline %.');
