import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds the flow viewer into one self-contained HTML file (viewer/dist/index.html).
// bkj2c replaces __BKJ2C_DATA__ in it with the plan JSON of each journey.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    reportCompressedSize: false,
  },
});
