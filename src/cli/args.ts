import { parseArgs } from 'node:util';
import { CliHelpRequested, CliUsageError } from './errors.js';
import { formatHelp } from './help.js';

export interface CliArgs {
  commitments: string;
  tool: string;
  paths: string[];
  command?: string;
  explain: boolean;
  json: boolean;
}

/**
 * `--tool` is PRIMARY and required, with no enum validation beyond
 * non-empty: normalizeExec is total and degrades an unrecognized tool to
 * kind `other`. `--kind` MUST NOT EXIST as a flag: kind is derived by
 * normalizeExec from module-private sets, a many-to-one projection of tool,
 * and a free `--kind` would let a caller build tool/kind pairs the harness
 * can never emit. Not declaring it as an option is sufficient — parseArgs'
 * strict mode rejects it as unknown.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const [subcommand, ...rest] = argv;

  // `--help`/`-h` short-circuit everything else, before the "check" subcommand
  // check and before any required-flag validation: a documentation request
  // is never a usage error, and must not need --commitments or --tool.
  if (subcommand === '--help' || subcommand === '-h') {
    throw new CliHelpRequested(formatHelp());
  }

  if (subcommand !== 'check') {
    throw new CliUsageError(
      subcommand === undefined
        ? 'missing subcommand: expected "check"'
        : `unknown subcommand "${subcommand}": expected "check"`,
    );
  }

  let values: {
    commitments?: string;
    tool?: string;
    path?: string[];
    command?: string;
    explain?: boolean;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        commitments: { type: 'string' },
        tool: { type: 'string' },
        path: { type: 'string', multiple: true },
        command: { type: 'string' },
        explain: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false, short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new CliUsageError((cause as Error).message, { cause });
  }

  if (values.help) {
    throw new CliHelpRequested(formatHelp());
  }

  if (!values.commitments) {
    throw new CliUsageError('--commitments is required');
  }
  if (!values.tool) {
    throw new CliUsageError('--tool is required');
  }
  const paths = values.path ?? [];
  if (paths.length === 0 && values.command === undefined) {
    throw new CliUsageError('at least one of --path or --command is required');
  }

  return {
    commitments: values.commitments,
    tool: values.tool,
    paths,
    ...(values.command !== undefined ? { command: values.command } : {}),
    explain: values.explain ?? false,
    json: values.json ?? false,
  };
}
