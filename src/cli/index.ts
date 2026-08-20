#!/usr/bin/env node
import { parseCliArgs } from './args.js';
import { CliUsageError } from './errors.js';
import { EXIT_INTERNAL_ERROR, EXIT_USAGE } from './exit-codes.js';
import { runCheck } from './run.js';

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runCheck(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

// LOAD-BEARING: Node exits 1 on an uncaught exception, which would collide
// with BLOCK and make a CLI crash look like a policy violation. This is the
// top-level try/catch for the whole run: a usage error (thrown by
// parseCliArgs, before any decision is reached) remaps to exit 2; anything
// else unexpected remaps to exit 5, never to node's default 1.
main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    process.stderr.write(`internal error: ${(error as Error).message}\n`);
    process.exitCode = EXIT_INTERNAL_ERROR;
  });
