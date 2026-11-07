import { describe, expect, it } from 'vitest';
import { Planner, parseChoose } from '../src/analyze/planner.js';
import { plan, sample, types } from './helpers.js';

describe('planner – sample journeys (design §6.7)', () => {
  it('Login: 1 step + optional ProgressiveProfile page, FULL', () => {
    const p = plan('Login');
    expect(p.coverage).toBe('full');
    expect(p.steps.map((s) => s.kind)).toEqual(['submit', 'optional']);
    expect(types(p)).toEqual([
      'NameCallback,PasswordCallback',
      'BooleanAttributeInputCallback,BooleanAttributeInputCallback',
    ]);
    expect(p.steps[1]?.journey).toBe('ProgressiveProfile');
    expect(p.steps[1]?.condition).toContain('login number 3');
    // The inner journey goes straight to Success on the planned path.
    expect(p.trail.filter((t) => t.depth === 1).map((t) => `${t.nodeName}:${t.outcome}`)).toEqual([
      'Login Count Decision:false',
    ]);
    expect(p.inputs.map((i) => i.variable)).toEqual([
      'IN_USERNAME',
      'IN_PASSWORD',
      'IN_PREF_UPDATES',
      'IN_PREF_MARKETING',
    ]);
  });

  it('DemoSignup: 6 steps, random challenge as a solved variant step, FULL', () => {
    const p = plan('DemoSignup');
    expect(p.coverage).toBe('full');
    expect(p.steps.map((s) => s.kind)).toEqual(['submit', 'submit', 'variant', 'submit', 'submit', 'submit']);
    const v = p.steps[2]?.variants ?? [];
    expect(v.map((x) => [x.label, x.signature, x.solver])).toEqual([
      ['math', 'NameCallback', 'math-sum'],
      ['phrase', 'TextOutputCallback,NameCallback', 'echo-text'],
      ['pin', 'HiddenValueCallback,PasswordCallback', 'echo-hidden'],
    ]);
    expect(p.steps[0]?.callbacks[1]?.inputs[0]).toMatchObject({ variable: 'IN_CHANNEL', value: 0 });
    expect(p.steps[3]?.callbacks[1]?.inputs[0]).toMatchObject({ value: 0 }); // Accept
    expect(p.steps[4]?.journey).toBe('DemoPreferencesSub');
  });

  it('Agent: no steps, credentials in headers', () => {
    const p = plan('Agent');
    expect(p.steps).toEqual([]);
    expect(p.headers).toEqual({ 'X-OpenAM-Username': 'IN_USERNAME', 'X-OpenAM-Password': 'IN_PASSWORD' });
    expect(p.coverage).toBe('full');
    expect(p.inputs.map((i) => i.variable).sort()).toEqual(['IN_PASSWORD', 'IN_USERNAME']);
  });

  it('Registration: one page then the email suspend, PARTIAL', () => {
    const p = plan('Registration');
    expect(p.steps.map((s) => s.kind)).toEqual(['submit', 'suspend']);
    expect(p.steps[0]?.callbacks).toHaveLength(9);
    expect(p.coverage).toBe('partial');
  });

  it('UpdatePassword: needs a session; current-password page or email decided by the server', () => {
    const p = plan('UpdatePassword');
    expect(p.needsSession).toBe(true);
    expect(p.coverage).toBe('partial');
    expect(p.steps.map((s) => s.kind)).toEqual(['variant', 'submit']);
    expect(p.steps[0]?.variants?.map((v) => v.kind)).toEqual(['submit', 'suspend']);
    expect(p.inputs.map((i) => i.variable)).toEqual(['IN_PASSWORD', 'IN_NEW_PASSWORD']);
    expect(plan('UpdatePassword', { withSession: 'Login' }).coverageNotes.join()).not.toMatch(/session/);
  });

  it('frAuth2: inner LDAP journey then OTP, PARTIAL', () => {
    const p = plan('frAuth2');
    expect(types(p)).toEqual(['NameCallback', 'PasswordCallback', 'NameCallback,ConfirmationCallback']);
    expect(p.steps[0]?.journey).toBe('test-journeys-001');
    expect(p.coverage).toBe('partial');
    expect(p.inputs.some((i) => i.variable === 'IN_TOTP_SECRET')).toBe(true);
  });

  it('passwordless2: WebAuthn makes it MANUAL', () => {
    const p = plan('passwordless2');
    expect(p.steps.map((s) => s.kind)).toEqual(['submit', 'manual']);
    expect(p.coverage).toBe('manual');
  });

  it('every journey plans without errors and has no unreachable nodes', () => {
    const planner = new Planner(sample());
    for (const name of sample().journeys.keys()) {
      const p = planner.plan(name);
      expect(p.reachable, name).toBe(true);
      expect(p.unreachable, name).toEqual([]);
      expect(p.unknownTypes, name).toEqual([]);
      expect(
        p.warnings.filter((w) => w.level === 'error'),
        name,
      ).toEqual([]);
      p.steps.forEach((s, i) => {
        expect(s.index).toBe(i + 1);
        expect(s.plainText.length).toBeGreaterThan(3);
      });
    }
  });
});

describe('planner – options', () => {
  it('--choose pins a branch (partner channel adds the partner code step)', () => {
    const p = plan('DemoSignup', { choose: ['Choose Channel=partner'] });
    expect(p.steps[0]?.callbacks[1]?.inputs[0]?.value).toBe(2);
    expect(p.steps[1]?.nodeName).toBe('Partner Code');
    expect(p.steps[1]?.callbacks.map((c) => c.type)).toEqual(['NameCallback']);
    expect(p.inputs.some((i) => i.variable === 'IN_PARTNER_CODE')).toBe(true);
  });

  it('--choose inside an inner journey turns the variant into a plain step', () => {
    const p = plan('DemoSignup', { choose: ['DemoVerifySub/Random Challenge Picker=phrase'] });
    const step = p.steps.find((s) => s.journey === 'DemoVerifySub');
    expect(step?.kind).toBe('submit');
    expect(step?.nodeName).toBe('Phrase Challenge');
    expect(step?.callbacks[1]?.inputs[0]?.solver).toBe('echo-text');
  });

  it('--target failure plans the shortest path to Failure', () => {
    const p = plan('Login', { target: 'failure' });
    expect(p.target).toBe('failure');
    expect(p.reachable).toBe(true);
    expect(p.trail.at(-1)?.nodeType).not.toBe('InnerTreeEvaluatorNode');
  });

  it('parseChoose validates its input', () => {
    expect(parseChoose(['A=b', 'J/N=o'])).toEqual([
      { node: 'A', outcome: 'b' },
      { journey: 'J', node: 'N', outcome: 'o' },
    ]);
    expect(() => parseChoose(['nope'])).toThrow();
  });

  it('paths lists every simple path', () => {
    const paths = new Planner(sample()).paths('DemoSignup');
    expect(paths.length).toBeGreaterThanOrEqual(3); // web, mobile, partner (+valid)
    expect(paths.every((p) => p[0]?.node.name === 'Init Run')).toBe(true);
  });

  it('missing inner journeys are reported', () => {
    const b = sample();
    const copy = { ...b, journeys: new Map([...b.journeys].filter(([k]) => k !== 'ProgressiveProfile')) };
    const p = new Planner(copy).plan('Login');
    expect(p.warnings.some((w) => w.code === 'missing-journey')).toBe(true);
    expect(p.coverage).toBe('partial');
  });
});
