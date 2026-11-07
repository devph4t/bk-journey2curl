import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Planner } from '../analyze/planner.js';
import type { ExportMeta, Plan } from '../model/types.js';
import { buildReport, type ReportData, renderReportHtml, renderReportMd } from './report.js';
import { generateRunbook } from './runbook.js';
import { generateSh } from './sh.js';

export interface WriteOptions {
  out: string;
  tenant?: string;
  realm?: string;
  /** Export file name for headers. */
  source?: string;
  withSession?: string;
}

/** Write `<out>/<journey>/<journey>.sh` and `.runbook.md` for each plan; returns the written paths. */
export function writeJourneyFiles(plans: Plan[], planner: Planner, opts: WriteOptions): string[] {
  const written: string[] = [];
  const sessionPlan = opts.withSession ? planner.plan(opts.withSession) : undefined;
  for (const plan of plans) {
    const dir = join(opts.out, plan.journey);
    mkdirSync(dir, { recursive: true });
    const useSession = plan.needsSession && plan.journey !== opts.withSession ? sessionPlan : undefined;
    const sh = generateSh(plan, {
      tenant: opts.tenant,
      realm: opts.realm,
      source: opts.source,
      sessionPlan: useSession,
    });
    const shPath = join(dir, `${plan.journey}.sh`);
    writeFileSync(shPath, sh, { mode: 0o755 });
    const rb = generateRunbook(plan, {
      tenant: opts.tenant,
      realm: opts.realm,
      source: opts.source,
      sessionJourney: useSession?.journey,
    });
    const rbPath = join(dir, `${plan.journey}.runbook.md`);
    writeFileSync(rbPath, rb);
    written.push(shPath, rbPath);
  }
  return written;
}

/** Write `index.html`, `report.json` and `report.md`; returns the report data and the written paths. */
export function writeReport(
  plans: Plan[],
  meta: ExportMeta,
  opts: { out: string; source?: string },
): { report: ReportData; written: string[] } {
  mkdirSync(opts.out, { recursive: true });
  const report = buildReport(plans, meta, opts.source);
  const viewers = plans.length > 0 && plans.every((p) => existsSync(join(opts.out, p.journey, `${p.journey}.html`)));
  const files: Array<[string, string]> = [
    ['report.json', `${JSON.stringify(report, null, 2)}\n`],
    ['report.md', renderReportMd(report)],
    ['index.html', renderReportHtml(report, { viewers })],
  ];
  const written: string[] = [];
  for (const [name, text] of files) {
    const path = join(opts.out, name);
    writeFileSync(path, text);
    written.push(path);
  }
  return { report, written };
}
