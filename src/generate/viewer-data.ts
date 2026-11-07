import { signature } from '../analyze/catalog/callbacks.js';
import { callbacksPlainText } from '../analyze/plain-text.js';
import {
  type ExportBundle,
  FAILURE_NODE_ID,
  type Plan,
  SUCCESS_NODE_ID,
  type ViewerCanvas,
  type ViewerData,
  type ViewerStep,
} from '../model/types.js';
import { type CurlOptions, curlSet } from './curl.js';

function innerOf(bundle: ExportBundle, journey: string): string[] {
  const j = bundle.journeys.get(journey);
  if (!j) return [];
  return [...j.nodes.values()]
    .filter((n) => n.type === 'InnerTreeEvaluatorNode' && typeof n.config.tree === 'string')
    .map((n) => n.config.tree as string);
}

/** Journeys nested under `journey` (inner trees of inner trees ...), depth-limited. */
function descendants(bundle: ExportBundle, journey: string, depth = 0): Set<string> {
  const out = new Set<string>();
  if (depth > 5) return out;
  for (const i of innerOf(bundle, journey)) {
    if (out.has(i) || i === journey) continue;
    out.add(i);
    for (const d of descendants(bundle, i, depth + 1)) out.add(d);
  }
  return out;
}

function canvasFor(bundle: ExportBundle, plan: Plan, name: string): ViewerCanvas | undefined {
  const journey = bundle.journeys.get(name);
  if (!journey) return undefined;
  const taken = new Set(plan.trail.filter((t) => t.journey === name).map((t) => `${t.nodeId}|${t.outcome}`));
  const onPathNodes = new Set(plan.trail.filter((t) => t.journey === name).map((t) => t.nodeId));

  const nodes = [...journey.nodes.values()].map((n) => {
    const steps = new Set<number>();
    for (const s of plan.steps) {
      if (s.journey === name && s.nodeId === n.id) steps.add(s.index);
      if (s.journey === name && s.variants?.some((v) => v.nodeId === n.id)) steps.add(s.index);
    }
    const inner = n.type === 'InnerTreeEvaluatorNode' && typeof n.config.tree === 'string' ? n.config.tree : undefined;
    if (inner && onPathNodes.has(n.id)) {
      const nested = new Set([inner, ...descendants(bundle, inner)]);
      for (const s of plan.steps) if (nested.has(s.journey)) steps.add(s.index);
    }
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      x: n.x,
      y: n.y,
      outcomes: n.outcomeOrder,
      ...(n.inner?.length ? { children: n.inner.map((c) => ({ name: c.name, type: c.type })) } : {}),
      ...(inner ? { innerJourney: inner } : {}),
      onPath: onPathNodes.has(n.id),
      steps: [...steps].sort((a, b) => a - b),
    };
  });

  const edges = [...journey.nodes.values()].flatMap((n) =>
    n.outcomeOrder.flatMap((o) => {
      const to = n.outcomes[o];
      return to ? [{ from: n.id, to, outcome: o, onPath: taken.has(`${n.id}|${o}`) }] : [];
    }),
  );

  // Fallback positions when the export has none for Start / Success / Failure.
  const maxX = Math.max(0, ...nodes.map((n) => n.x)) + 300;
  const staticNodes = {
    startNode: journey.staticNodes.startNode ?? { x: 50, y: 100 },
    [SUCCESS_NODE_ID]: journey.staticNodes[SUCCESS_NODE_ID] ?? { x: maxX, y: 80 },
    [FAILURE_NODE_ID]: journey.staticNodes[FAILURE_NODE_ID] ?? { x: maxX, y: 220 },
  };
  return { journey: name, entry: journey.entry, nodes, edges, staticNodes };
}

/** Everything the flow viewer page needs for one plan. */
export function buildViewerData(
  plan: Plan,
  bundle: ExportBundle,
  opts: CurlOptions & { source?: string } = {},
): ViewerData {
  const set = curlSet(plan, opts);
  const names = [plan.journey];
  for (const t of plan.trail) if (!names.includes(t.journey)) names.push(t.journey);
  const canvases = names.flatMap((n) => canvasFor(bundle, plan, n) ?? []);

  const steps: ViewerStep[] = plan.steps.map((s, i) => {
    const step: ViewerStep = {
      index: s.index,
      kind: s.kind,
      journey: s.journey,
      nodeId: s.nodeId,
      nodeName: s.nodeName,
      plainText: s.plainText,
      callbacks: signature(s.callbacks),
      curl: set.steps[i] ?? { index: s.index, run: [], expect: '' },
    };
    if (s.condition) step.condition = s.condition;
    if (s.notes?.length) step.notes = s.notes;
    if (s.variants) {
      step.variants = s.variants.map((v) => ({
        label: v.label,
        callbacks: v.signature,
        ...(v.solver ? { solver: v.solver } : {}),
        ...(v.nodeId ? { nodeId: v.nodeId } : {}),
        plainText: v.kind === 'suspend' ? 'Check your email and click the link' : callbacksPlainText(v.callbacks),
      }));
    }
    return step;
  });

  const { steps: _s, ...curl } = set;
  return {
    journey: plan.journey,
    target: plan.target,
    coverage: plan.coverage,
    coverageNotes: plan.coverageNotes,
    warnings: plan.warnings.map((w) => w.message),
    ...(opts.source ? { source: opts.source } : {}),
    canvases,
    steps,
    curl,
    inputs: plan.inputs.map((i) => ({
      variable: i.variable,
      defaultValue: i.secret ? 'CHANGE_ME' : i.defaultValue,
      secret: !!i.secret,
      description: i.description,
    })),
  };
}

/** Put the data into the built viewer page. `</` is escaped so the JSON cannot close the script tag. */
export function injectViewerData(template: string, data: ViewerData): string {
  // Escape '<' and the JS line separators U+2028/U+2029 so the JSON is safe inside <script>.
  const json = JSON.stringify(data).replace(
    /[<\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  // Replace the whole data tag: the inlined app script may come first in the page.
  const tag = '<script id="bkj2c-data" type="application/json">__BKJ2C_DATA__</script>';
  if (!template.includes(tag)) throw new Error('Viewer template has no bkj2c-data placeholder');
  return template
    .replace(tag, () => `<script id="bkj2c-data" type="application/json">${json}</script>`)
    .replace('<title>Journey Flow</title>', () => `<title>${escapeHtml(data.journey)} Flow</title>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
