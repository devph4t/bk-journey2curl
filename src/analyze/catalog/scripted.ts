import type { CallbackSpec, Script } from '../../model/types.js';
import { makeCallback } from './callbacks.js';
import { type ScannedCallback, scanScript } from './script-scan.js';
import { type Handler, type InputLink, info, str } from './types.js';

/** A script by id, or by name (scripts are referenced by id in nodes and by name in require()). */
export function findScript(scripts: Map<string, Script>, ref: string): Script | undefined {
  const byId = scripts.get(ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const all = [...scripts.values()];
  return (
    all.find((x) => x.name === ref && x.library) ??
    all.find((x) => x.name === ref) ??
    all.find((x) => x.name.toLowerCase() === lower)
  );
}

const LEADING_VERBS = /^(choose|enter|collect|set|show|select|get|ask|pick|provide|input)\s+/i;

function toVar(text: string, maxWords: number): string {
  const words = text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(-maxWords).join('_').toUpperCase();
}

function toSpec(sc: ScannedCallback, nodeId: string, variable: string | undefined): CallbackSpec {
  const value =
    sc.type === 'ChoiceCallback' || sc.type === 'ConfirmationCallback'
      ? typeof sc.value === 'number'
        ? sc.value
        : 0
      : sc.type === 'HiddenValueCallback'
        ? undefined
        : sc.value;
  const cb = makeCallback(sc.type, {
    prompt: sc.type === 'HiddenValueCallback' ? sc.id : sc.prompt,
    options: sc.options,
    attribute: sc.type.endsWith('AttributeInputCallback') ? sc.id : undefined,
    origin: 'script',
    sourceNodeId: nodeId,
    variable,
    value,
  });
  return cb;
}

export const scriptedDecision: Handler = (node, ctx) => {
  const scriptId = str(node.config.script);
  const script = scriptId ? findScript(ctx.scripts, scriptId) : undefined;
  const outcomes = node.outcomeOrder;
  if (!script) {
    return info({
      known: true,
      branching: outcomes.length > 1 ? 'server' : 'preferred',
      warnings: [
        {
          level: 'warn',
          code: 'missing-script',
          nodeId: node.id,
          message: `${node.name}: script ${scriptId ?? '?'} is not in the export; callbacks unknown`,
        },
      ],
    });
  }

  const scan = scanScript(script.source, { library: (name) => findScript(ctx.scripts, name)?.source });
  const inputCbs = scan.callbacks.filter(
    (c) => !['TextOutputCallback', 'HiddenValueCallback', 'MetadataCallback'].includes(c.type),
  );
  const nodeVar = toVar(node.name.replace(LEADING_VERBS, ''), 3) || 'VALUE';

  const callbacks = scan.callbacks.map((sc) => {
    let variable: string | undefined;
    if (inputCbs.includes(sc)) {
      variable = inputCbs.length === 1 ? nodeVar : toVar(sc.prompt ?? sc.id ?? '', 2) || nodeVar;
    }
    return toSpec(sc, node.id, variable);
  });

  // Map "nth callback of type T" links onto callback positions.
  const links: Record<string, InputLink> = {};
  for (const [outcome, link] of Object.entries(scan.links)) {
    let seen = -1;
    const idx = callbacks.findIndex((c) => c.type === link.callbackType && ++seen === link.nth);
    if (idx >= 0) links[outcome] = { callbackIndex: idx, inputIndex: 0, value: link.value };
  }

  const serverDecided = !scan.readsCallbacks && outcomes.length > 1;
  const kind = callbacks.some((c) => c.type === 'PollingWaitCallback')
    ? 'poll'
    : callbacks.some((c) => c.type === 'RedirectCallback')
      ? 'redirect'
      : callbacks.some((c) => c.type === 'SuspendedTextOutputCallback')
        ? 'suspend'
        : 'submit';

  const warnings = [];
  const w = (code: string, message: string, level: 'info' | 'warn' = 'warn') =>
    warnings.push({ level, code, nodeId: node.id, message: `${node.name}: ${message}` });
  if (scan.missingLibraries.length) {
    w(
      'missing-library',
      `library script(s) not in the export: ${scan.missingLibraries.join(', ')}; callbacks they build are unknown`,
    );
  }
  if (scan.missingFunctions.length) {
    w('missing-library-function', `function(s) not found in the library: ${scan.missingFunctions.join(', ')}`);
  }
  if (scan.builtInLoop) w('script-loop', 'callbacks are built in a loop; their number depends on run-time data');
  if (scan.builtConditionally) {
    w('script-conditional', 'some callbacks are built only under a condition; the run-time type check decides', 'info');
  }
  if (scan.unordered) w('script-unordered', 'callbacks are built in functions with no direct call; order is a guess');
  if (scan.libraries.length) w('script-libraries', `uses library script(s): ${scan.libraries.join(', ')}`, 'info');
  const unknownOutcomes = scan.outcomes.filter((o) => !(o in node.outcomes));
  if (unknownOutcomes.length) {
    warnings.push({
      level: 'warn' as const,
      code: 'script-outcome',
      nodeId: node.id,
      message: `${node.name}: script goes to outcome(s) not wired in the journey: ${unknownOutcomes.join(', ')}`,
    });
  }
  if (
    scan.callbacks.some(
      (c) =>
        c.prompt === undefined &&
        ['NameCallback', 'PasswordCallback', 'TextOutputCallback', 'ChoiceCallback'].includes(c.type),
    )
  ) {
    warnings.push({
      level: 'info' as const,
      code: 'script-dynamic',
      nodeId: node.id,
      message: `${node.name}: some callback prompts are built at run time`,
    });
  }

  return info({
    callbacks,
    kind,
    links,
    branching: serverDecided ? 'server' : 'preferred',
    serverReason: serverDecided ? (scan.usesRandom ? 'random' : 'script logic') : undefined,
    condition: serverDecided ? (o) => `the script picks "${o}"` : undefined,
    warnings,
  });
};

export const scriptedHandlers: Record<string, Handler> = {
  ScriptedDecisionNode: scriptedDecision,
  ConfigProviderNode: scriptedDecision,
};
