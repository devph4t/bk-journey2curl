import { readFileSync } from 'node:fs';
import type { ExportBundle, JNode, Journey, LoadStats, Script, Warning } from '../model/types.js';
import { detectFormat } from './detect.js';
import { decodeScript } from './script-decode.js';

// The loader is lenient on purpose: exports differ between tools and versions. A bad field becomes a warning
// and the journey is kept; only an entry without any usable tree is skipped (and listed in `stats.skipped`).

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Numbers, or numeric strings ("103.5"); anything else is undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function stripMeta(config: Obj | undefined): Obj {
  if (!config) return {};
  const { _rev: _r, ...rest } = config;
  return rest;
}

function outcomeIds(config: Obj, connections: Record<string, string>): string[] {
  const declared = Array.isArray(config._outcomes)
    ? (config._outcomes as unknown[]).flatMap((o) => (isObject(o) && typeof o.id === 'string' ? [o.id] : []))
    : [];
  const extra = Object.keys(connections).filter((k) => !declared.includes(k));
  return [...declared.filter((d) => d in connections), ...extra];
}

/** Load an export file from disk. */
export function loadExportFile(path: string): ExportBundle {
  const text = readFileSync(path, 'utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`Cannot parse ${path} as JSON: ${(e as Error).message}`);
  }
  return loadExport(doc);
}

function addScript(scripts: Map<string, Script>, id: string, raw: unknown): void {
  if (scripts.has(id) || !isObject(raw)) return;
  const context = str(raw.context);
  scripts.set(id, {
    id: str(raw._id) ?? id,
    name: str(raw.name) ?? id,
    language: str(raw.language),
    context,
    evaluatorVersion: str(raw.evaluatorVersion),
    source: decodeScript(raw.script),
    ...(context?.toUpperCase() === 'LIBRARY' ? { library: true } : {}),
  });
}

