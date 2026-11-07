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
  /** Library scripts followed through require('...'). */
  libraries: string[];
  /** require('...') names not found in the export. */
  missingLibraries: string[];
  /** lib.fn names that were called but not found in the library. */
  missingFunctions: string[];
  /** Some callbacks are built inside a loop: their number depends on run-time data. */
  builtInLoop: boolean;
  /** Some callbacks are built only under a condition (besides the usual callbacks.isEmpty() split). */
  builtConditionally: boolean;
  /** Callbacks were found but could not be ordered (no call path from the top level). */
  unordered: boolean;
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
  const type = Object.hasOwn(READER_TYPES, fn) ? READER_TYPES[fn] : undefined;
  if (!type) return undefined;
  if (!isP(toks[i + 3], '(') || !isP(toks[i + 4], ')') || !isP(toks[i + 5], '.') || !isId(toks[i + 6], 'get'))
    return undefined;
  const nth = Number(toks[i + 8]?.v ?? 0);
  return { type, nth: Number.isFinite(nth) ? nth : 0 };
}

/** Where library sources come from: `require('name')` -> source, or undefined when not in the export. */
export interface ScanContext {
  library?: (name: string) => string | undefined;
}

interface FnDef {
  params: string[];
  /** Index of the body's `{` and its matching `}`. */
  open: number;
  close: number;
}

interface Unit {
  name: string;
  toks: Tok[];
  scope: Scope;
  fns: Map<string, FnDef>;
  /** `{` indexes that start a function body (skipped when walking the code around them). */
  bodies: Map<number, number>;
  /** var -> library name, for `var lib = require('Lib')`. */
  requires: Map<string, string>;
  /** local name -> library function, for `const { ask } = require('Lib')`. */
  imported: Map<string, { lib: string; fn: string }>;
  /** Builder-call index -> built inside a loop / a condition. */
  flags: Map<number, { loop: boolean; conditional: boolean }>;
}

const NOT_FUNCTION_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new']);

