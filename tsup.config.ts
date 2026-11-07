import { cpSync, existsSync } from 'node:fs';
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
    cpSync('src/templates', 'dist/templates', { recursive: true, filter: (src) => !src.endsWith('.ts') });
    // The flow viewer page, built by `vite build -c viewer/vite.config.ts`.
    if (existsSync('viewer/dist/index.html')) cpSync('viewer/dist/index.html', 'dist/templates/viewer.html');
  },
});
