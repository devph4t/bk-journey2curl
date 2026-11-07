import type { CallbackSpec, InputKind, InputSpec } from '../../model/types.js';

interface CallbackOptions {
  prompt?: string;
  options?: string[];
  attribute?: string;
  origin?: CallbackSpec['origin'];
  sourceNodeId?: string;
  /** Base variable name hint (IN_ prefix added later). */
  variable?: string;
  /** Default value of the main input. */
  value?: unknown;
}

/** Input layout of each callback type: [suffix, kind, fixed value]. Names get their IDTokenN prefix per step. */
const INPUT_LAYOUT: Record<string, Array<[string, InputKind, unknown?]>> = {
  NameCallback: [['', 'string']],
  PasswordCallback: [['', 'string']],
  TextInputCallback: [['', 'string']],
  ChoiceCallback: [['', 'number']],
  ConfirmationCallback: [['', 'number']],
  HiddenValueCallback: [['', 'string']],
  TermsAndConditionsCallback: [['', 'boolean']],
  ConsentMappingCallback: [['', 'boolean']],
  DeviceProfileCallback: [['', 'string']],
  ValidatedCreateUsernameCallback: [
    ['', 'string'],
    ['validateOnly', 'fixed', false],
  ],
  ValidatedCreatePasswordCallback: [
    ['', 'string'],
    ['validateOnly', 'fixed', false],
  ],
  StringAttributeInputCallback: [
    ['', 'string'],
    ['validateOnly', 'fixed', false],
  ],
  BooleanAttributeInputCallback: [
    ['', 'boolean'],
    ['validateOnly', 'fixed', false],
  ],
  NumberAttributeInputCallback: [
    ['', 'number'],
    ['validateOnly', 'fixed', false],
  ],
  KbaCreateCallback: [
    ['question', 'string'],
    ['answer', 'string'],
  ],
  TextOutputCallback: [],
  SuspendedTextOutputCallback: [],
  PollingWaitCallback: [],
  MetadataCallback: [],
  RedirectCallback: [],
  ScriptTextOutputCallback: [],
};

export function knownCallbackType(type: string): boolean {
  return type in INPUT_LAYOUT;
}

export function makeCallback(type: string, opts: CallbackOptions = {}): CallbackSpec {
  const layout = INPUT_LAYOUT[type] ?? [];
  const inputs: InputSpec[] = layout.map(([suffix, kind, fixed], i) => {
    const input: InputSpec = { name: suffix, kind };
    if (kind === 'fixed') input.value = fixed;
    else if (i === 0 && opts.value !== undefined) input.value = opts.value;
    if (kind !== 'fixed' && opts.variable) {
      input.variable =
        layout.filter(([, k]) => k !== 'fixed').length > 1 ? `${opts.variable}_${suffix.toUpperCase()}` : opts.variable;
    }
    return input;
  });
  const cb: CallbackSpec = { type, inputs, origin: opts.origin ?? 'catalog' };
  if (opts.prompt !== undefined) cb.prompt = opts.prompt;
  if (opts.options) cb.options = opts.options;
  if (opts.attribute) cb.attribute = opts.attribute;
  if (opts.sourceNodeId) cb.sourceNodeId = opts.sourceNodeId;
  return cb;
}

/** Give inputs their IDToken names by callback position inside one step (IDToken1, IDToken2validateOnly ...). */
export function nameInputs(callbacks: CallbackSpec[]): void {
  callbacks.forEach((cb, i) => {
    const layout = INPUT_LAYOUT[cb.type];
    cb.inputs.forEach((input, j) => {
      const suffix = layout?.[j]?.[0] ?? (j === 0 ? '' : String(j));
      input.name = `IDToken${i + 1}${suffix}`;
    });
  });
}

export function signature(callbacks: CallbackSpec[]): string {
  return callbacks.map((c) => c.type).join(',');
}
