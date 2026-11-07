import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExportBundle, Plan } from '../model/types.js';
import type { CurlOptions } from './curl.js';
import { buildViewerData, injectViewerData } from './viewer-data.js';

let cached: string | undefined;

/**
 * The built viewer page: dist/templates/viewer.html in the CLI build, viewer/dist/index.html when running
 * from source (tests, dev). Returns undefined when the viewer has not been built yet.
 */
export function viewerTemplate(): string | undefined {
  if (cached) return cached;
  const candidates = [
    new URL('./templates/viewer.html', import.meta.url),
    new URL('../../viewer/dist/index.html', import.meta.url),
    new URL('../viewer/dist/index.html', import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      cached = readFileSync(path, 'utf8');
      return cached;
    }
  }
  return undefined;
}

/** `<journey>.html`: the flow viewer with this plan embedded. */
export function generateViewer(
  plan: Plan,
  bundle: ExportBundle,
  opts: CurlOptions & { source?: string } = {},
): string | undefined {
  const template = viewerTemplate();
  if (!template) return undefined;
  return injectViewerData(template, buildViewerData(plan, bundle, opts));
}
