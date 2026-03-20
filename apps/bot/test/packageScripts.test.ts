import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('root package scripts', () => {
  it('uses shadow-safe bot:start default and keeps raw start alias', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['bot:start']).toBe('pnpm --filter @uni/bot start:shadow');
    expect(pkg.scripts?.['bot:start:raw']).toBe('pnpm --filter @uni/bot start');
  });
});