/** Index of the `(` matching the `)` at `close`. */
function opener(toks: Tok[], close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (isP(toks[i], ')')) depth++;
    else if (isP(toks[i], '(')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function paramsAt(toks: Tok[], open: number): string[] {
  const close = closing(toks, open);
  return splitArgs(toks.slice(open + 1, close)).flatMap((a) => (a[0]?.k === 'id' ? [a[0].v] : []));
}

function findFunctions(toks: Tok[]): { fns: Map<string, FnDef>; bodies: Map<number, number> } {
  const fns = new Map<string, FnDef>();
  const bodies = new Map<number, number>();
  const add = (name: string | undefined, paren: number) => {
    const closeParen = closing(toks, paren);
    let open = closeParen + 1;
    if (isP(toks[open], '=>')) open++;
    if (!isP(toks[open], '{')) return;
    const close = closing(toks, open);
    // Only named functions run "later, when called"; an anonymous function passed as an argument
    // (xs.forEach(function (x) { ... })) is walked where it appears.
    if (!name) return;
    bodies.set(open, close);
    if (!fns.has(name)) fns.set(name, { params: paramsAt(toks, paren), open, close });
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // function name(...) { }   |   function (...) { }
    if (isId(t, 'function')) {
      const named = toks[i + 1]?.k === 'id' ? toks[i + 1] : undefined;
      const paren = named ? i + 2 : i + 1;
      if (!isP(toks[paren], '(')) continue;
      // name = function (...)  |  name: function (...)  |  exports.name = function (...)
      const assigned = isP(toks[i - 1], '=') || isP(toks[i - 1], ':') ? toks[i - 2] : undefined;
      add(named?.v ?? (assigned?.k === 'id' ? assigned.v : undefined), paren);
      continue;
    }
    // name = (...) => { }   |   name: (a) => { }   |   name = a => { }
    if (t?.k === 'id' && (isP(toks[i + 1], '=') || isP(toks[i + 1], ':'))) {
      const p = i + 2;
      if (isP(toks[p], '(')) {
        const after = closing(toks, p) + 1;
        if (isP(toks[after], '=>')) add(t.v, p);
      } else if (toks[p]?.k === 'id' && isP(toks[p + 1], '=>') && isP(toks[p + 2], '{')) {
        const close = closing(toks, p + 2);
        bodies.set(p + 2, close);
        if (!fns.has(t.v)) fns.set(t.v, { params: [toks[p]?.v ?? ''], open: p + 2, close });
      }
      continue;
    }
    // Object shorthand method:  { ask(cb, label) { } }
    if (
      t?.k === 'id' &&
      !NOT_FUNCTION_NAMES.has(t.v) &&
      isP(toks[i + 1], '(') &&
      (isP(toks[i - 1], '{') || isP(toks[i - 1], ','))
    ) {
      const after = closing(toks, i + 1) + 1;
      if (isP(toks[after], '{')) add(t.v, i + 1);
    }
  }
  return { fns, bodies };
}

function findRequires(toks: Tok[]): Pick<Unit, 'requires' | 'imported'> {
  const requires = new Map<string, string>();
  const imported = new Map<string, { lib: string; fn: string }>();
  for (let i = 0; i < toks.length; i++) {
    if (!isId(toks[i], 'require') || !isP(toks[i + 1], '(') || toks[i + 2]?.k !== 'str' || !isP(toks[i - 1], '=')) {
      continue;
    }
    const lib = toks[i + 2]?.v ?? '';
    const target = toks[i - 2];
    if (target?.k === 'id') requires.set(target.v, lib);
    else if (isP(target, '}')) {
      // const { a, b: c } = require('Lib')
      let j = i - 3;
      while (j >= 0 && !isP(toks[j], '{')) j--;
      for (const part of splitArgs(toks.slice(j + 1, i - 2))) {
        const fn = part[0]?.v;
        const local = isP(part[1], ':') ? part[2]?.v : fn;
        if (fn && local) imported.set(local, { lib, fn });
      }
    }
  }
  return { requires, imported };
}

const isBuilderMethod = (toks: Tok[], i: number) =>
  isP(toks[i - 1], '.') &&
  toks[i]?.k === 'id' &&
  Object.hasOwn(BUILDER_TYPES, toks[i]?.v ?? '') &&
  isP(toks[i + 1], '(');

/** `xs.forEach(function (x) { cb.nameCallback(x) })`: a builder call inside a function passed to forEach/map. */
function insideIteration(toks: Tok[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = toks[j];
    if (isP(t, ')') || isP(t, '}') || isP(t, ']')) depth++;
    else if (isP(t, '(') || isP(t, '{') || isP(t, '[')) {
      if (depth > 0) depth--;
      else if (isP(t, '(') && (isId(toks[j - 1], 'forEach') || isId(toks[j - 1], 'map'))) return true;
    }
  }
  return false;
}

/** Mark builder calls that sit inside a loop or a condition (other than the usual `callbacks.isEmpty()` split). */
function blockFlags(toks: Tok[]): Unit['flags'] {
  const flags: Unit['flags'] = new Map();
  type Kind = 'loop' | 'cond' | 'send' | 'other';
  const stack: Kind[] = [];
  let lastIf: Kind = 'other';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isP(t, '{')) {
      let kind: Kind = 'other';
      const prev = toks[i - 1];
      if (isP(prev, ')')) {
        const o = opener(toks, i - 1);
        const kw = toks[o - 1];
        if (isId(kw, 'for') || isId(kw, 'while')) kind = 'loop';
        else if (isId(kw, 'if')) kind = toks.slice(o, i - 1).some((x) => isId(x, 'isEmpty')) ? 'send' : 'cond';
        else if (isId(kw, 'switch')) kind = 'cond';
      } else if (isId(prev, 'else')) kind = lastIf === 'send' ? 'other' : 'cond';
      else if (isId(prev, 'do')) kind = 'loop';
      stack.push(kind);
      continue;
    }
    if (isP(t, '}')) {
      const k = stack.pop();
      if (k === 'send' || k === 'cond') lastIf = k;
      continue;
    }
    if (isBuilderMethod(toks, i)) {
      flags.set(i, {
        loop: stack.includes('loop') || insideIteration(toks, i),
        conditional: stack.includes('cond'),
      });
    }
  }
  return flags;
}

function parseUnit(name: string, source: string): Unit {
  const toks = tokenize(source);
  return {
    name,
    toks,
    scope: collectScope(toks),
    ...findFunctions(toks),
    ...findRequires(toks),
    flags: blockFlags(toks),
  };
}

function childScope(scope: Scope, params: string[], args: unknown[]): Scope {
  const s: Scope = { arrays: new Map(scope.arrays), strings: new Map(scope.strings) };
  params.forEach((p, k) => {
    const v = args[k];
    s.arrays.delete(p);
    s.strings.delete(p);
    if (Array.isArray(v)) s.arrays.set(p, v as string[]);
    else if (typeof v === 'string') s.strings.set(p, v);
  });
  return s;
}

class CallbackWalker {
  readonly callbacks: ScannedCallback[] = [];
  readonly libraries = new Set<string>();
  readonly missingLibraries = new Set<string>();
  readonly missingFunctions = new Set<string>();
  loop = false;
  conditional = false;
  private readonly units = new Map<string, Unit | null>();

  constructor(private readonly ctx: ScanContext) {}

  private library(name: string): Unit | undefined {
    if (!this.units.has(name)) {
      const src = this.ctx.library?.(name);
      this.units.set(name, src === undefined ? null : parseUnit(name, src));
      if (src === undefined) this.missingLibraries.add(name);
      else this.libraries.add(name);
    }
    return this.units.get(name) ?? undefined;
  }

  private callLibrary(lib: string, fn: string, args: unknown[], depth: number, conditional: boolean): void {
    const unit = this.library(lib);
    if (!unit) return;
    const def = unit.fns.get(fn);
    if (!def) {
      this.missingFunctions.add(`${lib}.${fn}`);
      return;
    }
    this.walk(unit, def.open + 1, def.close, childScope(unit.scope, def.params, args), depth + 1, conditional);
  }

