import { makeCallback } from './callbacks.js';
import { type Handler, info, localized, str } from './types.js';

const username: Handler = (node) =>
  info({
    callbacks: [
      node.config.validateInput === true
        ? makeCallback('ValidatedCreateUsernameCallback', {
            prompt: 'Username',
            variable: 'USERNAME',
            sourceNodeId: node.id,
          })
        : makeCallback('NameCallback', { prompt: 'User Name', variable: 'USERNAME', sourceNodeId: node.id }),
    ],
  });

const password: Handler = (node) =>
  info({
    callbacks: [
      node.config.validateInput === true
        ? makeCallback('ValidatedCreatePasswordCallback', {
            prompt: 'Password',
            variable: 'PASSWORD',
            sourceNodeId: node.id,
          })
        : makeCallback('PasswordCallback', { prompt: 'Password', variable: 'PASSWORD', sourceNodeId: node.id }),
    ],
  });

/** preferences/updates -> PREF_UPDATES, givenName -> GIVENNAME */
export function attributeVariable(attr: string): string {
  const a = attr.replace(/^preferences\//, 'pref/');
  return a
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

const attributeCollector: Handler = (node, ctx) => {
  const attrs = Array.isArray(node.config.attributesToCollect) ? (node.config.attributesToCollect as unknown[]) : [];
  const callbacks = attrs.map((a) => {
    const attr = String(a);
    const t = ctx.config.attributeTypes?.[attr] ?? (attr.startsWith('preferences/') ? 'boolean' : 'string');
    const type =
      t === 'boolean'
        ? 'BooleanAttributeInputCallback'
        : t === 'number'
          ? 'NumberAttributeInputCallback'
          : 'StringAttributeInputCallback';
    return makeCallback(type, {
      prompt: attr,
      attribute: attr,
      variable: attributeVariable(attr),
      sourceNodeId: node.id,
    });
  });
  const warnings = attrs.length
    ? []
    : [
        {
          level: 'warn' as const,
          code: 'no-attributes',
          nodeId: node.id,
          message: `${node.name}: no attributes to collect`,
        },
      ];
  return info({ callbacks, warnings });
};

const kbaCreate: Handler = (node, ctx) => {
  const count = ctx.config.kbaCount ?? 1;
  const callbacks = Array.from({ length: count }, (_, i) =>
    makeCallback('KbaCreateCallback', {
      prompt: localized(node.config.message) ?? 'Select a security question',
      variable: count > 1 ? `KBA${i + 1}` : 'KBA',
      sourceNodeId: node.id,
    }),
  );
  const warnings = ctx.config.kbaCount
    ? []
    : [
        {
          level: 'info' as const,
          code: 'kba-count',
          nodeId: node.id,
          message: `${node.name}: KBA question count is not in the export; assuming 1 (set "kbaCount" in bk.config.json)`,
        },
      ];
  return info({ callbacks, warnings });
};

const kbaVerify: Handler = (node) =>
  info({
    callbacks: [
      makeCallback('PasswordCallback', { prompt: 'Security answer', variable: 'KBA_ANSWER', sourceNodeId: node.id }),
    ],
  });

const terms: Handler = (node) =>
  info({
    callbacks: [
      makeCallback('TermsAndConditionsCallback', {
        prompt: 'Accept terms',
        variable: 'ACCEPT_TERMS',
        value: true,
        sourceNodeId: node.id,
      }),
    ],
  });

const choiceCollector: Handler = (node) => {
  const choices = Array.isArray(node.config.choices)
    ? (node.config.choices as unknown[]).map(String)
    : node.outcomeOrder;
  const links: Record<string, { callbackIndex: number; inputIndex: number; value: unknown }> = {};
  choices.forEach((c, i) => {
    links[c] = { callbackIndex: 0, inputIndex: 0, value: i };
  });
  return info({
    callbacks: [
      makeCallback('ChoiceCallback', {
        prompt: str(node.config.prompt) ?? localized(node.config.prompt) ?? node.name,
        options: choices,
        variable: 'CHOICE',
        sourceNodeId: node.id,
      }),
    ],
    links,
  });
};

const message: Handler = (node) =>
  info({
    callbacks: [
      makeCallback('TextOutputCallback', {
        prompt: localized(node.config.message) ?? node.name,
        sourceNodeId: node.id,
      }),
      makeCallback('ConfirmationCallback', {
        prompt: '',
        options: [localized(node.config.messageYes) ?? 'Yes', localized(node.config.messageNo) ?? 'No'],
        variable: 'CONFIRM',
        sourceNodeId: node.id,
      }),
    ],
    links: {
      true: { callbackIndex: 1, inputIndex: 0, value: 0 },
      false: { callbackIndex: 1, inputIndex: 0, value: 1 },
    },
  });

const loginCount: Handler = (node) =>
  info({
    branching: 'server',
    serverReason: 'login count',
    condition: (o) => {
      const amount = node.config.amount;
      const every = node.config.interval === 'EVERY';
      const when = every ? `it is a multiple of ${amount} logins` : `it is login number ${amount}`;
      return o === 'true' ? when : `${when.replace('it is', 'it is not')}`;
    },
  });

const queryFilter: Handler = (node) =>
  info({
    branching: 'server',
    serverReason: 'user data',
    condition: (o) =>
      `the user ${o === 'true' ? 'matches' : 'does not match'} "${str(node.config.queryFilter) ?? '?'}"`,
  });

const attributePresent: Handler = (node) =>
  info({
    branching: 'server',
    serverReason: 'user data',
    condition: (o) => `attribute "${str(node.config.presentAttribute) ?? '?'}" is ${o === 'true' ? 'set' : 'not set'}`,
  });

const identifyExisting: Handler = () =>
  info({
    branching: 'server',
    serverReason: 'user lookup',
    condition: (o) => (o === 'true' ? 'the user already exists' : 'the user does not exist'),
  });

const decision: Handler = () => info();

export const platformHandlers: Record<string, Handler> = {
  ValidatedUsernameNode: username,
  UsernameCollectorNode: username,
  ValidatedPasswordNode: password,
  PasswordCollectorNode: password,
  AttributeCollectorNode: attributeCollector,
  KbaCreateNode: kbaCreate,
  KbaVerifyNode: kbaVerify,
  AcceptTermsAndConditionsNode: terms,
  ChoiceCollectorNode: choiceCollector,
  MessageNode: message,
  LoginCountDecisionNode: loginCount,
  QueryFilterDecisionNode: queryFilter,
  AttributePresentDecisionNode: attributePresent,
  IdentifyExistingUserNode: identifyExisting,
  // Decision and data nodes: no callbacks, outcome follows success of the action or the input.
  IdentityStoreDecisionNode: decision,
  DataStoreDecisionNode: decision,
  AgentDataStoreDecisionNode: decision,
  CreateObjectNode: decision,
  PatchObjectNode: decision,
  IncrementLoginCountNode: decision,
  AccountLockoutNode: decision,
  RetryLimitDecisionNode: decision,
  SetSuccessUrlNode: decision,
  SetFailureUrlNode: decision,
  SetSessionPropertiesNode: decision,
  SetStateNode: decision,
  RequiredAttributesDecisionNode: decision,
  ProvisionDynamicAccountNode: decision,
  TimerStartNode: decision,
  TimerStopNode: decision,
  MeterNode: decision,
  RegisterLogoutWebhookNode: decision,
  AccountActiveDecisionNode: decision,
  ProfileCompletenessDecisionNode: decision,
  PasswordExpiryNode: decision,
  KbaDecisionNode: decision,
  ConsentNode: (node) =>
    info({
      callbacks: [
        makeCallback('ConsentMappingCallback', {
          prompt: node.name,
          variable: 'CONSENT',
          value: true,
          sourceNodeId: node.id,
        }),
      ],
    }),
};
