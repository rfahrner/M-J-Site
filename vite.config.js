import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const htmlInputs = Object.fromEntries(
  readdirSync(rootDir)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [file.replace(/\.html$/, ''), resolve(rootDir, file)])
);

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: htmlInputs,
    },
  },
});
