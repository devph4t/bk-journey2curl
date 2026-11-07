// Best-effort static scan of P1AIC decision-node scripts (next-gen and legacy).
// It finds the callbacks a script sends (in order), resolves literal arrays used as options,
// links outcomes to callback inputs, and flags outcomes the server decides on its own.

type TokKind = 'str' | 'num' | 'id' | 'punc';
interface Tok {
  k: TokKind;
  v: string;
}

export interface ScannedCallback {
  type: string;
  /** Prompt / message; concatenated parts are rendered as {name} placeholders. */
  prompt?: string;
  options?: string[];
  /** Hidden value id (HiddenValueCallback) or attribute name (attribute callbacks). */
  id?: string;
  value?: unknown;
}

export interface OutcomeLink {
  /** Which callback of a given type (0 = first ChoiceCallback ...). */
  callbackType: string;
  nth: number;
  value: number;
}

export interface ScriptScan {
  callbacks: ScannedCallback[];
  /** The script reads submitted callbacks. */
  readsCallbacks: boolean;
  /** Literal outcomes passed to action.goTo / assigned to `outcome`. */
  outcomes: string[];
  /** goTo with a computed outcome. */
  dynamicGoTo: boolean;
  /** Outcome id -> input value that leads to it. */
  links: Record<string, OutcomeLink>;
  usesRandom: boolean;
}

const BUILDER_TYPES: Record<string, string> = {
  nameCallback: 'NameCallback',
  passwordCallback: 'PasswordCallback',
  textInputCallback: 'TextInputCallback',
  textOutputCallback: 'TextOutputCallback',
  choiceCallback: 'ChoiceCallback',
  confirmationCallback: 'ConfirmationCallback',
  hiddenValueCallback: 'HiddenValueCallback',
  booleanAttributeInputCallback: 'BooleanAttributeInputCallback',
  stringAttributeInputCallback: 'StringAttributeInputCallback',
  numberAttributeInputCallback: 'NumberAttributeInputCallback',
  termsAndConditionsCallback: 'TermsAndConditionsCallback',
  kbaCreateCallback: 'KbaCreateCallback',
  pollingWaitCallback: 'PollingWaitCallback',
  redirectCallback: 'RedirectCallback',
  metadataCallback: 'MetadataCallback',
  suspendedTextOutputCallback: 'SuspendedTextOutputCallback',
  scriptTextOutputCallback: 'ScriptTextOutputCallback',
  validatedUsernameCallback: 'ValidatedCreateUsernameCallback',
  validatedPasswordCallback: 'ValidatedCreatePasswordCallback',
  consentMappingCallback: 'ConsentMappingCallback',
  deviceProfileCallback: 'DeviceProfileCallback',
};

const READER_TYPES: Record<string, string> = {
  getNameCallbacks: 'NameCallback',
  getPasswordCallbacks: 'PasswordCallback',
  getChoiceCallbacks: 'ChoiceCallback',
  getConfirmationCallbacks: 'ConfirmationCallback',
  getHiddenValueCallbacks: 'HiddenValueCallback',
  getTextInputCallbacks: 'TextInputCallback',
  getBooleanAttributeInputCallbacks: 'BooleanAttributeInputCallback',
  getStringAttributeInputCallbacks: 'StringAttributeInputCallback',
  getNumberAttributeInputCallbacks: 'NumberAttributeInputCallback',
};

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src.charAt(j + 1);
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      const v = m?.[0] ?? c;
      out.push({ k: 'num', v });
      i += v.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      const v = m?.[0] ?? c;
      out.push({ k: 'id', v });
      i += v.length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === '===' || three === '!==') {
      out.push({ k: 'punc', v: three });
      i += 3;
    } else if (['==', '!=', '&&', '||', '<=', '>=', '++', '--', '+=', '=>'].includes(two)) {
      out.push({ k: 'punc', v: two });
      i += 2;
    } else {
      out.push({ k: 'punc', v: c });
      i++;
    }
  }
  return out;
}

const isP = (t: Tok | undefined, v: string) => t?.k === 'punc' && t.v === v;
const isId = (t: Tok | undefined, v?: string) => t?.k === 'id' && (v === undefined || t.v === v);

