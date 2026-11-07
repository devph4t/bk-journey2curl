import { fileURLToPath } from 'node:url';
import { Planner, type PlanOptions } from '../src/analyze/planner.js';
import { loadExportFile } from '../src/load/loader.js';
import type { ExportBundle, Plan } from '../src/model/types.js';

export const FIXTURE = fileURLToPath(new URL('./fixtures/all-journeys-alpha.json', import.meta.url));

let cached: ExportBundle | undefined;
export function sample(): ExportBundle {
  cached ??= loadExportFile(FIXTURE);
  return cached;
}

export function plan(journey: string, opts: PlanOptions = {}): Plan {
  return new Planner(sample(), opts).plan(journey);
}

export const types = (p: Plan) => p.steps.map((s) => s.callbacks.map((c) => c.type).join(','));
