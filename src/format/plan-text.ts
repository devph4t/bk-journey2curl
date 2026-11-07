import { solverLabel } from '../analyze/solvers.js';
import type { CallbackSpec, Plan, TrailEntry } from '../model/types.js';

function input(cb: CallbackSpec): string {
  const parts: string[] = [];
  for (const i of cb.inputs) {
    if (i.kind === 'fixed') continue;
    if (i.solver && i.solver !== 'totp') {
      parts.push(`solver ${i.solver}`);
      continue;
    }
    if (!i.variable) continue;
    let s = i.variable;
    if ((cb.type === 'ChoiceCallback' || cb.type === 'ConfirmationCallback') && typeof i.value === 'number') {
      const label = cb.options?.[i.value];
      s += `=${i.value}${label ? ` "${label}"` : ''}`;
    }
    if (i.solver === 'totp') s += ' / totp';
    parts.push(s);
  }
  return parts.join(', ');
}

export function callbackText(cb: CallbackSpec): string {
  const i = input(cb);
  if (cb.attribute && cb.type.endsWith('AttributeInputCallback')) return `${cb.type}(${cb.attribute})`;
  return i ? `${cb.type}(${i})` : cb.type;
}

/** Group runs of the same attribute callback: StringAttributeInputCallback ×3 (givenName, sn, mail). */
export function callbacksText(cbs: CallbackSpec[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < cbs.length; ) {
    const cb = cbs[k] as CallbackSpec;
    let j = k;
    while (cb.type.endsWith('AttributeInputCallback') && cbs[j + 1]?.type === cb.type) j++;
    if (j - k >= 2) {
      const attrs = cbs.slice(k, j + 1).map((c) => c.attribute ?? '?');
      out.push(`${cb.type} ×${j - k + 1} (${attrs.join(', ')})`);
    } else {
      for (let m = k; m <= j; m++) out.push(callbackText(cbs[m] as CallbackSpec));
    }
    k = j + 1;
  }
  return out;
}

function pathText(trail: TrailEntry[], plan: Plan): string[] {
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  const flush = () => {
    if (line.trim()) lines.push(line);
    line = '';
  };
  for (const t of trail) {
    if (t.depth !== depth) {
      if (t.depth < depth) line += 'Success';
      flush();
      depth = t.depth;
      line = `${'   '.repeat(depth)}${depth > 0 ? '↳ ' : ''}`;
    }
    line += `${t.nodeName} [${t.nodeType}] --${t.outcome}--> `;
    if (line.length > 100) {
      flush();
      line = `${'   '.repeat(depth)}${depth > 0 ? '  ' : ''}`;
    }
  }
  line += plan.target === 'success' ? 'Success' : 'Failure';
  flush();
  return lines.map((l) => `  ${l}`);
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  const extra = plan.steps.some((s) => s.kind === 'variant')
    ? ` (${plan.steps.filter((s) => s.kind === 'variant').length} variant step, solved at run time)`
    : '';
  lines.push(
    `Journey: ${plan.journey}  →  ${plan.target === 'success' ? 'Success' : 'Failure'}     coverage: ${plan.coverage.toUpperCase()}${plan.coverage === 'full' ? extra : ''}`,
  );
  if (!plan.reachable) {
    lines.push('  (no path found)');
  } else {
    lines.push('Path');
    lines.push(...pathText(plan.trail, plan));
  }
  if (plan.headers) {
    lines.push('Headers');
    for (const [h, v] of Object.entries(plan.headers)) lines.push(`  ${h}: $${v}`);
  }
  lines.push('Steps');
  if (!plan.steps.length) lines.push('  (none: no callbacks on the path)');
  for (const s of plan.steps) {
    const name =
      s.depth > 0 && s.kind !== 'variant' ? `${s.journey} / ${s.nodeName}` : s.depth > 0 ? s.journey : s.nodeName;
    const head = `  #${s.index} ${s.kind.padEnd(9)} `;
    const pad = ' '.repeat(head.length);
    if (s.kind === 'variant') {
      lines.push(`${head}${name}`);
      lines.push(`${pad}${s.nodeName} decides on the server:`);
      const w = Math.max(...(s.variants ?? []).map((v) => v.label.length));
      for (const v of s.variants ?? []) {
        const what = v.solver
          ? `${v.signature.split(',').join(', ')}   solver ${v.solver}`
          : callbacksText(v.callbacks).join(', ');
        lines.push(`${pad}· ${v.label.padEnd(w)}  ${what}`);
      }
      continue;
    }
    const cbs = callbacksText(s.callbacks);
    const label = name.length > 22 ? `${name}\n${pad}` : `${name.padEnd(22)} `;
    lines.push(`${head}${label}${cbs.join(', ')}`);
    if (s.condition) lines.push(`${pad}appears only when ${s.condition}`);
    if (s.kind === 'suspend' || s.kind === 'manual') for (const n of s.notes ?? []) lines.push(`${pad}${n}`);
  }
  const notes = [...plan.coverageNotes];
  if (notes.length) {
    lines.push('Coverage notes');
    for (const n of notes) lines.push(`  - ${n}`);
  }
  if (plan.warnings.length) {
    lines.push('Warnings');
    for (const w of plan.warnings) lines.push(`  - [${w.level}] ${w.message}`);
  }
  if (plan.inputs.length) {
    lines.push('Inputs');
    for (const i of plan.inputs) lines.push(`  ${i.variable}=${i.secret ? '***' : i.defaultValue}   ${i.description}`);
  }
  return lines.join('\n');
}

export { solverLabel };
