import type { CallbackSpec, Step } from '../model/types.js';

const ATTRIBUTE_WORDS: Record<string, string> = {
  givenName: 'first name',
  sn: 'last name',
  mail: 'email address',
  telephoneNumber: 'phone number',
  userName: 'username',
  'preferences/updates': 'whether to receive updates',
  'preferences/marketing': 'whether to receive marketing emails',
};

const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const clean = (s: string) =>
  s
    .replace(/\{[^}]+\}/g, '…')
    .replace(/[?:.]+$/, '')
    .trim();

function phrase(cb: CallbackSpec): string | undefined {
  const p = cb.prompt ? clean(cb.prompt) : '';
  switch (cb.type) {
    case 'NameCallback':
      return /^user ?name$/i.test(p) ? 'enter your username' : p ? `enter ${lc(p)}` : 'enter a value';
    case 'PasswordCallback':
      return /^password$/i.test(p) ? 'enter your password' : p ? `enter ${lc(p)}` : 'enter a secret value';
    case 'ValidatedCreateUsernameCallback':
      return 'choose a username';
    case 'ValidatedCreatePasswordCallback':
      return 'choose a password';
    case 'StringAttributeInputCallback':
    case 'NumberAttributeInputCallback':
      return `enter your ${ATTRIBUTE_WORDS[cb.attribute ?? ''] ?? cb.attribute ?? p}`;
    case 'BooleanAttributeInputCallback':
      return `choose ${ATTRIBUTE_WORDS[cb.attribute ?? ''] ?? `"${cb.attribute ?? p}"`}`;
    case 'KbaCreateCallback':
      return 'pick a security question and answer it';
    case 'TermsAndConditionsCallback':
      return 'accept the terms and conditions';
    case 'ConsentMappingCallback':
      return 'give consent';
    case 'ChoiceCallback':
      return `${p ? lc(p) : 'pick an option'}${cb.options?.length ? ` (${cb.options.join(', ')})` : ''}`;
    case 'ConfirmationCallback':
      return cb.options?.length ? `choose ${cb.options.join(' or ')}` : 'confirm';
    case 'SuspendedTextOutputCallback':
      return 'check your email and click the link to continue';
    case 'PollingWaitCallback':
      return 'wait while the system checks';
    default:
      return undefined;
  }
}

function joinPhrases(parts: string[]): string {
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  if (uniq.length <= 1) return uniq[0] ?? '';
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function callbacksPlainText(callbacks: CallbackSpec[]): string {
  const types = callbacks.map((c) => c.type).join(',');
  if (types === 'NameCallback,PasswordCallback') return 'Sign in with your username and password';
  const parts = callbacks.flatMap((c) => phrase(c) ?? []);
  if (parts.length === 0) {
    const msg = callbacks.find((c) => c.type === 'TextOutputCallback' && c.prompt)?.prompt;
    return msg ? `Read the message ("${clean(msg)}") and continue` : 'Continue';
  }
  return cap(joinPhrases(parts));
}

/** Plain-language wording of a step, for people who do not read curl. */
export function stepPlainText(step: Step): string {
  switch (step.kind) {
    case 'variant': {
      const v = step.variants ?? [];
      return `The system gives you one of ${v.length} quick challenges (${v.map((x) => x.label).join(', ')}) and checks your answer`;
    }
    case 'manual':
      return `Do this by hand: ${step.notes?.[0] ?? callbacksPlainText(step.callbacks)}`;
    case 'suspend':
      return 'Check your email and click the link to continue';
    case 'optional':
      return `If asked: ${lc(callbacksPlainText(step.callbacks))}${step.condition ? ` (only when ${step.condition})` : ''}`;
    default:
      return callbacksPlainText(step.callbacks);
  }
}
