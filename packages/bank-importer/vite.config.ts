import path from 'path';

import { defineConfig } from 'vite';

export default defineConfig({
  ssr: { noExternal: true, external: ['@actual-app/api'] },
  build: {
    ssr: true,
    target: 'node22',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        banner: chunk => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
