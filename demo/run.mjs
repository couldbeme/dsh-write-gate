// write-gate demo — deterministic, no model required. Run: pnpm demo
// Boots a real dsh Context + ToolRuntime, mounts the gate, and walks one
// drift story: in-scope work passes, prod-config edit and force-push are
// blocked, and a rogue allow-everything listener fails to bypass the
// monotonic guard. Ends by printing the contradictions log.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as WriteGate from '../dist/dsh/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const line = '='.repeat(64);

const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);

ctx.tools.register(
  defineContentToolFixture({
    name: 'bash',
    description: 'run a command',
    parameters: { command: { type: 'string', required: true } },
    execute: async ({ command }) => [{ type: 'text', text: `$ ${command} … ok` }],
  }),
);
ctx.tools.register(
  defineContentToolFixture({
    name: 'write',
    description: 'write a file',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    execute: async ({ path }) => [{ type: 'text', text: `wrote ${path}` }],
  }),
);

const logFile = join(mkdtempSync(join(tmpdir(), 'write-gate-demo-')), 'contradictions.jsonl');
await ctx.plugin(WriteGate, { commitmentsFile: join(here, 'COMMITMENTS.yaml'), contradictionsLog: logFile });

ctx.on('write-gate/contradiction', (r) => {
  console.log(`     [contradictions log] tier ${r.tier} · ${r.commitmentId} → ${r.outcome}: ${r.rationale}`);
});

let calls = 0;
async function act(title, name, args) {
  console.log(`\n▶ ${title}`);
  const result = await ctx.tools.execute({
    callId: `demo-${(calls += 1)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
  if (result.isError) console.log(`   BLOCKED · ${result.error.message}`);
  else console.log(`   allowed · ${result.content[0]?.text ?? ''}`);
}

console.log(line);
console.log('write-gate demo — the agent was told: "tune the deploy config".');
console.log('Commitments: no prod-config edits, no force-push, stay on task (semantic, warn).');
console.log('The semantic judge is NOT configured here: warn-severity escalations fail closed to a recorded warn.');
console.log(line);

await act('agent inspects the repo', 'bash', { command: 'git status' });
await act('agent edits the deploy script (in scope)', 'write', { path: 'src/deploy.ts', content: '...' });
await act('agent drifts: edits PROD config directly', 'write', { path: 'config/prod/db.yaml', content: 'pool: 100' });
await act('agent tries to force-push the "fix"', 'bash', { command: 'git push --force origin main' });

console.log('\n▶ a rogue plugin mounts and short-circuits the waterfall with allow-everything');
ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
await act('force-push again, now behind the rogue allow', 'bash', { command: 'git push --force origin main' });

console.log(`\n${line}`);
console.log(`contradictions log · ${logFile}`);
for (const entry of readFileSync(logFile, 'utf8').trim().split('\n')) {
  const r = JSON.parse(entry);
  console.log(`  tier ${r.tier} · ${r.commitmentId} · ${r.outcome} · ${r.action.summary}`);
}
console.log(line);
console.log('Every block above is attributable: commitment id, tier, rationale, action digest.');
