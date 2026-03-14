import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@uni/protocol': path.resolve(rootDir, 'packages/protocol/src/index.ts')
    }
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/bot/test/**/*.test.ts']
  }
});
