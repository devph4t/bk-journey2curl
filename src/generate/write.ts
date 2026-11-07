import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Planner } from '../analyze/planner.js';
import type { ExportBundle, ExportMeta, Plan } from '../model/types.js';
import { journeyFiles } from './paths.js';
import { buildReport, type ReportData, renderReportHtml, renderReportMd } from './report.js';
import { generateRunbook } from './runbook.js';
import { generateSh } from './sh.js';
import { generateViewer } from './viewer.js';

export interface WriteOptions {
  out: string;
  tenant?: string;
  realm?: string;
  /** Export file name for headers. */
  source?: string;
  withSession?: string;
  /** Needed for the flow viewer (journey graphs); without it no .html is written. */
  bundle?: ExportBundle;
}

/** Write `<journey>.sh`, `.runbook.md` and (when the viewer is built) `.html` for each plan; returns the paths. */
export function writeJourneyFiles(plans: Plan[], planner: Planner, opts: WriteOptions): string[] {
  const written: string[] = [];
  const sessionPlan = opts.withSession ? planner.plan(opts.withSession) : undefined;
  for (const plan of plans) {
    const files = journeyFiles(plan.journey);
    const dir = join(opts.out, files.dir);
    mkdirSync(dir, { recursive: true });
    const useSession = plan.needsSession && plan.journey !== opts.withSession ? sessionPlan : undefined;
    const sh = generateSh(plan, {
      tenant: opts.tenant,
      realm: opts.realm,
      source: opts.source,
      sessionPlan: useSession,
    });
    const shPath = join(opts.out, files.sh);
    writeFileSync(shPath, sh, { mode: 0o755 });
    const rb = generateRunbook(plan, {
      tenant: opts.tenant,
      realm: opts.realm,
      source: opts.source,
      sessionJourney: useSession?.journey,
    });
    const rbPath = join(opts.out, files.runbook);
    writeFileSync(rbPath, rb);
    written.push(shPath, rbPath);
    if (opts.bundle) {
      const html = generateViewer(plan, opts.bundle, { tenant: opts.tenant, realm: opts.realm, source: opts.source });
      if (html) {
        const htmlPath = join(opts.out, files.viewer);
        writeFileSync(htmlPath, html);
        written.push(htmlPath);
      }
    }
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
  const viewers = plans.length > 0 && plans.every((p) => existsSync(join(opts.out, journeyFiles(p.journey).viewer)));
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
