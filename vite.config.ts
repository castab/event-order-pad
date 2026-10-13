import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ strict: true }),
    }),
  ],
  build: { target: 'es2020' },
  test: {
    include: ['src/**/*.test.ts', 'printer-service/**/*.test.ts'],
    environment: 'node',
    exclude: ['printer-service/**/*.postgres.test.ts'],
  },
});
