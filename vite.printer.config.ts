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
        'auth-cli': 'printer-service/auth-cli.ts',
      },
      output: { entryFileNames: '[name].mjs' },
    },
  },
});
