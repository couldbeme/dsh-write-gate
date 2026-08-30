import { EXIT_COMMITMENTS_ERROR, EXIT_INTERNAL_ERROR, EXIT_USAGE, exitCodeForDecision } from './exit-codes.js';

/** The one canonical usage line — README's CLI section mirrors this by hand; keep them in sync. */
const CHECK_USAGE_LINE =
  'dsh-write-gate check --commitments <file> --tool <name> [--path <p> ...] [--command <c>] [--explain] [--json]';

/**
 * Exit-code table lines, generated from exit-codes.ts's constants and from
 * exitCodeForDecision — the same single source of truth index.ts's error
 * mapping and run.ts's decision mapping both use. Never hand-type these
 * numbers into help prose: a future exit-code change would silently desync
 * the two.
 */
function exitCodeTable(): string[] {
  return [
    `  ${exitCodeForDecision('allow')} ALLOW`,
    `  ${exitCodeForDecision('block')} BLOCK`,
    `  ${EXIT_USAGE} usage error`,
    `  ${exitCodeForDecision('warn')} WARN`,
    `  ${EXIT_COMMITMENTS_ERROR} commitments file unreadable or invalid`,
    `  ${EXIT_INTERNAL_ERROR} internal error`,
  ];
}

/**
 * There is exactly one subcommand today, so `--help`/`-h` and
 * `check --help` intentionally return the identical text — one source of
 * truth, never two near-duplicate help blocks to keep in sync.
 */
export function formatHelp(): string {
  return (
    [
      'dsh-write-gate: commitment write-gate CLI',
      '',
      'Usage:',
      `  ${CHECK_USAGE_LINE}`,
      '  dsh-write-gate --help | -h',
      '',
      '--commitments <file> is required. --tool <name> is required and gets no',
      'enum validation beyond non-empty. At least one of --path or --command',
      'is required.',
      '',
      'Options:',
      '  --commitments <file>  path to the commitments YAML file (required)',
      '  --tool <name>         tool name, e.g. bash, write, read (required)',
      '  --path <p>            file path in scope; repeatable',
      '  --command <c>         shell command in scope',
      '  --explain              expand each record with statement, severity, tier, pattern, rationale',
      '  --json                 print only a JSON document to stdout, safe for | jq .',
      '  --help, -h             show this help and exit 0',
      '',
      'Exit codes:',
      ...exitCodeTable(),
    ].join('\n') + '\n'
  );
}
