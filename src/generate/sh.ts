import { signature } from '../analyze/catalog/callbacks.js';
import type { CallbackSpec, Plan, Step, Variant } from '../model/types.js';
import { render } from '../templates/index.js';
import { safeFileName } from './paths.js';

export interface ShOptions {
  tenant?: string;
  realm?: string;
  /** Export file name, written in the header comment. */
  source?: string;
  /** Plan of the journey that creates the session (--with-session). */
  sessionPlan?: Plan;
}

/** Quote for a bash single-quoted string. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape for use inside a bash double-quoted string. */
function dq(s: string): string {
  return s.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

const comment = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 140);

/** Bash lines that fill the inputs of a set of callbacks. */
function fillLines(callbacks: CallbackSpec[], indent: string): string[] {
  const lines: string[] = [];
  callbacks.forEach((cb, i) => {
    cb.inputs.forEach((input, j) => {
      if (input.kind === 'fixed') return;
      if (input.solver === 'totp') {
        lines.push(`${indent}set_str ${i} ${j} "$(otp_code)"`);
      } else if (input.jq) {
        lines.push(`${indent}set_jq ${i} ${j} ${shq(input.jq)}   # solver ${input.solver ?? 'custom'}`);
      } else if (input.variable) {
        const fn = input.kind === 'string' ? 'set_str' : 'set_json';
        lines.push(`${indent}${fn} ${i} ${j} "$${input.variable}"`);
      }
    });
  });
  return lines;
}

function stepBody(step: Step, n: string, indent: string, variant?: Variant): string[] {
  const kind = variant?.kind ?? step.kind;
  const callbacks = variant?.callbacks ?? step.callbacks;
  const notes = variant?.notes ?? step.notes ?? [];
  if (kind === 'suspend') return [`${indent}suspended ${n}`];
  if (kind === 'manual') return [`${indent}manual ${n} ${shq(notes[0] ?? 'finish this step in a browser')}`];
  const lines = fillLines(callbacks, indent);
  lines.push(`${indent}submit`);
  if (kind === 'poll') lines.push(`${indent}poll`);
  return lines;
}

function stepFunction(step: Step, prefix = ''): string {
  const n = `${prefix}${step.index}`;
  const title = step.depth > 0 ? `${step.journey} / ${step.nodeName}` : step.nodeName;
  const out: string[] = [];
  out.push(`# Step ${n} – ${step.kind}: ${comment(title)}`);
  out.push(`#   ${comment(step.plainText)}`);
  out.push(`step_${n}() {`);

  if (step.kind === 'variant') {
    const vs = step.variants ?? [];
    out.push('  case "$(types)" in');
    for (const v of vs) {
      const prompt = v.callbacks.find((c) => c.prompt)?.prompt;
      out.push(`    ${shq(v.signature)})   # ${v.label}${prompt ? `: ${comment(prompt)}` : ''}`);
      out.push(...stepBody(step, n, '      ', v));
      out[out.length - 1] += ' ;;';
    }
    out.push(`    *) unexpected ${n} ${shq(vs.map((v) => v.signature).join(' | '))} ;;`);
    out.push('  esac');
  } else if (step.kind === 'optional') {
    const sig = signature(step.callbacks);
    out.push(`  if [[ "$(types)" == ${shq(sig)} ]]; then`);
    out.push(...fillLines(step.callbacks, '    '));
    out.push('    submit');
    out.push('  else');
    out.push(
      `    log "step ${n} skipped (optional${step.condition ? `: only when ${dq(comment(step.condition))}` : ''})"`,
    );
    out.push('  fi');
  } else {
    out.push(`  check ${n} ${shq(signature(step.callbacks))}`);
    out.push(...stepBody(step, n, '  '));
  }
  out.push('}');
  return out.join('\n');
}

function sessionBlock(session: Plan): { code: string; call: string } {
  const fns = session.steps.map((s) => stepFunction(s, 's')).join('\n\n');
  const calls = session.steps.map((s) => `  step_s${s.index}`).join('\n');
  const code = `# ---- session: run ${session.journey} first (--with-session) -------------------------------------
${fns}

run_session() {
  local main_url="$URL"
  URL="$(auth_url ${shq(encodeURIComponent(session.journey))})"
  RESP="$(post '{}')"
${calls || '  :'}
  if ! done_ok; then say "✘ session journey ${dq(session.journey)} did not succeed"; finish; fi
  say "✔ session from ${dq(session.journey)}"
  URL="$main_url"
}
`;
  return { code, call: 'run_session' };
}

/** Render the bash script for one plan. */
export function generateSh(plan: Plan, opts: ShOptions = {}): string {
  const usesTotp = [plan, opts.sessionPlan].some((p) =>
    p?.steps.some((s) =>
      [...s.callbacks, ...(s.variants ?? []).flatMap((v) => v.callbacks)].some((c) =>
        c.inputs.some((i) => i.solver === 'totp'),
      ),
    ),
  );
  const inputs = new Map<string, { variable: string; value: string; description: string }>();
  for (const p of [opts.sessionPlan, plan]) {
    for (const v of p?.inputs ?? []) {
      if (!inputs.has(v.variable)) {
        inputs.set(v.variable, {
          variable: v.variable,
          value: dq(v.defaultValue),
          description: comment(v.description),
        });
      }
    }
  }
  const suspendIdx = plan.steps.findIndex(
    (s) =>
      s.kind === 'suspend' ||
      (s.kind === 'optional' && s.callbacks.some((c) => c.type === 'SuspendedTextOutputCallback')),
  );
  const variantSuspend = plan.steps.findIndex((s) => s.variants?.some((v) => v.kind === 'suspend'));
  const firstSuspend = [suspendIdx, variantSuspend].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  const resumeStep = firstSuspend !== undefined ? (plan.steps[firstSuspend]?.index ?? 0) + 1 : 0;

  const firstHeaders = Object.entries(plan.headers ?? {})
    .map(([h, v]) => ` -H "${dq(h)}: $${v}"`)
    .join('');

  const session = opts.sessionPlan ? sessionBlock(opts.sessionPlan) : undefined;
  const text = render('script.sh.eta', {
    journey: plan.journey,
    journeyQuoted: shq(plan.journey),
    journeyParam: shq(encodeURIComponent(plan.journey)),
    fileName: `${safeFileName(plan.journey)}.sh`,
    source: opts.source ?? 'a journey export',
    target: plan.target,
    coverage: plan.coverage.toUpperCase(),
    coverageNotes: plan.coverageNotes.map(comment),
    stepCount: plan.steps.length,
    tenant: dq(opts.tenant ?? 'https://CHANGE_ME.forgeblocks.com'),
    realm: dq(opts.realm ?? 'alpha'),
    inputs: [...inputs.values()],
    usesTotp,
    resumeStep,
    firstHeaders,
    stepsCode: plan.steps.map((s) => stepFunction(s)).join('\n\n') + (plan.steps.length ? '\n' : ''),
    sessionCode: session?.code ?? '',
    sessionCall: session?.call ?? '',
  });
  return text.replace(/\n{3,}/g, '\n\n');
}