/** Index of the token closing the bracket opened at `open`. */
function closing(toks: Tok[], open: number): number {
  const o = toks[open]?.v;
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (isP(toks[i], o ?? '(')) depth++;
    else if (isP(toks[i], c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return toks.length - 1;
}

/** Split call arguments (tokens strictly between the parens) on top-level commas. */
function splitArgs(toks: Tok[]): Tok[][] {
  const args: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'punc' && ['(', '[', '{'].includes(t.v)) depth++;
    if (t.k === 'punc' && [')', ']', '}'].includes(t.v)) depth--;
    if (depth === 0 && isP(t, ',')) {
      args.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) args.push(cur);
  return args;
}

interface Scope {
  arrays: Map<string, string[]>;
  strings: Map<string, string>;
}

function evalArg(arg: Tok[], scope: Scope): unknown {
  if (arg.length === 0) return undefined;
  const first = arg[0];
  if (arg.length === 1 && first) {
    if (first.k === 'str') return first.v;
    if (first.k === 'num') return Number(first.v);
    if (isId(first, 'true')) return true;
    if (isId(first, 'false')) return false;
    if (first.k === 'id') return scope.arrays.get(first.v) ?? scope.strings.get(first.v);
  }
  if (isP(first, '[')) {
    const end = closing(arg, 0);
    if (end === arg.length - 1) {
      const items = splitArgs(arg.slice(1, end)).map((a) => evalArg(a, scope));
      if (items.every((x) => typeof x === 'string')) return items as string[];
    }
  }
  if (isP(first, '-') && arg.length === 2 && arg[1]?.k === 'num') return -Number(arg[1].v);
  // String concatenation: 'a ' + b + ' c' -> "a {b} c"
  if (arg.some((t) => t.k === 'str') && arg.some((t) => isP(t, '+'))) {
    let s = '';
    for (const part of splitOn(arg, '+')) {
      const v = part.length === 1 && part[0]?.k === 'str' ? part[0].v : undefined;
      if (v !== undefined) s += v;
      else if (part.length === 1 && part[0]?.k === 'id' && scope.strings.has(part[0].v))
        s += scope.strings.get(part[0].v);
      else s += `{${part.map((t) => t.v).join('')}}`;
    }
    return s;
  }
  return undefined;
}

function splitOn(toks: Tok[], sep: string): Tok[][] {
  const parts: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'punc' && ['(', '[', '{'].includes(t.v)) depth++;
    if (t.k === 'punc' && [')', ']', '}'].includes(t.v)) depth--;
    if (depth === 0 && isP(t, sep)) {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  parts.push(cur);
  return parts;
}

function collectScope(toks: Tok[]): Scope {
  const scope: Scope = { arrays: new Map(), strings: new Map() };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!(isId(t, 'var') || isId(t, 'let') || isId(t, 'const'))) continue;
    const name = toks[i + 1];
    if (name?.k !== 'id' || !isP(toks[i + 2], '=')) continue;
    const start = i + 3;
    if (isP(toks[start], '[')) {
      const end = closing(toks, start);
      const v = evalArg(toks.slice(start, end + 1), scope);
      if (Array.isArray(v)) scope.arrays.set(name.v, v as string[]);
    } else if (toks[start]?.k === 'str' && (isP(toks[start + 1], ';') || toks[start + 1] === undefined)) {
      scope.strings.set(name.v, toks[start]?.v ?? '');
    }
  }
  return scope;
}

function callbackFromArgs(type: string, args: unknown[]): ScannedCallback {
  const cb: ScannedCallback = { type };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (type) {
    case 'TextOutputCallback':
      cb.prompt = str(args[1]) ?? str(args[0]);
      break;
    case 'ChoiceCallback':
      cb.prompt = str(args[0]);
      if (Array.isArray(args[1])) cb.options = args[1] as string[];
      if (typeof args[2] === 'number') cb.value = args[2];
      break;
    case 'ConfirmationCallback': {
      cb.prompt = str(args[0]);
      const opts = args.find((a) => Array.isArray(a));
      if (opts) cb.options = opts as string[];
      const last = args[args.length - 1];
      if (typeof last === 'number') cb.value = last;
      break;
    }
    case 'HiddenValueCallback':
      cb.id = str(args[0]);
      cb.value = args[1];
      break;
    case 'BooleanAttributeInputCallback':
    case 'StringAttributeInputCallback':
    case 'NumberAttributeInputCallback':
      cb.id = str(args[0]);
      cb.prompt = str(args[1]);
      cb.value = args[2];
      break;
    default:
      cb.prompt = str(args[0]);
  }
  return cb;
}

/** Find `var X = callbacks.getXCallbacks().get(N)` (optionally `[0]`) -> { type, nth }. */
function readerVars(toks: Tok[]): Map<string, { type: string; nth: number }> {
  const vars = new Map<string, { type: string; nth: number }>();
  for (let i = 0; i < toks.length; i++) {
    if (!(isId(toks[i], 'var') || isId(toks[i], 'let') || isId(toks[i], 'const'))) continue;
    const name = toks[i + 1];
    if (name?.k !== 'id' || !isP(toks[i + 2], '=')) continue;
    const r = readerAt(toks, i + 3);
    if (r) vars.set(name.v, r);
  }
  return vars;
}

function readerAt(toks: Tok[], i: number): { type: string; nth: number } | undefined {
  // callbacks . getChoiceCallbacks ( ) . get ( N )
  if (!isId(toks[i], 'callbacks') || !isP(toks[i + 1], '.')) return undefined;
  const fn = toks[i + 2]?.v ?? '';
  const type = READER_TYPES[fn];
  if (!type) return undefined;
  if (!isP(toks[i + 3], '(') || !isP(toks[i + 4], ')') || !isP(toks[i + 5], '.') || !isId(toks[i + 6], 'get'))
    return undefined;
  const nth = Number(toks[i + 8]?.v ?? 0);
  return { type, nth: Number.isFinite(nth) ? nth : 0 };
}

