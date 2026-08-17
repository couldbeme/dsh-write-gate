import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Commitment, CommitmentSet, CompiledMatch } from './types.js';

const KINDS = ['fs-write', 'fs-read', 'shell', 'net', 'other'] as const;

const matchSchema = z
  .object({
    kinds: z.array(z.enum(KINDS)).optional(),
    tools: z.array(z.string().min(1)).optional(),
    paths: z.array(z.string().min(1)).optional(),
    commands: z.array(z.string().min(1)).optional(),
  })
  .strict();

const commitmentSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a kebab-case slug'),
    statement: z.string().min(1),
    severity: z.enum(['block', 'warn']).default('block'),
    semantic: z.boolean().default(false),
    match: matchSchema.optional(),
  })
  .strict();

const documentSchema = z
  .object({
    version: z.literal(1, { error: 'unsupported commitments version (expected 1)' }),
    defaults: z
      .object({
        failMode: z.enum(['closed', 'open']).default('closed'),
        judgeBudgetPerStep: z.number().int().positive().default(8),
      })
      .strict()
      .default({ failMode: 'closed', judgeBudgetPerStep: 8 }),
    commitments: z.array(commitmentSchema),
  })
  .strict();

export class CommitmentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentParseError';
  }
}

function compile(id: string, match: z.infer<typeof matchSchema> | undefined): CompiledMatch {
  const paths = (match?.paths ?? []).map((pattern) => picomatch(pattern, { dot: true }));
  const commands = (match?.commands ?? []).map((source) => {
    try {
      return new RegExp(source);
    } catch (cause) {
      throw new CommitmentParseError(
        `commitment "${id}": invalid command regex ${JSON.stringify(source)}: ${(cause as Error).message}`,
      );
    }
  });
  return { paths, commands };
}

export function loadCommitments(yamlText: string): CommitmentSet {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    throw new CommitmentParseError(`invalid YAML: ${(cause as Error).message}`);
  }

  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CommitmentParseError(`invalid commitments document: ${issues}`);
  }

  const seen = new Set<string>();
  const commitments: Commitment[] = parsed.data.commitments.map((entry) => {
    if (seen.has(entry.id)) {
      throw new CommitmentParseError(`duplicate commitment id: "${entry.id}"`);
    }
    seen.add(entry.id);
    if (!entry.semantic && !entry.match) {
      throw new CommitmentParseError(
        `commitment "${entry.id}" is non-semantic and has no match, so it can never be enforced; add a match or set semantic: true`,
      );
    }
    return {
      id: entry.id,
      statement: entry.statement,
      severity: entry.severity,
      semantic: entry.semantic,
      ...(entry.match ? { match: entry.match } : {}),
      compiled: compile(entry.id, entry.match),
    };
  });

  return {
    version: parsed.data.version,
    defaults: parsed.data.defaults,
    commitments,
  };
}
