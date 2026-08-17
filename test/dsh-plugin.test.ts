import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
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

  it('fails the mount loudly when the commitments file is missing', async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await expect(
      ctx.plugin(WriteGate, { commitmentsFile: '/nonexistent/COMMITMENTS.yaml' }),
    ).rejects.toThrow(/commitments file/);
  });
});
