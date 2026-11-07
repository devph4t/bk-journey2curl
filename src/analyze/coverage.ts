import type { Coverage, Plan } from '../model/types.js';

/**
 * - full: the generated script can run the whole path on its own (variants solved at run time).
 * - partial: it runs, but stops or needs something extra (email link, session, OTP secret, unknown nodes).
 * - manual: a step needs a person (WebAuthn, QR registration) or no path was found.
 */
export function computeCoverage(plan: Plan): { coverage: Coverage; notes: string[] } {
  const notes: string[] = [];
  if (!plan.reachable) return { coverage: 'manual', notes: ['No path to the target was found'] };

  const manual = plan.steps.filter((s) => s.kind === 'manual');
  if (manual.length) {
    notes.push(...manual.map((s) => `Step ${s.index} (${s.nodeName}) needs a person: ${s.notes?.[0] ?? s.nodeType}`));
    return { coverage: 'manual', notes };
  }

  for (const s of plan.steps) {
    if (s.kind === 'suspend') notes.push(`Stops at step ${s.index} (${s.nodeName}) until the email link is opened`);
    for (const v of s.variants ?? []) {
      if (v.kind === 'suspend') notes.push(`Step ${s.index} may stop for an email link (variant ${v.label})`);
      if (v.kind === 'manual') notes.push(`Step ${s.index} variant ${v.label} needs a person`);
    }
    const all = [...s.callbacks, ...(s.variants ?? []).flatMap((v) => v.callbacks)];
    if (all.some((c) => c.inputs.some((i) => i.solver === 'totp'))) {
      notes.push(`Step ${s.index} needs IN_TOTP_SECRET or IN_OTP (one-time code)`);
    }
    if (s.nodeType === 'RecoveryCodeCollectorDecisionNode') notes.push(`Step ${s.index} needs a recovery code`);
  }
  if (plan.needsSession && !plan.withSession)
    notes.push('Needs an existing session: generate with --with-session Login');
  if (plan.unknownTypes.length) notes.push(`Unknown node types on the path: ${plan.unknownTypes.join(', ')}`);
  for (const w of plan.warnings) {
    if (['missing-journey', 'inner-depth', 'missing-script', 'variant-ambiguous'].includes(w.code))
      notes.push(w.message);
  }
  return { coverage: notes.length ? 'partial' : 'full', notes };
}
