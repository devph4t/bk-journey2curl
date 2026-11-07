import type { BkConfig } from '../config.js';
import type { CallbackSpec, InputSpec, InputVar, Plan, Step } from '../model/types.js';

const SECRET = /PASSWORD|ANSWER|OTP|RECOVERY|SECRET|PIN|CODE/;

function defaultFor(variable: string, input: InputSpec): string {
  if (input.value !== undefined && input.value !== null) return String(input.value);
  if (input.kind === 'boolean') return 'false';
  if (input.kind === 'number') return '0';
  if (/MAIL$/.test(variable)) return 'change.me@example.com';
  return 'CHANGE_ME';
}

/**
 * Give every user-supplied input an IN_* variable, de-duplicated across the plan:
 * the same node input keeps one variable; a different node asking for the same thing gets
 * IN_NEW_PASSWORD (second password, e.g. UpdatePassword) or a numeric suffix.
 */
export function assignInputs(plan: Plan, config: BkConfig): InputVar[] {
  const owner = new Map<string, string>(); // variable -> key
  const vars = new Map<string, InputVar>();

  const visit = (step: Step, callbacks: CallbackSpec[], where: string) => {
    const ordinal = new Map<string, number>();
    callbacks.forEach((cb) => {
      const src = cb.sourceNodeId ?? step.nodeId;
      const n = ordinal.get(src) ?? 0;
      ordinal.set(src, n + 1);
      // Hidden values come from the server (or a browser script); the script sends them back unchanged.
      if (cb.type === 'HiddenValueCallback') return;
      cb.inputs.forEach((input, j) => {
        if (input.kind === 'fixed') return;
        if (input.solver && input.solver !== 'totp') return;
        const key = `${src}#${n}#${j}`;
        let base = `IN_${input.variable ?? 'VALUE'}`;
        if (
          base === 'IN_PASSWORD' &&
          cb.type === 'ValidatedCreatePasswordCallback' &&
          owner.has(base) &&
          owner.get(base) !== key
        ) {
          base = 'IN_NEW_PASSWORD';
        }
        let name = base;
        for (let k = 2; owner.has(name) && owner.get(name) !== key; k++) name = `${base}_${k}`;
        owner.set(name, key);
        input.variable = name;
        if (!vars.has(name)) {
          const configured = config.inputs?.[name];
          const v: InputVar = {
            variable: name,
            kind: input.kind,
            defaultValue: configured !== undefined ? String(configured) : defaultFor(name, input),
            description: `${cb.type}${cb.prompt ? ` "${cb.prompt}"` : ''} — ${where}`,
          };
          if (SECRET.test(name) || cb.type === 'PasswordCallback' || cb.type === 'ValidatedCreatePasswordCallback') {
            v.secret = true;
            if (configured === undefined && input.kind === 'string') v.defaultValue = 'CHANGE_ME';
          }
          vars.set(name, v);
        }
      });
    });
  };

  for (const step of plan.steps) {
    const where = `step ${step.index}, ${step.journey} / ${step.nodeName}`;
    visit(step, step.callbacks, where);
    for (const v of step.variants ?? []) visit(step, v.callbacks, `${where} (variant ${v.label})`);
  }

  if (
    plan.steps.some((s) =>
      [...s.callbacks, ...(s.variants ?? []).flatMap((v) => v.callbacks)].some((c) =>
        c.inputs.some((i) => i.solver === 'totp'),
      ),
    )
  ) {
    vars.set('IN_TOTP_SECRET', {
      variable: 'IN_TOTP_SECRET',
      kind: 'string',
      defaultValue: config.inputs?.IN_TOTP_SECRET !== undefined ? String(config.inputs.IN_TOTP_SECRET) : '',
      description: 'Base32 TOTP secret; when set the script computes the code with oathtool',
      secret: true,
    });
  }

  for (const variable of Object.values(plan.headers ?? {})) {
    if (!vars.has(variable)) {
      vars.set(variable, {
        variable,
        kind: 'string',
        defaultValue: config.inputs?.[variable] !== undefined ? String(config.inputs[variable]) : 'CHANGE_ME',
        description: 'Sent as a request header (Zero Page Login)',
        secret: /PASSWORD/.test(variable),
      });
    }
  }
  return [...vars.values()];
}
