import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API = 'http://localhost:5174';

export default defineConfig({
  root: 'src/web',
  server: {
    port: 5173,
    proxy: { '/api': API, '/files': API, '/exports': API },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'src/web/index.html'),
        export: resolve(import.meta.dirname, 'src/web/export.html'),
      },
    },
  },
});
