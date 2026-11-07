import { signature } from '../analyze/catalog/callbacks.js';
import type { Coverage, ExportMeta, Plan } from '../model/types.js';
import { render } from '../templates/index.js';

export interface ReportRow {
  journey: string;
  steps: string;
  coverage: Coverage;
  note: string;
}

export interface JourneyReport {
  journey: string;
  target: Plan['target'];
  coverage: Coverage;
  stepCount: number;
  optionalSteps: number;
  variantSteps: number;
  stepsText: string;
  note: string;
  coverageNotes: string[];
  steps: Array<{
    index: number;
    kind: string;
    journey: string;
    node: string;
    callbacks: string;
    variants?: Array<{ label: string; callbacks: string; solver?: string }>;
    plainText: string;
  }>;
  inputs: Array<{ variable: string; kind: string; secret: boolean }>;
  headers?: Record<string, string>;
  warnings: Plan['warnings'];
  unreachable: string[];
  unknownTypes: string[];
  files: { sh: string; runbook: string; viewer: string };
}

export interface ReportData {
  tool: 'bkj2c';
  version: string;
  generatedAt: string;
  source?: string;
  export: ExportMeta;
  summary: Record<Coverage, number> & { journeys: number };
  journeys: JourneyReport[];
}

const RANK: Record<Coverage, number> = { full: 2, partial: 1, manual: 0 };

export function coverageBelow(c: Coverage, min: Coverage): boolean {
  return RANK[c] < RANK[min];
}

/** "1 (+1 optional)", "6", "0" ... */
export function stepsText(plan: Plan): string {
  const optional = plan.steps.filter((s) => s.kind === 'optional').length;
  const main = plan.steps.filter((s) => s.kind !== 'optional' && s.kind !== 'suspend').length;
  return `${main}${optional ? ` (+${optional} optional)` : ''}`;
}

/** One short note for the summary table. */
export function mainNote(plan: Plan): string {
  if (!plan.reachable) return 'No path to the target';
  const manual = plan.steps.find((s) => s.kind === 'manual');
  if (manual) return `${manual.nodeName}: needs a person`;
  const suspend = plan.steps.find((s) => s.kind === 'suspend');
  if (suspend) return `Stops at ${suspend.nodeName}`;
  if (plan.needsSession && !plan.withSession) return 'Needs a session: `--with-session Login`';
  if (plan.coverageNotes[0]) return plan.coverageNotes[0];
  const variant = plan.steps.find((s) => s.kind === 'variant');
  if (variant) {
    const solved = (variant.variants ?? []).every((v) => v.solver);
    return `${variant.nodeName}: ${variant.variants?.length ?? 0} variants${solved ? ', solved at run time' : ''}`;
  }
  const optional = plan.steps.find((s) => s.kind === 'optional');
  if (optional) return `${optional.journey} step is optional`;
  if (plan.headers && !plan.steps.length) return 'Headers only (Zero Page Login)';
  return '';
}

export function buildReport(
  plans: Plan[],
  meta: ExportMeta,
  source?: string,
  generatedAt = new Date().toISOString(),
): ReportData {
  const summary = { full: 0, partial: 0, manual: 0, journeys: plans.length };
  for (const p of plans) summary[p.coverage]++;
  return {
    tool: 'bkj2c',
    version: '0.1.0',
    generatedAt,
    source,
    export: meta,
    summary,
    journeys: plans.map((p) => ({
      journey: p.journey,
      target: p.target,
      coverage: p.coverage,
      stepCount: p.steps.length,
      optionalSteps: p.steps.filter((s) => s.kind === 'optional').length,
      variantSteps: p.steps.filter((s) => s.kind === 'variant').length,
      stepsText: stepsText(p),
      note: mainNote(p),
      coverageNotes: p.coverageNotes,
      steps: p.steps.map((s) => {
        const step: JourneyReport['steps'][number] = {
          index: s.index,
          kind: s.kind,
          journey: s.journey,
          node: s.nodeName,
          callbacks: signature(s.callbacks),
          plainText: s.plainText,
        };
        if (s.variants)
          step.variants = s.variants.map((v) => ({ label: v.label, callbacks: v.signature, solver: v.solver }));
        return step;
      }),
      inputs: p.inputs.map((i) => ({ variable: i.variable, kind: i.kind, secret: !!i.secret })),
      ...(p.headers ? { headers: p.headers } : {}),
      warnings: p.warnings,
      unreachable: p.unreachable,
      unknownTypes: p.unknownTypes,
      files: {
        sh: `${p.journey}/${p.journey}.sh`,
        runbook: `${p.journey}/${p.journey}.runbook.md`,
        viewer: `${p.journey}/${p.journey}.html`,
      },
    })),
  };
}

const COVERAGE_LABEL: Record<Coverage, string> = { full: 'Full', partial: 'Partial', manual: 'Manual' };
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReportMd(r: ReportData): string {
  const out: string[] = [];
  out.push('# Journey coverage report');
  out.push('');
  out.push(
    `${r.summary.journeys} journeys · ${r.summary.full} full · ${r.summary.partial} partial · ${r.summary.manual} manual${r.source ? ` · from \`${r.source}\`` : ''}`,
  );
  out.push('');
  out.push('| Journey | Steps | Coverage | Main note |');
  out.push('| --- | --- | --- | --- |');
  for (const j of r.journeys)
    out.push(`| ${mdCell(j.journey)} | ${j.stepsText} | ${COVERAGE_LABEL[j.coverage]} | ${mdCell(j.note)} |`);
  const withWarnings = r.journeys.filter((j) => j.warnings.length || j.coverageNotes.length);
  if (withWarnings.length) {
    out.push('');
    out.push('## Notes and warnings');
    for (const j of withWarnings) {
      out.push('');
      out.push(`### ${j.journey}`);
      out.push('');
      for (const n of j.coverageNotes) out.push(`- ${mdCell(n)}`);
      for (const w of j.warnings) out.push(`- **${w.level}** ${mdCell(w.message)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const href = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function renderReportHtml(r: ReportData, opts: { viewers?: boolean } = {}): string {
  return render('report.html.eta', {
    r,
    esc,
    href,
    label: COVERAGE_LABEL,
    viewers: opts.viewers ?? false,
    // Inline-code backticks in notes become <code>.
    note: (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'),
  });
}
