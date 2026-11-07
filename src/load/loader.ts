import { readFileSync } from 'node:fs';
import { bundleSchema, formatIssues } from '../model/schema.js';
import type { ExportBundle, JNode, Journey, Script, Warning } from '../model/types.js';
import { detectFormat } from './detect.js';
import { decodeScript } from './script-decode.js';

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`Cannot parse ${path} as JSON: ${(e as Error).message}`);
  }
  return loadExport(doc);
}

/** Normalise any supported export document into an ExportBundle. */
export function loadExport(doc: unknown): ExportBundle {
  const detected = detectFormat(doc);
  const warnings: Warning[] = [];
  const journeys = new Map<string, Journey>();
  const scripts = new Map<string, Script>();

  for (const [name, rawBundle] of Object.entries(detected.bundles)) {
    const parsed = bundleSchema.safeParse(rawBundle);
    if (!parsed.success) {
      warnings.push({
        level: 'error',
        code: 'bad-bundle',
        journey: name,
        message: `Journey "${name}" skipped: ${formatIssues(parsed.error)}`,
      });
      continue;
    }
    const b = parsed.data;
    const nodeConfigs = b.nodes as Record<string, Obj>;
    const innerConfigs = (b.innerNodes ?? b.innernodes ?? {}) as Record<string, Obj>;

    for (const [id, s] of Object.entries(b.scripts ?? {})) {
      if (scripts.has(id)) continue;
      scripts.set(id, {
        id,
        name: s.name ?? id,
        language: s.language,
        context: s.context,
        evaluatorVersion: s.evaluatorVersion,
        source: decodeScript(s.script),
      });
    }

    const nodes = new Map<string, JNode>();
    for (const [id, tn] of Object.entries(b.tree.nodes)) {
      const config = stripMeta(nodeConfigs[id]);
      const connections = tn.connections ?? {};
      const node: JNode = {
        id,
        type: tn.nodeType,
        name: tn.displayName ?? tn.nodeType,
        x: tn.x ?? 0,
        y: tn.y ?? 0,
        outcomes: { ...connections },
        outcomeOrder: outcomeIds(config, connections),
        config,
      };
      if (!nodeConfigs[id] && detected.format !== 'raw-tree') {
        warnings.push({
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
          const childConfig = stripMeta(innerConfigs[childId]);
          if (!innerConfigs[childId]) {
            warnings.push({
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

    if (!nodes.has(b.tree.entryNodeId)) {
      warnings.push({
        level: 'error',
        code: 'bad-entry',
        journey: name,
        message: `Journey "${name}": entry node ${b.tree.entryNodeId} is not in the tree`,
      });
    }

    const staticNodes: Journey['staticNodes'] = {};
    for (const [k, v] of Object.entries(b.tree.staticNodes ?? {})) staticNodes[k] = { x: v.x, y: v.y };

    journeys.set(name, {
      id: b.tree._id ?? name,
      entry: b.tree.entryNodeId,
      description: b.tree.description,
      innerTreeOnly: b.tree.innerTreeOnly,
      staticNodes,
      nodes,
    });
  }

  if (detected.format === 'raw-tree') {
    warnings.push({
      level: 'warn',
      code: 'raw-tree',
      message: 'Raw tree export: node configs and scripts are missing, callbacks cannot be derived',
    });
  }

  const m = detected.meta;
  return {
    meta: {
      format: detected.format,
      origin: typeof m.origin === 'string' ? m.origin : undefined,
      exportTool: typeof m.exportTool === 'string' ? m.exportTool : undefined,
      exportToolVersion: typeof m.exportToolVersion === 'string' ? m.exportToolVersion : undefined,
      exportDate: typeof m.exportDate === 'string' ? m.exportDate : undefined,
    },
    journeys,
    scripts,
    warnings,
  };
}
