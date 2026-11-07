import type { BkConfig, CustomSolver } from '../config.js';
import type { CallbackSpec, Plan, Step } from '../model/types.js';

/**
 * Solvers turn a received callback into an input value at run time. Each one is a jq expression
 * evaluated against the last response, so the generated bash only needs curl and jq.
 */
export interface SolverMatch {
  callback: number;
  input: number;
  jq: string;
}

export interface Solver {
  id: string;
  label: string;
  match(callbacks: CallbackSpec[]): SolverMatch[] | undefined;
}

const out = (k: number, name: string) => `.callbacks[${k}].output[] | select(.name == "${name}") | .value`;

const hasPlaceholder = (s?: string) => !!s && /\{[^}]+\}/.test(s);

export const BUILTIN_SOLVERS: Solver[] = [
  {
    id: 'math-sum',
    label: 'adds the two numbers in the prompt',
    match(cbs) {
      const k = cbs.findIndex(
        (c) => c.type === 'NameCallback' && /(\{[^}]+\}|\d+)\s*\+\s*(\{[^}]+\}|\d+)/.test(c.prompt ?? ''),
      );
      if (k < 0) return undefined;
      return [
        {
          callback: k,
          input: 0,
          jq: `(${out(k, 'prompt')} | capture("(?<a>-?[0-9]+) *[+] *(?<b>-?[0-9]+)") | (.a | tonumber) + (.b | tonumber) | tostring)`,
        },
      ];
    },
  },
  {
    id: 'echo-text',
    label: 'copies the last word of the message',
    match(cbs) {
      const k = cbs.findIndex(
        (c, i) => c.type === 'TextOutputCallback' && hasPlaceholder(c.prompt) && cbs[i + 1]?.type === 'NameCallback',
      );
      if (k < 0) return undefined;
      return [{ callback: k + 1, input: 0, jq: `(${out(k, 'message')} | split(" ") | last)` }];
    },
  },
  {
    id: 'echo-hidden',
    label: 'sends back the hidden value',
    match(cbs) {
      const k = cbs.findIndex((c, i) => c.type === 'HiddenValueCallback' && cbs[i + 1]?.type === 'PasswordCallback');
      if (k < 0) return undefined;
      return [{ callback: k + 1, input: 0, jq: `(${out(k, 'value')})` }];
    },
  },
];

export function solverLabel(id: string): string {
  if (id === 'totp') return 'current TOTP code from IN_TOTP_SECRET (or IN_OTP)';
  if (id === 'env') return 'value of an IN_* environment variable';
  return BUILTIN_SOLVERS.find((s) => s.id === id)?.label ?? 'custom jq expression';
}

function customFor(step: Step, solvers: CustomSolver[], nodeIdOf: (cb: CallbackSpec) => string | undefined) {
  return solvers.filter((s) => {
    if (s.journey && s.journey !== step.journey) return false;
    const n = s.node.toLowerCase();
    return (
      step.nodeName.toLowerCase() === n ||
      step.nodeId === s.node ||
      step.callbacks.some((c) => nodeIdOf(c) === s.node) ||
      (step.variants ?? []).some((v) => v.nodeName?.toLowerCase() === n || v.nodeId === s.node)
    );
  });
}

function applyTo(callbacks: CallbackSpec[], origin: 'script' | 'any'): string | undefined {
  if (origin === 'script' && !callbacks.some((c) => c.origin === 'script')) return undefined;
  for (const solver of BUILTIN_SOLVERS) {
    const m = solver.match(callbacks);
    if (!m) continue;
    for (const { callback, input, jq } of m) {
      const inp = callbacks[callback]?.inputs[input];
      if (inp) {
        inp.solver = solver.id;
        inp.jq = jq;
      }
    }
    return solver.id;
  }
  return undefined;
}

/** Mark inputs that are computed at run time (builtin solvers on scripted callbacks, plus custom solvers). */
export function applySolvers(plan: Plan, config: BkConfig): void {
  const custom = config.solvers ?? [];
  for (const step of plan.steps) {
    applyTo(step.callbacks, 'script');
    for (const v of step.variants ?? []) {
      const id = applyTo(v.callbacks, 'script');
      if (id) v.solver = id;
    }
    for (const c of customFor(step, custom, (cb) => cb.sourceNodeId)) {
      const targets = step.variants?.length
        ? step.variants.filter(
            (v) => !c.node || v.nodeName?.toLowerCase() === c.node.toLowerCase() || v.nodeId === c.node,
          )
        : [step];
      for (const t of targets) {
        const cbIndex = c.callback ?? t.callbacks.findIndex((cb) => cb.inputs.some((i) => i.kind !== 'fixed'));
        const inp = t.callbacks[cbIndex]?.inputs[c.input ?? 0];
        if (inp) {
          inp.solver = c.label ?? 'custom';
          inp.jq = `(${c.jq})`;
          if ('label' in t && 'signature' in t) t.solver = c.label ?? 'custom';
        }
      }
    }
  }
}
