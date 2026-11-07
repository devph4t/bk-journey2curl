import { describe, expect, it } from 'vitest';
import { describeNode } from '../src/analyze/catalog/index.js';
import { scanScript } from '../src/analyze/catalog/script-scan.js';
import type { CatalogContext } from '../src/analyze/catalog/types.js';
import type { BkConfig } from '../src/config.js';
import type { JNode } from '../src/model/types.js';
import { sample } from './helpers.js';

const ctx = (config: BkConfig = {}): CatalogContext => ({ journey: 'T', scripts: sample().scripts, config });
const node = (type: string, config: Record<string, unknown> = {}, extra: Partial<JNode> = {}): JNode => ({
  id: `${type}-id`,
  type,
  name: type,
  x: 0,
  y: 0,
  outcomes: { outcome: 'x' },
  outcomeOrder: ['outcome'],
  config,
  ...extra,
});
const types = (n: JNode, c = ctx()) => describeNode(n, c).callbacks.map((cb) => cb.type);

describe('platform nodes', () => {
  it('username and password depend on validateInput', () => {
    expect(types(node('ValidatedUsernameNode', { validateInput: false }))).toEqual(['NameCallback']);
    expect(types(node('ValidatedUsernameNode', { validateInput: true }))).toEqual(['ValidatedCreateUsernameCallback']);
    expect(types(node('ValidatedPasswordNode', { validateInput: false }))).toEqual(['PasswordCallback']);
    const p = describeNode(node('ValidatedPasswordNode', { validateInput: true }), ctx()).callbacks[0];
    expect(p?.type).toBe('ValidatedCreatePasswordCallback');
    expect(p?.inputs.map((i) => [i.kind, i.value])).toEqual([
      ['string', undefined],
      ['fixed', false],
    ]);
  });

  it('attribute collector: preferences/* are boolean, others string, config overrides', () => {
    const n = node('AttributeCollectorNode', { attributesToCollect: ['givenName', 'preferences/updates', 'age'] });
    expect(types(n)).toEqual([
      'StringAttributeInputCallback',
      'BooleanAttributeInputCallback',
      'StringAttributeInputCallback',
    ]);
    expect(types(n, ctx({ attributeTypes: { age: 'number' } }))[2]).toBe('NumberAttributeInputCallback');
    expect(describeNode(n, ctx()).callbacks[1]?.inputs[0]?.variable).toBe('PREF_UPDATES');
  });

  it('KBA count comes from config (default 1 with a warning)', () => {
    const one = describeNode(node('KbaCreateNode'), ctx());
    expect(one.callbacks).toHaveLength(1);
    expect(one.callbacks[0]?.inputs.map((i) => i.variable)).toEqual(['KBA_QUESTION', 'KBA_ANSWER']);
    expect(one.warnings?.[0]?.code).toBe('kba-count');
    const two = describeNode(node('KbaCreateNode'), ctx({ kbaCount: 2 }));
    expect(two.callbacks).toHaveLength(2);
    expect(two.warnings).toEqual([]);
  });

  it('terms, decisions and server-decided nodes', () => {
    expect(types(node('AcceptTermsAndConditionsNode'))).toEqual(['TermsAndConditionsCallback']);
    expect(describeNode(node('IdentityStoreDecisionNode'), ctx())).toMatchObject({
      callbacks: [],
      branching: 'preferred',
    });
    expect(describeNode(node('LoginCountDecisionNode', { amount: 3, interval: 'AT' }), ctx())).toMatchObject({
      branching: 'server',
    });
  });

  it('page node composes its children in order', () => {
    const page = node(
      'PageNode',
      {},
      {
        inner: [node('ValidatedUsernameNode'), node('ValidatedPasswordNode'), node('EmailSuspendNode')],
      },
    );
    const info = describeNode(page, ctx());
    expect(info.callbacks.map((c) => c.type)).toEqual([
      'NameCallback',
      'PasswordCallback',
      'SuspendedTextOutputCallback',
    ]);
    expect(info.kind).toBe('suspend');
  });

  it('unknown node types give a warning, not a crash', () => {
    const info = describeNode(node('SomeFutureNode'), ctx());
    expect(info).toMatchObject({ known: false, callbacks: [] });
    expect(info.warnings?.[0]?.code).toBe('unknown-node');
  });
});

