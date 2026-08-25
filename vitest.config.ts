import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e spawns the built binary and belongs to `pnpm test:e2e` only —
    // naming it *.spec.ts or passing its path as a CLI positional does not
    // bypass include/exclude, so it is excluded here explicitly.
    exclude: [...configDefaults.exclude, 'test/cli/e2e.test.ts'],
  },
});
