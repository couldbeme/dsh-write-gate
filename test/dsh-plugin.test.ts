import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';
import * as WriteGate from '../src/dsh/index.js';
import type { ContradictionRecord } from '../src/core/types.js';

const COMMITMENTS = join(import.meta.dirname, '..', 'commitments.example.yaml');

function execInput(name: string, args: unknown) {
  return {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as Parameters<Context['tools']['execute']>[0];
}

async function boot(config?: Partial<WriteGate.Config>) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.tools.register(
    defineContentToolFixture({
      name: 'bash',
      description: 'run a command',
      parameters: { command: { type: 'string', required: true } },
      execute: async ({ command }: { command: string }) => [{ type: 'text', text: `ran: ${command}` }],
    }),
  );
  const logDir = mkdtempSync(join(tmpdir(), 'write-gate-'));
  const contradictionsLog = join(logDir, 'contradictions.jsonl');
  await ctx.plugin(WriteGate, { commitmentsFile: COMMITMENTS, contradictionsLog, ...config });
  return { ctx, contradictionsLog };
}

describe('dsh plugin export shape', () => {
  it('is a function-style plugin: no default export, loader fields intact', () => {
    expect('default' in WriteGate).toBe(false);
    expect(WriteGate.name).toBe('write-gate');
    expect(WriteGate.inject).toEqual(['tools']);
    expect(WriteGate.Config).toBeDefined();
    expect(typeof WriteGate.apply).toBe('function');
  });
});

describe('write-gate mounted in a real tool pipeline', () => {
  it('denies a structurally violating command and reports the commitment', async () => {
    const { ctx } = await boot();
    const result = await ctx.tools.execute(execInput('bash', { command: 'git push --force origin main' }));
    expect(result.isError).toBe(true);
    expect(result.isError && result.error.message).toMatch(/write-gate/);
    expect(result.isError && result.error.message).toMatch(/no-force-push/);
  });

  it('lets clean commands through untouched', async () => {
    const { ctx } = await boot();
    const result = await ctx.tools.execute(execInput('bash', { command: 'git status' }));
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('ran: git status');
  });

  it('cannot be bypassed by a listener that short-circuits allow (monotonic guard holds)', async () => {
    const { ctx } = await boot();
    // A hostile/buggy plugin registered after us, prepended, answering allow
    // without delegating — it preempts our waterfall listener entirely.
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true });
    const result = await ctx.tools.execute(execInput('bash', { command: 'git push --force origin main' }));
    expect(result.isError).toBe(true);
    expect(result.isError && result.error.message).toMatch(/write-gate/);
  });

  it('emits the contradiction event and appends the JSONL log line', async () => {
    const { ctx, contradictionsLog } = await boot();
    const seen: ContradictionRecord[] = [];
    ctx.on('write-gate/contradiction', (record) => {
      seen.push(record);
    });
    await ctx.tools.execute(execInput('bash', { command: 'DROP TABLE users' }));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toMatchObject({ commitmentId: 'no-destructive-sql', tier: 1, outcome: 'block' });
    const lines = readFileSync(contradictionsLog, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ commitmentId: 'no-destructive-sql' });
  });

  it('runs the tier-2 judge through the real llm seam and blocks on a verdict', async () => {
    class ScriptedAdapter extends LlmAdapter {
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        const text = '{"violates": true, "why": "deletes user data"}';
        yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
        yield { type: 'text-delta', index: 0, text } as StreamChunk;
        yield { type: 'block-end', index: 0, block: { type: 'text', text } } as unknown as StreamChunk;
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'write-gate-judge-'));
    const commitments = join(dir, 'COMMITMENTS.yaml');
    writeFileSync(
      commitments,
      'version: 1\ncommitments:\n  - id: no-user-data-deletion\n    statement: Never delete user data or user records.\n    semantic: true\n    match: { kinds: [shell] }\n',
    );
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(LlmRuntime);
    ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter());
    ctx.tools.register(
      defineContentToolFixture({
        name: 'bash',
        description: 'run a command',
        parameters: { command: { type: 'string', required: true } },
        execute: async ({ command }: { command: string }) => [{ type: 'text', text: `ran: ${command}` }],
      }),
    );
    const seen: ContradictionRecord[] = [];
    ctx.on('write-gate/contradiction', (record) => {
      seen.push(record);
    });
    await ctx.plugin(WriteGate, {
      commitmentsFile: commitments,
      contradictionsLog: join(dir, 'log.jsonl'),
      judge: { provider: 'scripted', model: 'scripted-model' },
    });
    const result = await ctx.tools.execute(execInput('bash', { command: 'delete all user records older than 30 days' }));
    expect(result.isError).toBe(true);
    expect(result.isError && result.error.message).toMatch(/no-user-data-deletion/);
    expect(seen[0]).toMatchObject({ tier: 2, outcome: 'block' });
    expect(seen[0]!.judged).toMatchObject({ violation: true });
  });

  it('fails closed with judge-unavailable when judge is configured but no llm service exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-gate-nollm-'));
    const commitments = join(dir, 'COMMITMENTS.yaml');
    writeFileSync(
      commitments,
      'version: 1\ncommitments:\n  - id: sem\n    statement: Never delete user data.\n    semantic: true\n    match: { kinds: [shell] }\n',
    );
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime); // no LlmRuntime on purpose
    ctx.tools.register(
      defineContentToolFixture({
        name: 'bash',
        description: 'run a command',
        parameters: { command: { type: 'string', required: true } },
        execute: async ({ command }: { command: string }) => [{ type: 'text', text: `ran: ${command}` }],
      }),
    );
    await ctx.plugin(WriteGate, {
      commitmentsFile: commitments,
      contradictionsLog: join(dir, 'log.jsonl'),
      judge: { provider: 'scripted', model: 'scripted-model' },
    });
    const result = await ctx.tools.execute(execInput('bash', { command: 'delete all user records' }));
    expect(result.isError).toBe(true);
    expect(result.isError && result.error.message).toMatch(/unavailable/i);
  });

  it('fails the mount loudly when the commitments file is missing', async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await expect(
      ctx.plugin(WriteGate, { commitmentsFile: '/nonexistent/COMMITMENTS.yaml' }),
    ).rejects.toThrow(/commitments file/);
  });
});
