import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Planner } from '../src/analyze/planner.js';
import { formatPlan } from '../src/format/plan-text.js';
import { generateSh, shq } from '../src/generate/sh.js';
import { sample } from './helpers.js';

const opts = { tenant: 'https://tenant.example.com', realm: 'alpha', source: 'all-journeys-alpha.json' };
const hasBash = spawnSync('bash', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'bkj2c-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('plan text', () => {
  it.each(['Login', 'DemoSignup', 'Agent', 'UpdatePassword'])('%s', (name) => {
    expect(formatPlan(new Planner(sample()).plan(name))).toMatchSnapshot();
  });
});

describe('sh generator', () => {
  it.each(['Login', 'DemoSignup', 'Agent', 'Registration', 'frAuth2'])('%s.sh', (name) => {
    expect(generateSh(new Planner(sample()).plan(name), opts)).toMatchSnapshot();
  });

  it('UpdatePassword.sh with --with-session Login', () => {
    const planner = new Planner(sample(), { withSession: 'Login' });
    const sh = generateSh(planner.plan('UpdatePassword'), { ...opts, sessionPlan: planner.plan('Login') });
    expect(sh).toContain('run_session');
    expect(sh).toContain('step_s1()');
    expect(sh).toContain('START="${RESUME_AT:-2}"');
    expect(sh).toMatchSnapshot();
  });

  it('variant steps become a case on the received callback types', () => {
    const sh = generateSh(new Planner(sample()).plan('DemoSignup'), opts);
    expect(sh).toContain(`'HiddenValueCallback,PasswordCallback')   # pin`);
    expect(sh).toContain('*) unexpected 3');
  });

  it('never writes secrets: passwords default to CHANGE_ME', () => {
    const sh = generateSh(new Planner(sample(), { config: { inputs: { IN_USERNAME: 'demo' } } }).plan('Login'), opts);
    expect(sh).toContain(': "${IN_USERNAME:=demo}"');
    expect(sh).toContain(': "${IN_PASSWORD:=CHANGE_ME}"');
  });

  it.runIf(hasBash)('every generated script is valid bash', () => {
    const planner = new Planner(sample(), { withSession: 'Login' });
    for (const name of sample().journeys.keys()) {
      const p = planner.plan(name);
      const sh = generateSh(p, { ...opts, sessionPlan: p.needsSession ? planner.plan('Login') : undefined });
      const file = join(dir, `${name}.sh`);
      writeFileSync(file, sh);
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(r.stderr, name).toBe('');
      expect(r.status, name).toBe(0);
    }
  });

  it('shq quotes single quotes', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});
