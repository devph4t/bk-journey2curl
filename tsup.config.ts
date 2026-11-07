import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: true,
  async onSuccess() {
    // Templates are read at run time from dist/templates.
    cpSync('src/templates', 'dist/templates', { recursive: true });
  },
});
