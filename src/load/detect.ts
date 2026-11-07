import type { ExportFormat } from '../model/types.js';

export interface Detected {
  format: ExportFormat;
  /** map key -> raw bundle ({ tree, nodes, innerNodes, scripts }) */
  bundles: Record<string, Record<string, unknown>>;
  meta: Record<string, unknown>;
  /** Scripts stored outside the tree bundles (top-level `scripts` / `script` maps of some exports). */
  topScripts: Record<string, unknown>;
  /** Entries of `trees` that are not bundles at all: map key -> reason. */
  skipped: Record<string, string>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Top-level script maps: `{ scripts: { id: {...} } }`, `{ script: { id: {...} } }` or an array of scripts. */
function topLevelScripts(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['scripts', 'script']) {
    const v = doc[key];
    if (Array.isArray(v)) {
      for (const s of v) if (isObject(s) && typeof s._id === 'string') out[s._id] = s;
    } else if (isObject(v)) {
      for (const [id, s] of Object.entries(v)) if (isObject(s)) out[id] = s;
    }
  }
  return out;
}

/**
 * Work out which export format a parsed JSON document is, and return its bundles.
 *
 * - `trees` map (or array) of bundles: Admin UI 1.1 and Frodo (single or multi).
 * - single bundle: `tree` + `nodes` at the top level (older Frodo / hand-made).
 * - raw tree: `entryNodeId` at the top level (AM REST `/realm-config/authentication/authenticationtrees/trees/<id>`).
 */
export function detectFormat(doc: unknown): Detected {
  if (!isObject(doc)) throw new Error('Export is not a JSON object');
  const meta = isObject(doc.meta) ? doc.meta : {};
  const tool = String(meta.exportTool ?? '').toLowerCase();
  const topScripts = topLevelScripts(doc);
  const skipped: Record<string, string> = {};

  if (isObject(doc.trees) || Array.isArray(doc.trees)) {
    const format: ExportFormat = tool.includes('frodo') ? 'frodo' : 'admin-ui';
    const bundles: Record<string, Record<string, unknown>> = {};
    const entries: Array<[string, unknown]> = Array.isArray(doc.trees)
      ? doc.trees.map((b, i) => {
          const id = isObject(b) && isObject(b.tree) && typeof b.tree._id === 'string' ? b.tree._id : `#${i + 1}`;
          return [id, b];
        })
      : Object.entries(doc.trees);
    for (const [name, b] of entries) {
      if (!isObject(b)) skipped[name] = 'not an object';
      else if (isObject(b.tree)) bundles[name] = b;
      // A bare tree inside `trees` (no bundle around it).
      else if (typeof b.entryNodeId === 'string' || isObject(b.nodes)) bundles[name] = { tree: b, nodes: {} };
      else skipped[name] = 'no "tree" object';
    }
    return { format, bundles, meta, topScripts, skipped };
  }

  if (isObject(doc.tree)) {
    const name = String(doc.tree._id ?? 'journey');
    return {
      format: tool.includes('frodo') ? 'frodo' : 'single-bundle',
      bundles: { [name]: doc },
      meta,
      topScripts,
      skipped,
    };
  }

  if (typeof doc.entryNodeId === 'string') {
    const name = String(doc._id ?? 'journey');
    return { format: 'raw-tree', bundles: { [name]: { tree: doc, nodes: {} } }, meta, topScripts, skipped };
  }

  throw new Error('Unknown export format: expected "trees", "tree" or "entryNodeId" at the top level');
}
