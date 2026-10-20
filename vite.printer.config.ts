import { defineConfig } from 'vite';

export default defineConfig({
  tsconfig: './tsconfig.printer.json',
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'build-printer',
    rollupOptions: {
      input: {
        server: 'printer-service/server.ts',
        'access-cli': 'printer-service/access-cli.ts',
        ops: 'printer-service/ops-cli.ts',
      },
      output: { entryFileNames: '[name].mjs' },
    },
  },
});
