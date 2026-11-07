import { signature } from '../analyze/catalog/callbacks.js';
import { solverLabel } from '../analyze/solvers.js';
import type { CallbackSpec, InputSpec, Plan, Step } from '../model/types.js';

export interface RunbookOptions {
  tenant?: string;
  realm?: string;
  source?: string;
  sessionJourney?: string;
}

export function realmPath(realm = 'alpha'): string {
  const r = realm.replace(/^\/+|\/+$/g, '');
  if (!r || r === 'root') return 'realms/root';
  return `realms/root/${r
    .split('/')
    .map((p) => `realms/${p}`)
    .join('/')}`;
}

type Output = { name: string; value: unknown };

/** The output array the server sends for a callback, as far as the plan knows it. */
function outputs(cb: CallbackSpec): Output[] {
  const p = cb.prompt ?? '';
  switch (cb.type) {
    case 'TextOutputCallback':
      return [
        { name: 'message', value: p },
        { name: 'messageType', value: '0' },
      ];
    case 'SuspendedTextOutputCallback':
      return [
        { name: 'message', value: p },
        { name: 'messageType', value: '0' },
      ];
    case 'ChoiceCallback':
      return [
        { name: 'prompt', value: p },
        { name: 'choices', value: cb.options ?? [] },
        { name: 'defaultChoice', value: 0 },
      ];
    case 'ConfirmationCallback':
      return [
        { name: 'prompt', value: p },
        { name: 'messageType', value: 0 },
        { name: 'options', value: cb.options ?? [] },
        { name: 'optionType', value: -1 },
        { name: 'defaultOption', value: 0 },
      ];
    case 'HiddenValueCallback':
      return [
        { name: 'value', value: '<value from the server>' },
        { name: 'id', value: p },
      ];
    case 'StringAttributeInputCallback':
    case 'BooleanAttributeInputCallback':
    case 'NumberAttributeInputCallback':
      return [
        { name: 'name', value: cb.attribute ?? p },
        { name: 'prompt', value: cb.attribute ?? p },
        { name: 'required', value: true },
      ];
    case 'PollingWaitCallback':
      return [
        { name: 'waitTime', value: '5000' },
        { name: 'message', value: p },
      ];
    default:
      return p ? [{ name: 'prompt', value: p }] : [];
  }
}

function inputValue(input: InputSpec, plan: Plan): unknown {
  if (input.kind === 'fixed') return input.value;
  if (input.solver && input.solver !== 'totp') return `<computed: ${input.solver}>`;
  if (input.solver === 'totp') return '<current one-time code>';
  if (!input.variable) return input.value ?? '<value from the server>';
  if (input.kind === 'string') return `<${input.variable}>`;
  const def = plan.inputs.find((i) => i.variable === input.variable)?.defaultValue ?? String(input.value ?? '');
  try {
    return JSON.parse(def);
  } catch {
    return `<${input.variable}>`;
  }
}

function body(callbacks: CallbackSpec[], plan: Plan, authFrom: string): string {
  // One callback per line keeps the body readable (design §6.5).
  const cbs = callbacks.map((cb) =>
    JSON.stringify({
      type: cb.type,
      output: outputs(cb),
      input: cb.inputs.map((i) => ({ name: i.name, value: inputValue(i, plan) })),
    }),
  );
  return `{"authId":${JSON.stringify(`<authId from ${authFrom}>`)},"callbacks":[\n    ${cbs.join(',\n    ')}]}`;
}

function curl(url: string, json: string, headers: string[] = []): string {
  const lines = [
    `curl -X POST "${url}" \\`,
    `  -H "Content-Type: application/json" -H "Accept-API-Version: resource=2.0, protocol=1.0" \\`,
  ];
  for (const h of headers) lines.push(`  -H "${h}" \\`);
  lines.push('  -b cookies.txt -c cookies.txt \\');
  lines.push(`  -d '${json.replace(/'/g, `'\\''`)}'`);
  return lines.join('\n');
}

function code(lang: string, text: string): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

function inputsTable(cbs: CallbackSpec[]): string {
  const rows: string[] = [];
  for (const cb of cbs) {
    for (const i of cb.inputs) {
      if (i.kind === 'fixed') continue;
      const how = i.solver ? solverLabel(i.solver) : i.variable ? `\`${i.variable}\`` : 'sent back unchanged';
      rows.push(`| \`${i.name}\` | ${cb.type}${cb.prompt ? ` "${md(cb.prompt)}"` : ''} | ${how} |`);
    }
  }
  if (!rows.length) return '_No inputs: post the response back as received._';
  return ['| Input | Callback | Value |', '| --- | --- | --- |', ...rows].join('\n');
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function expectedAfter(plan: Plan, idx: number): string {
  const next = plan.steps[idx + 1];
  const end =
    plan.target === 'success' ? '`tokenId` (journey finished: Success)' : 'HTTP 401 (journey finished: Failure)';
  if (!next) return end;
  if (next.kind === 'variant') return (next.variants ?? []).map((v) => `\`${v.signature}\` (${v.label})`).join(' or ');
  const sig = `\`${signature(next.callbacks)}\``;
  if (next.kind === 'optional') return `${sig} (optional step ${next.index}) or ${expectedAfter(plan, idx + 1)}`;
  return sig;
}