  /** Walk tokens [start, end) in execution order, following local functions and library calls. */
  walk(u: Unit, start: number, end: number, scope: Scope, depth = 0, conditionalCall = false): void {
    if (depth > 8) return;
    const argsAt = (paren: number) => {
      const close = closing(u.toks, paren);
      return { close, args: splitArgs(u.toks.slice(paren + 1, close)).map((a) => evalArg(a, scope)) };
    };
    for (let i = start; i < end; i++) {
      const skip = u.bodies.get(i);
      if (skip !== undefined) {
        i = skip;
        continue;
      }
      const t = u.toks[i];

      // <anything>.nameCallback(...)  (callbacksBuilder, an alias or a parameter)
      if (isBuilderMethod(u.toks, i)) {
        const fn = t?.v ?? '';
        const { close, args } = argsAt(i + 1);
        this.callbacks.push(callbackFromArgs(BUILDER_TYPES[fn] ?? fn, args));
        const f = u.flags.get(i);
        if (f?.loop) this.loop = true;
        if (f?.conditional || conditionalCall) this.conditional = true;
        i = close;
        continue;
      }
      // new [pkg.]FooCallback(...)  (legacy)
      if (isId(t, 'new')) {
        let j = i + 1;
        while (u.toks[j + 1] && isP(u.toks[j + 1], '.') && u.toks[j + 2]?.k === 'id') j += 2;
        const name = u.toks[j];
        if (name?.k === 'id' && name.v.endsWith('Callback') && isP(u.toks[j + 1], '(')) {
          const { close, args } = argsAt(j + 1);
          this.callbacks.push(callbackFromArgs(name.v, args));
          i = close;
          continue;
        }
      }
      if (t?.k !== 'id' || isP(u.toks[i - 1], '.') || isId(u.toks[i - 1], 'function')) continue;
      const conditionalHere = conditionalCall || this.callIsConditional(u, i);

      // lib.fn(...)
      const lib = u.requires.get(t.v);
      if (lib && isP(u.toks[i + 1], '.') && u.toks[i + 2]?.k === 'id' && isP(u.toks[i + 3], '(')) {
        const { close, args } = argsAt(i + 3);
        this.callLibrary(lib, u.toks[i + 2]?.v ?? '', args, depth, conditionalHere);
        i = close;
        continue;
      }
      if (!isP(u.toks[i + 1], '(')) continue;
      // fn(...) from const { fn } = require('Lib')
      const imp = u.imported.get(t.v);
      if (imp) {
        const { close, args } = argsAt(i + 1);
        this.callLibrary(imp.lib, imp.fn, args, depth, conditionalHere);
        i = close;
        continue;
      }
      // localFunction(...)
      const def = u.fns.get(t.v);
      if (def && !(i > def.open && i < def.close)) {
        const { close, args } = argsAt(i + 1);
        this.walk(u, def.open + 1, def.close, childScope(scope, def.params, args), depth + 1, conditionalHere);
        i = close;
      }
    }
  }

  /** A call site inside a condition or loop (other than the callbacks.isEmpty() split). */
  private callIsConditional(u: Unit, i: number): boolean {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      const t = u.toks[j];
      if (isP(t, '}')) depth++;
      else if (isP(t, '{')) {
        if (depth > 0) {
          depth--;
          continue;
        }
        if (u.bodies.has(j)) return false;
        const prev = u.toks[j - 1];
        if (isP(prev, ')')) {
          const o = opener(u.toks, j - 1);
          const kw = u.toks[o - 1];
          if (isId(kw, 'if') && !u.toks.slice(o, j - 1).some((x) => isId(x, 'isEmpty'))) return true;
          if (isId(kw, 'for') || isId(kw, 'while') || isId(kw, 'switch')) return true;
        }
      }
    }
    return false;
  }
}

export function scanScript(source: string, ctx: ScanContext = {}): ScriptScan {
  const unit = parseUnit('(node script)', source);
  const { toks, scope } = unit;
  const readers = readerVars(toks);
  const walker = new CallbackWalker(ctx);
  walker.walk(unit, 0, toks.length, scope);

  const result: ScriptScan = {
    callbacks: walker.callbacks,
    readsCallbacks: false,
    outcomes: [],
    dynamicGoTo: false,
    links: {},
    usesRandom: /Math\s*\.\s*random/.test(source),
    libraries: [...walker.libraries],
    missingLibraries: [...walker.missingLibraries],
    missingFunctions: [...walker.missingFunctions],
    builtInLoop: walker.loop,
    builtConditionally: walker.conditional,
    unordered: false,
  };

  // Builder calls exist but none is reachable from the top level (e.g. a function that is never called
  // directly): keep them in source order and say so.
  if (!result.callbacks.length) {
    for (let i = 0; i < toks.length; i++) {
      if (!isBuilderMethod(toks, i)) continue;
      const close = closing(toks, i + 1);
      const args = splitArgs(toks.slice(i + 2, close)).map((a) => evalArg(a, scope));
      result.callbacks.push(callbackFromArgs(BUILDER_TYPES[toks[i]?.v ?? ''] ?? '', args));
      result.unordered = true;
      i = close;
    }
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
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
