import { describe, expect, it } from 'vitest';
import { CliHelpRequested, CliUsageError } from '../../src/cli/errors.js';
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

  // toThrow(CliHelpRequested) would degrade to a bare toThrow() while
  // CliHelpRequested is still undefined (not yet implemented) and pass
  // vacuously against the CliUsageError thrown today — catch explicitly and
  // assert instanceof instead, which hard-fails on an undefined constructor.
  function catchError(argv: string[]): unknown {
    try {
      parseCliArgs(argv);
    } catch (error) {
      return error;
    }
    throw new Error(`expected parseCliArgs(${JSON.stringify(argv)}) to throw`);
  }

  it('throws CliHelpRequested (not CliUsageError) for --help before any subcommand', () => {
    expect(catchError(['--help'])).toBeInstanceOf(CliHelpRequested);
  });

  it('throws CliHelpRequested for -h before any subcommand', () => {
    expect(catchError(['-h'])).toBeInstanceOf(CliHelpRequested);
  });

  it('throws CliHelpRequested for "check --help" without requiring --commitments or --tool', () => {
    expect(catchError(['check', '--help'])).toBeInstanceOf(CliHelpRequested);
  });

  it('help text (from --help) contains the check command line, the --tool required note, and the full exit-code table', () => {
    const caught = catchError(['--help']);
    expect(caught).toBeInstanceOf(CliHelpRequested);
    const text = (caught as CliHelpRequested).text;
    expect(text).toContain('dsh-write-gate check --commitments <file> --tool <name>');
    expect(text).toMatch(/--tool.*required/i);
    expect(text).toContain('0 ALLOW');
    expect(text).toContain('1 BLOCK');
    expect(text).toContain('2 usage error');
    expect(text).toContain('3 WARN');
    expect(text).toMatch(/4 .*commitments file unreadable/i);
    expect(text).toMatch(/5 .*internal/i);
  });

  it('help text is identical whether requested via --help, -h, or "check --help"', () => {
    const textOf = (argv: string[]): string => {
      const caught = catchError(argv);
      expect(caught).toBeInstanceOf(CliHelpRequested);
      return (caught as CliHelpRequested).text;
    };
    const topLevel = textOf(['--help']);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(textOf(['-h'])).toBe(topLevel);
    expect(textOf(['check', '--help'])).toBe(topLevel);
  });

  it('--json still parses normally when --help is not requested (regression)', () => {
    const args = parseCliArgs([...BASE, '--json']);
    expect(args.json).toBe(true);
  });

  it('still throws CliUsageError on an unknown flag even though --help exists as a recognized option', () => {
    expect(() => parseCliArgs([...BASE, '--bogus'])).toThrow(CliUsageError);
  });
});
