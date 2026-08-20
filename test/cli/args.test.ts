import { describe, expect, it } from 'vitest';
import { CliUsageError } from '../../src/cli/errors.js';
import { parseCliArgs } from '../../src/cli/args.js';

const BASE = ['check', '--commitments', 'commitments.yaml', '--tool', 'bash', '--command', 'ls'];

describe('parseCliArgs', () => {
  it('parses a minimal valid invocation', () => {
    const args = parseCliArgs(BASE);
    expect(args).toMatchObject({
      commitments: 'commitments.yaml',
      tool: 'bash',
      paths: [],
      command: 'ls',
      explain: false,
      json: false,
    });
  });

  it('collects two --path values in order', () => {
    const args = parseCliArgs([
      'check',
      '--commitments',
      'commitments.yaml',
      '--tool',
      'write',
      '--path',
      'a.ts',
      '--path',
      'b.ts',
    ]);
    expect(args.paths).toEqual(['a.ts', 'b.ts']);
  });

  it('sets --explain and --json flags', () => {
    const args = parseCliArgs([...BASE, '--explain', '--json']);
    expect(args.explain).toBe(true);
    expect(args.json).toBe(true);
  });

  it('throws CliUsageError when the subcommand is not check', () => {
    expect(() => parseCliArgs(['bogus', '--commitments', 'c.yaml', '--tool', 'bash', '--command', 'ls'])).toThrow(
      CliUsageError,
    );
  });

  it('throws CliUsageError when no subcommand is given', () => {
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
  });

  it('throws CliUsageError on an unknown flag', () => {
    expect(() => parseCliArgs([...BASE, '--bogus'])).toThrow(CliUsageError);
  });

  it('rejects --kind as an unknown flag: kind is derived, never user-supplied', () => {
    expect(() => parseCliArgs([...BASE, '--kind', 'shell'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when a boolean flag is given =value', () => {
    expect(() => parseCliArgs([...BASE, '--json=true'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when a string flag is missing its value', () => {
    expect(() =>
      parseCliArgs(['check', '--commitments', 'commitments.yaml', '--tool']),
    ).toThrow(CliUsageError);
  });

  it('throws CliUsageError on a stray positional', () => {
    expect(() => parseCliArgs([...BASE, 'extra-positional'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when --commitments is missing', () => {
    expect(() => parseCliArgs(['check', '--tool', 'bash', '--command', 'ls'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when --tool is missing', () => {
    expect(() => parseCliArgs(['check', '--commitments', 'c.yaml', '--command', 'ls'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when --tool is empty', () => {
    expect(() => parseCliArgs(['check', '--commitments', 'c.yaml', '--tool', '', '--command', 'ls'])).toThrow(
      CliUsageError,
    );
  });

  it('throws CliUsageError when neither --path nor --command is given', () => {
    expect(() => parseCliArgs(['check', '--commitments', 'c.yaml', '--tool', 'bash'])).toThrow(CliUsageError);
  });
});
