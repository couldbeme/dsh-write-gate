// Interactive smoke test — throw any action at the gate and see what happens.
//   node demo/try.mjs bash "git push --force origin main"        (tier 1 blocks)
//   node demo/try.mjs bash "delete all user records older than 30 days"   (tier 2 judges)
//   node demo/try.mjs bash "delete the temporary cache files"    (tier 2 allows)
//   node demo/try.mjs write config/prod/db.yaml
// Rules come from demo/COMMITMENTS.yaml — edit it, add your own, re-run.
// If LM Studio is reachable (http://127.0.0.1:1234), the semantic tier runs
// LIVE through dsh's real LLM seam; otherwise escalations follow failMode.
// Flags: --no-judge, --judge-model <id>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import * as WriteGate from '../dist/dsh/index.js';

const argv = process.argv.slice(2);
const noJudge = argv.includes('--no-judge');
const modelFlag = argv.indexOf('--judge-model');
const judgeModel = modelFlag !== -1 ? argv[modelFlag + 1] : 'qwen/qwen3-vl-8b';
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--judge-model');
const [tool, ...rest] = positional;
if (!tool || rest.length === 0) {
  console.log('usage: node demo/try.mjs [--no-judge] bash "<command>"   |   ... write <path>');
  process.exit(1);
}

const LMS = 'http://127.0.0.1:1234';
async function lmsUp() {
  try {
    const res = await fetch(`${LMS}/v1/models`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Minimal live adapter: forwards one prompt to LM Studio, yields real chunks. */
class LmsJudgeAdapter extends LlmAdapter {
  async *stream(options) {
    const prompt = options.messages
      .flatMap((m) => m.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const res = await fetch(`${LMS}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens ?? 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content ?? '';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LlmRuntime);

const judgeLive = !noJudge && (await lmsUp());
if (judgeLive) ctx.llm.registerAdapter(['lmstudio'], new LmsJudgeAdapter());
console.log(
  judgeLive
    ? `tier-2 judge: LIVE via LM Studio (${judgeModel}) through dsh's real llm seam`
    : 'tier-2 judge: off — semantic escalations follow failMode',
);

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
  commitmentsFile: join(here, 'COMMITMENTS.live.yaml'),
  contradictionsLog: join(mkdtempSync(join(tmpdir(), 'write-gate-try-')), 'contradictions.jsonl'),
  ...(judgeLive ? { judge: { provider: 'lmstudio', model: judgeModel } } : {}),
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
process.exit(0);
