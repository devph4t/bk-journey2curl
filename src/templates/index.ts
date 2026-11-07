import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

const eta = new Eta({ autoEscape: false, autoTrim: false, useWith: false });
const cache = new Map<string, string>();

/** Templates live in src/templates (dev, tests) and are copied to dist/templates by the build. */
function templateText(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;
  const candidates = [
    new URL(`./templates/${name}`, import.meta.url),
    new URL(`../templates/${name}`, import.meta.url),
    new URL(`./${name}`, import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      cache.set(name, text);
      return text;
    }
  }
  throw new Error(`Template ${name} not found`);
}

export function render(name: string, data: object): string {
  return eta.renderString(templateText(name), data);
}
