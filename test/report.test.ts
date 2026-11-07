import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Planner } from '../src/analyze/planner.js';
import { buildReport, coverageBelow, renderReportHtml, renderReportMd } from '../src/generate/report.js';
import { generateRunbook, realmPath } from '../src/generate/runbook.js';
import { writeJourneyFiles, writeReport } from '../src/generate/write.js';
import type { Plan } from '../src/model/types.js';
import { sample } from './helpers.js';

const plans = (): Plan[] => {
  const planner = new Planner(sample());
  return [...sample().journeys.keys()].sort((a, b) => a.localeCompare(b)).map((n) => planner.plan(n));
};
const FIXED_TIME = '2026-11-08T00:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'bkj2c-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('report', () => {
  const report = buildReport(plans(), sample().meta, 'all-journeys-alpha.json', FIXED_TIME);
  const row = (j: string) => report.journeys.find((x) => x.journey === j);

  it('summarises coverage across journeys', () => {
    expect(report.summary).toEqual({ journeys: 13, full: 7, partial: 5, manual: 1 });
  });

  it('rows match design §6.7', () => {
    expect(row('Login')).toMatchObject({ stepsText: '1 (+1 optional)', coverage: 'full' });
    expect(row('DemoSignup')).toMatchObject({ stepsText: '6', coverage: 'full', variantSteps: 1 });
    expect(row('DemoSignup')?.note).toMatch(/solved at run time/);
    expect(row('Agent')).toMatchObject({ stepsText: '0', coverage: 'full', note: 'Headers only (Zero Page Login)' });
    expect(row('Registration')).toMatchObject({
      stepsText: '1',
      coverage: 'partial',
      note: 'Stops at Email Suspend Node',
    });
    expect(row('UpdatePassword')?.coverage).toBe('partial');
    expect(row('frAuth2')?.coverage).toBe('partial');
    expect(row('passwordless2')).toMatchObject({ coverage: 'manual' });
  });

  it('report.json carries what CI needs', () => {
    const j = row('DemoSignup');
    expect(j?.steps[2]?.variants?.map((v) => v.solver)).toEqual(['math-sum', 'echo-text', 'echo-hidden']);
    expect(j?.files).toEqual({
      sh: 'DemoSignup/DemoSignup.sh',
      runbook: 'DemoSignup/DemoSignup.runbook.md',
      viewer: 'DemoSignup/DemoSignup.html',
    });
    expect(j).toHaveProperty('unreachable');
    expect(j).toHaveProperty('unknownTypes');
    // No secret values in the report, only variable names.
    expect(JSON.stringify(report)).not.toMatch(/CHANGE_ME/);
  });

  it('renders markdown and html', () => {
    expect(renderReportMd(report)).toMatchSnapshot();
    const html = renderReportHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<%');
    for (const j of report.journeys) expect(html).toContain(`>${j.journey}<`);
    expect(html).toContain('<code>--with-session Login</code>');
  });

  it('escapes journey names in html', () => {
    const r = buildReport([{ ...plans()[0], journey: '<x&y>' } as Plan], sample().meta, undefined, FIXED_TIME);
    const html = renderReportHtml(r);
    expect(html).toContain('&lt;x&amp;y&gt;');
    expect(html).not.toContain('<x&y>');
  });

  it('coverageBelow orders full > partial > manual', () => {
    expect(coverageBelow('manual', 'partial')).toBe(true);
    expect(coverageBelow('partial', 'partial')).toBe(false);
    expect(coverageBelow('partial', 'full')).toBe(true);
    expect(coverageBelow('full', 'manual')).toBe(false);
  });
});

describe('runbook', () => {
  const planner = new Planner(sample());
  const opts = { tenant: 'https://tenant.example.com', realm: 'alpha', source: 'all-journeys-alpha.json' };

  it('realm paths', () => {
    expect(realmPath('alpha')).toBe('realms/root/realms/alpha');
    expect(realmPath('/')).toBe('realms/root');
    expect(realmPath('root')).toBe('realms/root');
    expect(realmPath('a/b')).toBe('realms/root/realms/a/realms/b');
  });

  it.each(['Login', 'DemoSignup', 'UpdatePassword', 'Agent'])('%s.runbook.md', (name) => {
    expect(generateRunbook(planner.plan(name), opts)).toMatchSnapshot();
  });

  it('literal curl per step with input placeholders and expected next', () => {
    const rb = generateRunbook(planner.plan('Login'), opts);
    expect(rb).toContain('authIndexValue=Login');
    expect(rb).toContain('"value":"<IN_USERNAME>"');
    expect(rb).toContain('--arg v1 "$IN_USERNAME"');
    expect(rb).toContain('**Expected next:** NameCallback,PasswordCallback');
    expect(rb).toMatch(/optional step 2/);
  });

  it('zero page login sends headers on the start call', () => {
    const rb = generateRunbook(planner.plan('Agent'), opts);
    expect(rb).toContain('-H "X-OpenAM-Username: $IN_USERNAME"');
  });
});

describe('write', () => {
  it('writes sh, runbook and the three report files', () => {
    const planner = new Planner(sample(), { withSession: 'Login' });
    const ps = ['Login', 'UpdatePassword'].map((n) => planner.plan(n));
    const files = writeJourneyFiles(ps, planner, { out: dir, withSession: 'Login', source: 'x.json' });
    expect(files).toHaveLength(4);
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(readFileSync(join(dir, 'UpdatePassword', 'UpdatePassword.sh'), 'utf8')).toContain('run_session');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'Login', 'Login.sh')).mode & 0o111).not.toBe(0);

    const { written, report } = writeReport(ps, sample().meta, { out: dir, source: 'x.json' });
    expect(written.map((w) => w.slice(dir.length + 1))).toEqual(['report.json', 'report.md', 'index.html']);
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).summary).toEqual(report.summary);
  });
});