export function scanScript(source: string): ScriptScan {
  const toks = tokenize(source);
  const scope = collectScope(toks);
  const readers = readerVars(toks);
  const result: ScriptScan = {
    callbacks: [],
    readsCallbacks: false,
    outcomes: [],
    dynamicGoTo: false,
    links: {},
    usesRandom: /Math\s*\.\s*random/.test(source),
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // callbacksBuilder.nameCallback(...)
    if (isId(t, 'callbacksBuilder') && isP(toks[i + 1], '.') && isP(toks[i + 3], '(')) {
      const fn = toks[i + 2]?.v ?? '';
      const type = BUILDER_TYPES[fn] ?? `${fn.charAt(0).toUpperCase()}${fn.slice(1)}`;
      const end = closing(toks, i + 3);
      const args = splitArgs(toks.slice(i + 4, end)).map((a) => evalArg(a, scope));
      result.callbacks.push(callbackFromArgs(type, args));
      i = end;
      continue;
    }
    // new [pkg.]FooCallback(...)  (legacy)
    if (isId(t, 'new')) {
      let j = i + 1;
      while (toks[j + 1] && isP(toks[j + 1], '.') && toks[j + 2]?.k === 'id') j += 2;
      const name = toks[j];
      if (name?.k === 'id' && name.v.endsWith('Callback') && isP(toks[j + 1], '(')) {
        const end = closing(toks, j + 1);
        const args = splitArgs(toks.slice(j + 2, end)).map((a) => evalArg(a, scope));
        result.callbacks.push(callbackFromArgs(name.v, args));
        i = end;
        continue;
      }
    }
    // callbacks.getXCallbacks() / callbacks.get(...)  (reads submitted values)
    if (isId(t, 'callbacks') && isP(toks[i + 1], '.') && toks[i + 2]?.k === 'id' && toks[i + 2]?.v !== 'isEmpty') {
      result.readsCallbacks = true;
    }
    // action.goTo(...)
    if (isId(t, 'action') && isP(toks[i + 1], '.') && isId(toks[i + 2], 'goTo') && isP(toks[i + 3], '(')) {
      const end = closing(toks, i + 3);
      scanGoTo(toks.slice(i + 4, end), scope, readers, result);
      i = end;
      continue;
    }
    // legacy: outcome = 'x'
    if (isId(t, 'outcome') && isP(toks[i + 1], '=') && toks[i + 2]?.k === 'str') {
      const v = toks[i + 2]?.v ?? '';
      if (!result.outcomes.includes(v)) result.outcomes.push(v);
    }
  }
  return result;
}

function scanGoTo(
  arg: Tok[],
  scope: Scope,
  readers: Map<string, { type: string; nth: number }>,
  result: ScriptScan,
): void {
  const add = (o: string) => {
    if (!result.outcomes.includes(o)) result.outcomes.push(o);
  };
  const first = arg[0];
  // goTo('x')
  if (arg.length === 1 && first?.k === 'str') {
    add(first.v);
    return;
  }
  result.dynamicGoTo = true;

  // goTo(ARR[V]) where V comes from a choice reader
  if (first?.k === 'id' && isP(arg[1], '[') && scope.arrays.has(first.v)) {
    const arr = scope.arrays.get(first.v) ?? [];
    for (const o of arr) add(o);
    const idx = arg[2];
    const reader = idx?.k === 'id' ? readers.get(idx.v) : undefined;
    if (reader && isP(arg[3], ']')) {
      arr.forEach((o, i) => {
        result.links[o] = { callbackType: reader.type, nth: reader.nth, value: i };
      });
    }
    return;
  }

  // goTo(cond ? 'a' : 'b')
  const q = arg.findIndex((t) => isP(t, '?'));
  const colon = arg.findIndex((t, i) => i > q && isP(t, ':'));
  if (q > 0 && colon > q) {
    const a = arg[q + 1];
    const b = arg[colon + 1];
    if (a?.k === 'str') add(a.v);
    if (b?.k === 'str') add(b.v);
    // V === K
    const v = arg[0];
    const op = arg[1];
    const k = arg[2];
    const reader = v?.k === 'id' ? readers.get(v.v) : undefined;
    if (reader && (isP(op, '===') || isP(op, '==')) && k?.k === 'num' && q === 3) {
      const kv = Number(k.v);
      if (a?.k === 'str') result.links[a.v] = { callbackType: reader.type, nth: reader.nth, value: kv };
      if (b?.k === 'str') result.links[b.v] = { callbackType: reader.type, nth: reader.nth, value: kv === 0 ? 1 : 0 };
    }
    return;
  }

  // Any other string literals inside the expression.
  for (const t of arg) if (t.k === 'str') add(t.v);
}