describe('flow and MFA nodes', () => {
  it('email suspend, zero page, inner tree, session', () => {
    expect(describeNode(node('EmailSuspendNode'), ctx()).kind).toBe('suspend');
    expect(
      describeNode(node('ZeroPageLoginNode', { usernameHeader: 'X-U', passwordHeader: 'X-P' }), ctx()).headers,
    ).toEqual({
      'X-U': 'IN_USERNAME',
      'X-P': 'IN_PASSWORD',
    });
    expect(describeNode(node('InnerTreeEvaluatorNode', { tree: 'Login' }), ctx()).innerJourney).toBe('Login');
    expect(describeNode(node('SessionDataNode'), ctx()).needsSession).toBe(true);
  });

  it('OATH verifier uses the totp solver; WebAuthn is manual', () => {
    const oath = describeNode(node('OathTokenVerifierNode', { isRecoveryCodeAllowed: true }), ctx());
    expect(oath.callbacks.map((c) => c.type)).toEqual(['NameCallback', 'ConfirmationCallback']);
    expect(oath.callbacks[0]?.inputs[0]?.solver).toBe('totp');
    expect(oath.links?.recoveryCodeOutcome?.value).toBe(1);
    expect(describeNode(node('WebAuthnAuthenticationNode'), ctx()).kind).toBe('manual');
  });
});

describe('script scanner', () => {
  const src = (name: string) => [...sample().scripts.values()].find((s) => s.name === name)?.source ?? '';

  it('finds next-gen callbacks in order with prompts and options', () => {
    const s = scanScript(src('Demo - channel'));
    expect(s.callbacks).toEqual([
      { type: 'TextOutputCallback', prompt: 'Welcome to the demo signup journey.' },
      {
        type: 'ChoiceCallback',
        prompt: 'Which channel are you signing up from?',
        options: ['web', 'mobile', 'partner'],
        value: 0,
      },
    ]);
    expect(s.readsCallbacks).toBe(true);
  });

  it('links outcomes to choice indexes (goTo(choices[picked]))', () => {
    const s = scanScript(src('Demo - channel'));
    expect(s.links).toEqual({
      web: { callbackType: 'ChoiceCallback', nth: 0, value: 0 },
      mobile: { callbackType: 'ChoiceCallback', nth: 0, value: 1 },
      partner: { callbackType: 'ChoiceCallback', nth: 0, value: 2 },
    });
  });

  it('links a confirmation ternary (c === 0 ? accept : decline)', () => {
    const s = scanScript(src('Demo - consent'));
    expect(s.links.accept?.value).toBe(0);
    expect(s.links.decline?.value).toBe(1);
    expect(s.callbacks[1]?.options).toEqual(['Accept', 'Decline']);
  });

  it('renders concatenated prompts with placeholders', () => {
    expect(scanScript(src('Demo - math')).callbacks[0]?.prompt).toBe('Math challenge: what is {a} + {b}?');
  });

  it('flags server-decided scripts (no callback reads, random)', () => {
    const s = scanScript(src('Demo - picker'));
    expect(s).toMatchObject({ readsCallbacks: false, dynamicGoTo: true, usesRandom: true, callbacks: [] });
  });

  it('handles legacy callbacks and outcome assignment', () => {
    const s = scanScript(`
      // legacy
      if (callbacks.isEmpty()) {
        action = fr.Action.send(new fr.NameCallback("Nickname"), new javax.security.auth.callback.PasswordCallback("PIN", false)).build();
      } else { outcome = "true"; }
    `);
    expect(s.callbacks.map((c) => [c.type, c.prompt])).toEqual([
      ['NameCallback', 'Nickname'],
      ['PasswordCallback', 'PIN'],
    ]);
    expect(s.outcomes).toEqual(['true']);
  });

  it('scripted handler names variables from the node or the prompts', () => {
    const b = sample();
    const find = (j: string, name: string) =>
      [...(b.journeys.get(j)?.nodes.values() ?? [])].find((n) => n.name === name) as JNode;
    const channel = describeNode(find('DemoSignup', 'Choose Channel'), ctx());
    expect(channel.callbacks[1]?.inputs[0]?.variable).toBe('CHANNEL');
    expect(channel.links?.partner).toEqual({ callbackIndex: 1, inputIndex: 0, value: 2 });
    const prefs = describeNode(find('DemoPreferencesSub', 'Collect Preferences'), ctx());
    expect(prefs.callbacks.map((c) => c.inputs[0]?.variable)).toEqual(['CITY', 'PREFERRED_LANGUAGE']);
    expect(describeNode(find('DemoVerifySub', 'Random Challenge Picker'), ctx())).toMatchObject({
      branching: 'server',
      serverReason: 'random',
    });
  });
});
