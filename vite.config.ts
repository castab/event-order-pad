import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  build: { target: 'es2020' },
  test: {
    include: ['src/**/*.test.ts', 'printer-service/**/*.test.ts'],
    environment: 'node',
  },
});
