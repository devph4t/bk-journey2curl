import { signature } from '../analyze/catalog/callbacks.js';
import { solverLabel } from '../analyze/solvers.js';
import type { CallbackSpec, CurlBlock, CurlSet, InputSpec, Plan, Step, StepCurl, Variant } from '../model/types.js';

/** Headers that work against P1AIC /authenticate (checked against a real tenant). */
export const AUTH_HEADERS = [
  'Content-Type: application/json',
  'Accept-API-Version: resource=2.1, protocol=1.0',
  'X-Requested-With: ForgeRock',
];

export interface CurlOptions {
  tenant?: string;
  realm?: string;
}

export function realmPath(realm = 'alpha'): string {
  const r = realm.replace(/^\/+|\/+$/g, '');
  if (!r || r === 'root') return 'realms/root';
  return `realms/root/${r
    .split('/')
    .map((p) => `realms/${p}`)
    .join('/')}`;
}

/** Quote for a bash single-quoted string. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type Output = { name: string; value: unknown };

/** The output array the server sends for a callback, as far as the plan knows it. */
export function outputs(cb: CallbackSpec): Output[] {
  const p = cb.prompt ?? '';
  switch (cb.type) {
    case 'TextOutputCallback':
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
        { name: 'prompt', value: '<prompt from the server>' },
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

function exampleValue(input: InputSpec, plan: Plan): unknown {
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

/**
 * Example request body (Postman style), one callback per line. Page Node callbacks carry an `_id`
 * that must be sent back as received.
 */
export function exampleBody(callbacks: CallbackSpec[], plan: Plan, authFrom: string, withId: boolean): string {
  const cbs = callbacks.map((cb, i) =>
    JSON.stringify({
      type: cb.type,
      ...(withId ? { _id: i } : {}),
      output: outputs(cb),
      input: cb.inputs.map((x) => ({ name: x.name, value: exampleValue(x, plan) })),
    }),
  );
  return `{"authId":${JSON.stringify(`<authId from ${authFrom}>`)},"callbacks":[\n    ${cbs.join(',\n    ')}]}`;
}

/** Literal curl with an inline JSON body (runbook "what is sent"). */
export function literalCurl(url: string, json: string, extraHeaders: string[] = []): string {
  const lines = [`curl -X POST "${url}" \\`];
  for (const h of [...AUTH_HEADERS, ...extraHeaders]) lines.push(`  -H "${h}" \\`);
  lines.push('  -b cookies.txt -c cookies.txt \\');
  lines.push(`  -d ${shq(json)}`);
  return lines.join('\n');
}

const curlPost = (indent: string, url = '"$URL"') =>
  [
    `curl -sS -X POST ${url} \\`,
    ...AUTH_HEADERS.map((h) => `${indent}  -H ${shq(h)} \\`),
    `${indent}  -b cookies.txt -c cookies.txt`,
  ].join('\n');

/** jq program + args that fill the inputs of these callbacks in $RESP. */
function fillProgram(callbacks: CallbackSpec[]): { args: string[]; assigns: string[] } {
  const args: string[] = [];
  const assigns: string[] = [];
  let n = 0;
  callbacks.forEach((cb, i) => {
    cb.inputs.forEach((input, j) => {
      if (input.kind === 'fixed') return;
      const target = `.callbacks[${i}].input[${j}].value`;
      if (input.solver === 'totp') {
        n++;
        args.push(`--arg v${n} "\${IN_OTP:?set IN_OTP to the current code}"`);
        assigns.push(`${target} = $v${n}`);
      } else if (input.jq) {
        assigns.push(`${target} = ${input.jq}   # ${input.solver ?? 'custom'}`);
      } else if (input.variable) {
        n++;
        const flag = input.kind === 'string' ? '--arg' : '--argjson';
        args.push(`${flag} v${n} "$${input.variable}"`);
        assigns.push(`${target} = $v${n}`);
      }
    });
  });
  return { args, assigns };
}

/** Copyable block: fill the inputs of the last response, post it, keep the new response in $RESP. */
export function submitBlock(callbacks: CallbackSpec[], label: string): CurlBlock {
  const { args, assigns } = fillProgram(callbacks);
  const lines: string[] = [`# ${label}`];
  if (!assigns.length) {
    lines.push(`RESP=$(${curlPost('       ')} \\`);
    lines.push(`       -d "$RESP")`);
  } else {
    // One assignment per line; jq comments (# solver) end at the line break.
    const program = assigns.join('\n  | ');
    lines.push('RESP=$(jq -c \\');
    for (const a of args) lines.push(`  ${a} \\`);
    const last = assigns[assigns.length - 1] ?? '';
    lines.push(`  ${shq(last.includes('#') ? `${program}\n  ` : program)} <<<"$RESP" \\`);
    lines.push(`  | ${curlPost('    ')} -d @-)`);
  }
  lines.push('jq . <<<"$RESP"');
  return { label, code: lines.join('\n') };
}

const TYPES = `jq -r '[.callbacks[]?.type] | join(",")' <<<"$RESP"`;

function suspendBlock(label: string): CurlBlock {
  return {
    label,
    code: [
      `# ${label}`,
      '# The server sent an email. Show its message:',
      `jq -r '[.callbacks[]?.output[]? | select(.name == "message") | .value] | first' <<<"$RESP"`,
      '# Open the link from the email in a browser, or copy its suspendedId and continue here:',
      'SUSPENDED_ID=PASTE_ID_FROM_EMAIL',
      `RESP=$(${curlPost('       ', '"$URL&suspendedId=$SUSPENDED_ID"')} \\`,
      `       -d '{}')`,
      'jq . <<<"$RESP"',
    ].join('\n'),
  };
}

function manualBlock(label: string, note: string): CurlBlock {
  return {
    label,
    code: [
      `# ${label}`,
      `# Needs a person: ${note}`,
      '# The last response, to finish in a browser:',
      'jq . <<<"$RESP"',
    ].join('\n'),
  };
}

function variantBlock(step: Step, v: Variant): CurlBlock {
  const label = `Step ${step.index} – if the server sent ${v.signature} (${v.label})`;
  if (v.kind === 'suspend') return suspendBlock(label);
  if (v.kind === 'manual') return manualBlock(label, v.notes?.[0] ?? 'finish in a browser');
  const b = submitBlock(v.callbacks, label);
  if (v.solver)
    b.code = b.code.replace(
      `# ${label}`,
      `# ${label}\n# The answer is computed from the response: ${solverLabel(v.solver)}`,
    );
  return b;
}

export function stepTitle(step: Step): string {
  const where = step.depth > 0 ? `${step.journey} / ${step.nodeName}` : step.nodeName;
  return `Step ${step.index} – ${where}`;
}

/** Plain words for what the server should send after step `idx` (-1 = after the start call). */
export function expectedAfter(plan: Plan, idx: number): string {
  const next = plan.steps[idx + 1];
  const end =
    plan.target === 'success' ? 'tokenId (journey finished: Success)' : 'HTTP 401 (journey finished: Failure)';
  if (!next) return end;
  if (next.kind === 'variant') return (next.variants ?? []).map((v) => `${v.signature} (${v.label})`).join(' or ');
  const sig = signature(next.callbacks);
  if (next.kind === 'optional') return `${sig} (optional step ${next.index}) or ${expectedAfter(plan, idx + 1)}`;
  return sig;
}

export function stepCurl(plan: Plan, step: Step, idx: number): StepCurl {
  const title = stepTitle(step);
  const prev = idx === 0 ? 'the start call' : `step ${step.index - 1}`;
  const withId = step.nodeType === 'PageNode';
  const out: StepCurl = { index: step.index, run: [], expect: expectedAfter(plan, idx) };
  switch (step.kind) {
    case 'variant':
      out.run = (step.variants ?? []).map((v) => variantBlock(step, v));
      {
        const first = (step.variants ?? []).find((v) => v.kind !== 'suspend' && v.kind !== 'manual');
        if (first) out.body = exampleBody(first.callbacks, plan, prev, false);
      }
      break;
    case 'suspend':
      out.run = [suspendBlock(title)];
      break;
    case 'manual':
      out.run = [manualBlock(title, step.notes?.[0] ?? 'finish this step in a browser')];
      break;
    case 'optional': {
      const b = submitBlock(step.callbacks, `${title} (optional)`);
      const sig = signature(step.callbacks);
      b.code = b.code.replace(
        `# ${title} (optional)`,
        `# ${title} (optional)\n# Run only if the last response has: ${sig}${step.condition ? `\n# (it appears when ${step.condition})` : ''}`,
      );
      out.run = [b];
      out.body = exampleBody(step.callbacks, plan, prev, withId);
      break;
    }
    default:
      out.run = [submitBlock(step.callbacks, `${title}: ${step.plainText}`)];
      out.body = exampleBody(step.callbacks, plan, prev, withId);
  }
  return out;
}

/** Every copyable block for a plan, in the order they are run. */
export function curlSet(plan: Plan, opts: CurlOptions = {}): CurlSet {
  const tenant = opts.tenant ?? 'https://CHANGE_ME.forgeblocks.com';
  const realm = opts.realm ?? 'alpha';
  const url = `$TENANT/am/json/${realmPath(realm)}/authenticate?authIndexType=service&authIndexValue=${encodeURIComponent(plan.journey)}`;
  const setup = [
    `# ${plan.journey}: run these blocks one by one in the same bash terminal (Git Bash works). Needs curl and jq.`,
    `export TENANT=${shq(tenant)}`,
    `export REALM=${shq(realm)}`,
    `URL="${url}"`,
    '# Values already set in your environment win; secrets are never written here, set them yourself.',
    ...plan.inputs.map(
      (i) => `export ${i.variable}="\${${i.variable}:-${i.defaultValue.replace(/[\\"$`]/g, (c) => `\\${c}`)}}"`,
    ),
    'rm -f cookies.txt   # one cookie jar per run keeps load-balancer affinity',
  ];
  if (plan.needsSession) {
    setup.push(
      `# This journey reads an existing session: first run the ${plan.withSession ?? 'Login'} blocks in this terminal (same cookies.txt).`,
    );
  }
  const zeroPage = Object.entries(plan.headers ?? {}).map(([h, v]) => `  -H "${h}: $${v}"`);
  const start = [
    '# Start the journey (empty body)',
    `RESP=$(${curlPost('       ')} \\`,
    ...zeroPage.map((h) => `       ${h.trim()} \\`),
    `       -d '{}')`,
    'jq . <<<"$RESP"',
  ];
  const finish =
    plan.target === 'success'
      ? ['# Finished: the response should have a tokenId', `jq '{tokenId, successUrl, realm}' <<<"$RESP"`]
      : ['# Finished: the response should be HTTP 401', `jq '{code, message}' <<<"$RESP"`];
  const session = [
    '# Check the session created by the journey',
    `COOKIE_NAME=$(curl -sS "$TENANT/am/json/serverinfo/*" -H 'Accept-API-Version: resource=1.1, protocol=1.0' | jq -r .cookieName)`,
    `curl -sS -X POST "$TENANT/am/json/${realmPath(realm)}/sessions?_action=getSessionInfo" \\`,
    `  -H 'Content-Type: application/json' -H 'Accept-API-Version: resource=4.0, protocol=1.0' \\`,
    `  -H "$COOKIE_NAME: $(jq -r .tokenId <<<"$RESP")" -d '{}' | jq .`,
  ];
  return {
    setup: { label: 'Setup', code: setup.join('\n') },
    start: { label: 'Start', code: start.join('\n') },
    steps: plan.steps.map((s, i) => stepCurl(plan, s, i)),
    finish: { label: 'Finish', code: finish.join('\n') },
    session: { label: 'Check session', code: session.join('\n') },
    types: `# Which callbacks did the server send?\n${TYPES}`,
  };
}
