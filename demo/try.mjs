// Interactive smoke test — throw any action at the gate and see what happens.
//   node demo/try.mjs bash "git push --force origin main"
//   node demo/try.mjs write config/prod/db.yaml
//   node demo/try.mjs bash "git status"
// Rules come from demo/COMMITMENTS.yaml — edit it, add your own, re-run.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as WriteGate from '../dist/dsh/index.js';

const [tool, ...rest] = process.argv.slice(2);
if (!tool || rest.length === 0) {
  console.log('usage: node demo/try.mjs bash "<command>"   |   node demo/try.mjs write <path>');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
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
await ctx.plugin(WriteGate, {
  commitmentsFile: join(here, 'COMMITMENTS.yaml'),
  contradictionsLog: join(mkdtempSync(join(tmpdir(), 'write-gate-try-')), 'contradictions.jsonl'),
});
ctx.on('write-gate/contradiction', (r) => {
  console.log(`  record: tier ${r.tier} · ${r.commitmentId} → ${r.outcome} · ${r.rationale}`);
});

const args = tool === 'write' ? { path: rest[0], content: '(smoke test)' } : { command: rest.join(' ') };
const result = await ctx.tools.execute({
  callId: 'try-1',
  name: tool,
  arguments: args,
  signal: new AbortController().signal,
});
console.log(result.isError ? `BLOCKED · ${result.error.message}` : `allowed · ${result.content[0]?.text ?? ''}`);