function stepSection(plan: Plan, step: Step, idx: number, url: string): string {
  const out: string[] = [];
  const where = step.depth > 0 ? `${step.journey} / ${step.nodeName}` : step.nodeName;
  out.push(`## Step ${step.index} – ${where} (${step.kind})`);
  out.push('');
  out.push(`> ${step.plainText}`);
  out.push('');
  if (step.condition)
    out.push(
      `**Optional:** appears only when ${step.condition}. If the response has other callbacks, skip this step.\n`,
    );
  const prev = idx === 0 ? 'the start call' : `step ${step.index - 1}`;

  if (step.kind === 'variant') {
    out.push(
      `${step.notes?.[0] ?? 'The server decides at run time'}, so it sends one of these. Match the callback types you received:`,
    );
    out.push('');
    for (const v of step.variants ?? []) {
      out.push(`### Variant \`${v.label}\` – \`${v.signature}\`${v.solver ? ` – ${solverLabel(v.solver)}` : ''}`);
      out.push('');
      if (v.kind === 'suspend') {
        out.push(
          'The journey is suspended and an email was sent. Open the link from the email, or take its `suspendedId` and continue with:',
        );
        out.push('');
        out.push(code('bash', curl(`${url}&suspendedId=<suspendedId>`, '{}')));
        out.push('');
        continue;
      }
      if (v.kind === 'manual') {
        out.push(`Needs a person: ${v.notes?.[0] ?? 'finish in a browser'}.`);
        out.push('');
        continue;
      }
      out.push(inputsTable(v.callbacks));
      out.push('');
      out.push(code('bash', curl(url, body(v.callbacks, plan, prev))));
      out.push('');
    }
  } else if (step.kind === 'suspend') {
    out.push('The server answers with a `SuspendedTextOutputCallback` and sends an email. Nothing to post here.');
    out.push('');
    out.push(`To continue, open the link from the email, or take its \`suspendedId\` and start again with:`);
    out.push('');
    out.push(code('bash', curl(`${url}&suspendedId=<suspendedId>`, '{}')));
    out.push('');
  } else if (step.kind === 'manual') {
    out.push(`**Manual:** ${step.notes?.[0] ?? 'finish this step in a browser'}.`);
    out.push('');
    out.push(`Callbacks received: \`${signature(step.callbacks)}\``);
    out.push('');
  } else {
    out.push(inputsTable(step.callbacks));
    out.push('');
    out.push(code('bash', curl(url, body(step.callbacks, plan, prev))));
    out.push('');
  }
  for (const n of step.notes ?? []) if (step.kind !== 'variant' && step.kind !== 'manual') out.push(`- ${n}`);
  if (step.notes?.length && step.kind !== 'variant' && step.kind !== 'manual') out.push('');
  out.push(`**Expected next:** ${expectedAfter(plan, idx)}`);
  return out.join('\n');
}

/** Render `<journey>.runbook.md`: every step as a literal curl with the expected body and response. */
export function generateRunbook(plan: Plan, opts: RunbookOptions = {}): string {
  const tenant = opts.tenant ?? 'https://CHANGE_ME.forgeblocks.com';
  const url = `$TENANT/am/json/${realmPath(opts.realm)}/authenticate?authIndexType=service&authIndexValue=${encodeURIComponent(plan.journey)}`;
  const out: string[] = [];
  out.push(`# ${plan.journey} – runbook`);
  out.push('');
  out.push(
    `Generated by bkj2c from \`${opts.source ?? 'a journey export'}\`. Target: **${plan.target === 'success' ? 'Success' : 'Failure'}** · Coverage: **${plan.coverage.toUpperCase()}** · Steps: **${plan.steps.length}**`,
  );
  out.push('');
  for (const n of plan.coverageNotes) out.push(`- ${n}`);
  if (plan.coverageNotes.length) out.push('');
  out.push('## Setup');
  out.push('');
  out.push(
    code(
      'bash',
      `export TENANT=${tenant}\nrm -f cookies.txt   # one cookie jar per run keeps the session and load-balancer affinity`,
    ),
  );
  out.push('');
  out.push(
    'Each call posts back the whole previous response (`authId` plus `callbacks`) with the `input` values filled in.',
  );
  out.push('');
  if (plan.inputs.length) {
    out.push('| Variable | Default | Used for |');
    out.push('| --- | --- | --- |');
    for (const i of plan.inputs)
      out.push(
        `| \`${i.variable}\` | ${i.secret ? '_(secret)_' : `\`${md(i.defaultValue) || ' '}\``} | ${md(i.description)} |`,
      );
    out.push('');
  }
  if (plan.needsSession) {
    out.push(
      opts.sessionJourney || plan.withSession
        ? `**Session:** run the \`${opts.sessionJourney ?? plan.withSession}\` runbook first with the same \`cookies.txt\`; this journey reads the session it creates.`
        : '**Session:** this journey needs an existing session. Run a login journey first with the same `cookies.txt`.',
    );
    out.push('');
  }
  out.push('## Start');
  out.push('');
  const headers = Object.entries(plan.headers ?? {}).map(([h, v]) => `${h}: <${v}>`);
  out.push(code('bash', curl(url, '{}', headers)));
  out.push('');
  out.push(`**Expected next:** ${expectedAfter(plan, -1)}`);
  plan.steps.forEach((s, i) => {
    out.push('');
    out.push(stepSection(plan, s, i, url));
  });
  if (plan.warnings.length) {
    out.push('');
    out.push('## Warnings');
    out.push('');
    for (const w of plan.warnings) out.push(`- **${w.level}** ${md(w.message)}`);
  }
  return `${out.join('\n')}\n`;
}
