import { isKnownType } from '../analyze/catalog/index.js';
import { scanScript } from '../analyze/catalog/script-scan.js';
import { scriptedDecision } from '../analyze/catalog/scripted.js';
import type { BkConfig } from '../config.js';
import type { ExportBundle } from '../model/types.js';

/**
 * A structure-only summary of an export: what was found, loaded and skipped, how journeys use each other and
 * library scripts, and what the analyzer could not follow. It never prints script code or node config values.
 * With `redact`, journey and script names become J1, S1, L1 ... so the output can be shared safely.
 */
export function inspectExport(bundle: ExportBundle, opts: { redact?: boolean; config?: BkConfig } = {}): string {
  const names = new Map<string, string>();
  const alias = (kind: 'J' | 'S' | 'L', name: string) => {
    if (!opts.redact) return name;
    const key = `${kind}:${name}`;
    let v = names.get(key);
    if (!v) {
      v = `${kind}${[...names.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}`;
      names.set(key, v);
    }
    return v;
  };
  const J = (n: string) => alias('J', n);
  // Number journeys in load order (not by name) so redacted output does not hint at names.
  for (const n of bundle.journeys.keys()) J(n);
  const out: string[] = [];
  const { meta, stats } = bundle;
  out.push(
    `Export format: ${meta.format}${meta.exportTool ? ` (${meta.exportTool}${meta.exportToolVersion ? ` ${meta.exportToolVersion}` : ''})` : ''}`,
  );
  out.push(`Journeys: ${stats.found} found, ${stats.loaded} loaded, ${stats.skipped.length} skipped`);
  for (const s of stats.skipped) out.push(`  skipped ${J(s.name)}: ${s.reason}`);

  const scripts = [...bundle.scripts.values()];
  const libs = scripts.filter((s) => s.library);
  out.push(`Scripts: ${scripts.length} (${libs.length} library scripts)`);

  // Who uses whom (Inner Tree Evaluator) and the deepest nesting.
  const inner = new Map<string, string[]>();
  for (const [name, j] of bundle.journeys) {
    const refs = [...j.nodes.values()]
      .filter((n) => n.type === 'InnerTreeEvaluatorNode' && typeof n.config.tree === 'string')
      .map((n) => n.config.tree as string);
    inner.set(name, [...new Set(refs)]);
  }
  const depthOf = (name: string, seen: string[] = []): number => {
    if (seen.includes(name)) return 0;
    const kids = (inner.get(name) ?? []).filter((k) => bundle.journeys.has(k));
    return kids.length ? 1 + Math.max(...kids.map((k) => depthOf(k, [...seen, name]))) : 0;
  };

  const typeCount = new Map<string, number>();
  const unknown = new Set<string>();
  const missingInner = new Set<string>();
  const scriptIssues = new Map<string, number>();
  let scripted = 0;
  const libsUsed = new Set<string>();
  const missingLibs = new Set<string>();

  out.push('');
  out.push('Per journey:');
  for (const name of [...bundle.journeys.keys()].sort((a, b) => a.localeCompare(b))) {
    const j = bundle.journeys.get(name);
    if (!j) continue;
    const usedBy = [...inner].filter(([, refs]) => refs.includes(name)).map(([n]) => J(n));
    const nodes = [...j.nodes.values()];
    const pageChildren = nodes.flatMap((n) => n.inner ?? []);
    for (const n of [...nodes, ...pageChildren]) {
      typeCount.set(n.type, (typeCount.get(n.type) ?? 0) + 1);
      if (!isKnownType(n.type)) unknown.add(n.type);
    }
    const refs = inner.get(name) ?? [];
    for (const r of refs) if (!bundle.journeys.has(r)) missingInner.add(`${J(name)} -> ${J(r)}`);

    let nodeScripts = 0;
    for (const n of nodes.filter((x) => x.type === 'ScriptedDecisionNode' || x.type === 'ConfigProviderNode')) {
      scripted++;
      nodeScripts++;
      const info = scriptedDecision(n, { journey: name, scripts: bundle.scripts, config: opts.config ?? {} });
      for (const w of info.warnings ?? []) {
        if (w.code !== 'script-libraries') scriptIssues.set(w.code, (scriptIssues.get(w.code) ?? 0) + 1);
      }
      const src = bundle.scripts.get(String(n.config.script ?? ''))?.source;
      if (src) {
        const scan = scanScript(src, {
          library: (lib) => scripts.find((s) => s.name === lib || s.id === lib)?.source,
        });
        for (const l of scan.libraries) libsUsed.add(l);
        for (const l of scan.missingLibraries) missingLibs.add(l);
      }
    }
    const flags = [j.innerTreeOnly ? 'inner-only' : '', j.nodes.has(j.entry) ? '' : 'NO ENTRY NODE'].filter(Boolean);
    out.push(
      `  ${J(name)}${flags.length ? ` [${flags.join(', ')}]` : ''}: ${nodes.length} nodes, ${pageChildren.length} page children, ${nodeScripts} scripted` +
        (refs.length ? `; runs ${refs.map(J).join(', ')}` : '') +
        (usedBy.length ? `; used by ${usedBy.join(', ')}` : '') +
        (depthOf(name) > 1 ? `; nesting depth ${depthOf(name)}` : ''),
    );
  }

  out.push('');
  out.push(`Inner journeys not in the export: ${missingInner.size ? [...missingInner].join('; ') : 'none'}`);
  out.push(
    `Node types not in the catalog (no callbacks assumed): ${unknown.size ? [...unknown].sort().join(', ') : 'none'}`,
  );
  out.push(`Scripted nodes: ${scripted}`);
  out.push(`  Library scripts used: ${libsUsed.size ? [...libsUsed].map((l) => alias('L', l)).join(', ') : 'none'}`);
  out.push(
    `  Libraries required but not in the export: ${missingLibs.size ? [...missingLibs].map((l) => alias('L', l)).join(', ') : 'none'}`,
  );
  const ISSUE_TEXT: Record<string, string> = {
    'missing-script': 'script not in the export',
    'missing-library': 'require() of a library not in the export',
    'missing-library-function': 'library function not found',
    'script-loop': 'callbacks built in a loop',
    'script-conditional': 'callbacks built under a condition',
    'script-unordered': 'callback order unknown',
    'script-dynamic': 'prompts built at run time',
    'script-outcome': 'goes to an outcome not wired in the journey',
  };
  for (const [code, n] of [...scriptIssues].sort()) out.push(`  ${ISSUE_TEXT[code] ?? code}: ${n} node(s)`);

  out.push('');
  out.push('Node types:');
  for (const [t, n] of [...typeCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out.push(`  ${String(n).padStart(4)}  ${t}${unknown.has(t) ? '  (unknown)' : ''}`);
  }

  const byCode = new Map<string, number>();
  for (const w of bundle.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  out.push('');
  out.push(`Loader warnings: ${byCode.size ? [...byCode].map(([c, n]) => `${c} x${n}`).join(', ') : 'none'}`);
  if (opts.redact) out.push('', 'Names are redacted (J = journey, L = library script).');
  return out.join('\n');
}
