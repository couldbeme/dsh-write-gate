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
