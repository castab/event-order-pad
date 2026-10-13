import { defineConfig } from 'vite';

export default defineConfig({
  tsconfig: './tsconfig.printer.json',
  build: {
    ssr: 'printer-service/server.ts',
    target: 'node22',
    outDir: 'build-printer',
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
});
