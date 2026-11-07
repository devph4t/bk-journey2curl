import type { ExportFormat } from '../model/types.js';

export interface Detected {
  format: ExportFormat;
  /** journey name -> raw bundle ({ tree, nodes, innerNodes, scripts }) */
  bundles: Record<string, Record<string, unknown>>;
  meta: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Work out which export format a parsed JSON document is, and return its bundles keyed by journey name.
 *
 * - `trees` map of bundles: Admin UI 1.1 and Frodo (single or multi).
 * - single bundle: `tree` + `nodes` at the top level (older Frodo / hand-made).
 * - raw tree: `entryNodeId` at the top level (AM REST `/realm-config/authentication/authenticationtrees/trees/<id>`).
 */
export function detectFormat(doc: unknown): Detected {
  if (!isObject(doc)) throw new Error('Export is not a JSON object');
  const meta = isObject(doc.meta) ? doc.meta : {};

  if (isObject(doc.trees)) {
    const tool = String(meta.exportTool ?? '').toLowerCase();
    const format: ExportFormat = tool.includes('frodo') ? 'frodo' : 'admin-ui';
    const bundles: Record<string, Record<string, unknown>> = {};
    for (const [name, b] of Object.entries(doc.trees)) {
      if (isObject(b)) bundles[name] = b;
    }
    return { format, bundles, meta };
  }

  if (isObject(doc.tree)) {
    const tree = doc.tree;
    const name = String(tree._id ?? 'journey');
    const tool = String(meta.exportTool ?? '').toLowerCase();
    return { format: tool.includes('frodo') ? 'frodo' : 'single-bundle', bundles: { [name]: doc }, meta };
  }

  if (typeof doc.entryNodeId === 'string') {
    const name = String(doc._id ?? 'journey');
    return { format: 'raw-tree', bundles: { [name]: { tree: doc, nodes: {} } }, meta };
  }

  throw new Error('Unknown export format: expected "trees", "tree" or "entryNodeId" at the top level');
}
