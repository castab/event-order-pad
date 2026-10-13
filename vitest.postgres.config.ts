import { defineConfig } from 'vitest/config';

export default defineConfig({
  tsconfig: './tsconfig.printer.json',
  test: {
    include: ['printer-service/**/*.postgres.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
