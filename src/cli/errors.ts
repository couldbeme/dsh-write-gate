/**
 * Thrown for any CLI usage problem (bad flags, missing required values, an
 * unknown subcommand). Always maps to exit code 2 — see exit-codes.ts.
 */
export class CliUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliUsageError';
  }
}

/**
 * Thrown when the user asked for help (`--help`/`-h`, or `check --help`).
 * Deliberately NOT a CliUsageError: asking for help is not a usage mistake,
 * so it always maps to exit code 0 with the text on stdout, never stderr —
 * see index.ts's error mapping.
 */
export class CliHelpRequested extends Error {
  readonly text: string;

  constructor(text: string) {
    super('help requested');
    this.name = 'CliHelpRequested';
    this.text = text;
  }
}