/** Normalise any supported export document into an ExportBundle. */
export function loadExport(doc: unknown): ExportBundle {
  const detected = detectFormat(doc);
  const warnings: Warning[] = [];
  const journeys = new Map<string, Journey>();
  const scripts = new Map<string, Script>();
  const stats: LoadStats = {
    found: Object.keys(detected.bundles).length + Object.keys(detected.skipped).length,
    loaded: 0,
    skipped: Object.entries(detected.skipped).map(([name, reason]) => ({ name, reason })),
  };
  const warn = (w: Warning) => warnings.push(w);

  for (const [key, bundle] of Object.entries(detected.bundles)) {
    const tree = bundle.tree as Obj;
    // Journeys are referenced by tree _id (Inner Tree Evaluator "tree"); fall back to the map key.
    const name = str(tree._id) ?? key;
    if (journeys.has(name)) {
      stats.skipped.push({ name: key, reason: `duplicate journey name "${name}"` });
      continue;
    }
    const treeNodes = isObject(tree.nodes) ? tree.nodes : {};
    if (!isObject(tree.nodes)) {
      warn({ level: 'error', code: 'no-nodes', journey: name, message: `Journey "${name}": the tree has no nodes` });
    }
    const nodeConfigs = isObject(bundle.nodes) ? (bundle.nodes as Record<string, Obj>) : {};
    const innerRaw = bundle.innerNodes ?? bundle.innernodes;
    const innerConfigs = isObject(innerRaw) ? (innerRaw as Record<string, Obj>) : {};

    if (isObject(bundle.scripts)) for (const [id, s] of Object.entries(bundle.scripts)) addScript(scripts, id, s);

    const nodes = new Map<string, JNode>();
    for (const [id, tnRaw] of Object.entries(treeNodes)) {
      if (!isObject(tnRaw)) {
        warn({
          level: 'warn',
          code: 'bad-node',
          journey: name,
          nodeId: id,
          message: `Node ${id} is not an object; ignored`,
        });
        continue;
      }
      const config = stripMeta(isObject(nodeConfigs[id]) ? nodeConfigs[id] : undefined);
      const type = str(tnRaw.nodeType) ?? str((config._type as Obj | undefined)?._id) ?? 'Unknown';
      const connections: Record<string, string> = {};
      if (isObject(tnRaw.connections)) {
        for (const [o, to] of Object.entries(tnRaw.connections)) {
          if (typeof to === 'string') connections[o] = to;
          else
            warn({
              level: 'warn',
              code: 'bad-connection',
              journey: name,
              nodeId: id,
              message: `Node ${id}: outcome "${o}" has no target; ignored`,
            });
        }
      }
      const x = num(tnRaw.x);
      const y = num(tnRaw.y);
      const node: JNode = {
        id,
        type,
        name: str(tnRaw.displayName) ?? str(config.displayName) ?? type,
        x: x ?? 0,
        y: y ?? 0,
        outcomes: connections,
        outcomeOrder: outcomeIds(config, connections),
        config,
      };
      if (!nodeConfigs[id] && detected.format !== 'raw-tree') {
        warn({
          level: 'warn',
          code: 'missing-config',
          journey: name,
          nodeId: id,
          message: `Node "${node.name}" (${node.type}) has no config in the export`,
        });
      }
      if (Array.isArray(config.nodes)) {
        node.inner = (config.nodes as unknown[]).filter(isObject).map((child) => {
          const childId = String(child._id ?? '');
          const childConfig = stripMeta(isObject(innerConfigs[childId]) ? innerConfigs[childId] : undefined);
          if (!innerConfigs[childId]) {
            warn({
              level: 'warn',
              code: 'missing-inner-config',
              journey: name,
              nodeId: childId,
              message: `Page "${node.name}": child ${String(child.nodeType)} ${childId} has no config in the export`,
            });
          }
          return {
            id: childId,
            type: String(child.nodeType ?? (childConfig._type as Obj | undefined)?._id ?? 'Unknown'),
            name: String(child.displayName ?? child.nodeType ?? childId),
            x: 0,
            y: 0,
            outcomes: {},
            outcomeOrder: [],
            config: childConfig,
          };
        });
      }
      nodes.set(id, node);
    }

    const entry = str(tree.entryNodeId) ?? '';
    if (!nodes.has(entry)) {
      warn({
        level: 'error',
        code: 'bad-entry',
        journey: name,
        message: entry
          ? `Journey "${name}": entry node ${entry} is not in the tree`
          : `Journey "${name}": no entryNodeId; it cannot be planned`,
      });
    }

    const staticNodes: Journey['staticNodes'] = {};
    if (isObject(tree.staticNodes)) {
      for (const [k, v] of Object.entries(tree.staticNodes)) {
        const sx = isObject(v) ? num(v.x) : undefined;
        const sy = isObject(v) ? num(v.y) : undefined;
        if (sx !== undefined && sy !== undefined) staticNodes[k] = { x: sx, y: sy };
      }
    }

    journeys.set(name, {
      id: name,
      entry,
      description: str(tree.description),
      innerTreeOnly: tree.innerTreeOnly === true,
      staticNodes,
      nodes,
    });
    stats.loaded++;
  }

  for (const [id, s] of Object.entries(detected.topScripts)) addScript(scripts, id, s);
  resolveInnerReferences(journeys, warnings);

  if (detected.format === 'raw-tree') {
    warn({
      level: 'warn',
      code: 'raw-tree',
      message: 'Raw tree export: node configs and scripts are missing, callbacks cannot be derived',
    });
  }

  const m = detected.meta;
  return {
    meta: {
      format: detected.format,
      origin: str(m.origin),
      exportTool: str(m.exportTool),
      exportToolVersion: str(m.exportToolVersion),
      exportDate: str(m.exportDate),
    },
    journeys,
    scripts,
    warnings,
    stats,
  };
}

/**
 * Inner Tree Evaluator nodes name their journey in `config.tree`. Point them at the loaded journey even when
 * the case differs; warn when the journey is not in the export.
 */
function resolveInnerReferences(journeys: Map<string, Journey>, warnings: Warning[]): void {
  const byLower = new Map([...journeys.keys()].map((k) => [k.toLowerCase(), k]));
  for (const [jName, j] of journeys) {
    for (const n of j.nodes.values()) {
      if (n.type !== 'InnerTreeEvaluatorNode') continue;
      const ref = str(n.config.tree);
      if (!ref || journeys.has(ref)) continue;
      const match = byLower.get(ref.toLowerCase());
      if (match) n.config = { ...n.config, tree: match };
      else {
        warnings.push({
          level: 'warn',
          code: 'missing-inner-journey',
          journey: jName,
          nodeId: n.id,
          message: `${jName} / ${n.name}: inner journey "${ref}" is not in the export`,
        });
      }
    }
  }
}
