import { describe, expect, it } from 'vitest';
import { scanScript } from '../src/analyze/catalog/script-scan.js';
import { Planner } from '../src/analyze/planner.js';
import { inspectExport } from '../src/format/inspect.js';
import { buildReport, renderReportMd } from '../src/generate/report.js';
import { buildViewerData } from '../src/generate/viewer-data.js';
import { loadExport } from '../src/load/loader.js';
import { FAILURE_NODE_ID as F, SUCCESS_NODE_ID as S } from '../src/model/types.js';

// A synthetic "complex" export: nested sub-journeys, library scripts, odd fields. No real tenant data.
const script = (id: string, name: string, source: string, context = 'AUTHENTICATION_TREE_DECISION_NODE') => ({
  [id]: { _id: id, name, script: JSON.stringify(source), context, language: 'JAVASCRIPT', evaluatorVersion: '2.0' },
});

const MAIN_SRC = `
var ui = require('UiLib');
var { askCity } = require('FormLib');
if (callbacks.isEmpty()) {
  ui.welcome(callbacksBuilder, 'Hello');
  askCity(callbacksBuilder, 'Your city');
} else {
  var city = callbacks.getNameCallbacks().get(0);
  action.goTo('next');
}`;
const UI_LIB = `
function welcome(cb, msg) { cb.textOutputCallback(0, msg); }
exports.welcome = welcome;`;
const FORM_LIB = `
exports.askCity = function (cb, label) { cb.nameCallback(label); };`;
const LOOP_SRC = `
var fields = ['a', 'b'];
if (callbacks.isEmpty()) {
  fields.forEach(function (f) { callbacksBuilder.nameCallback(f); });
} else { action.goTo('next'); }`;
const MISSING_LIB_SRC = `
var x = require('NopeLib');
if (callbacks.isEmpty()) { x.ask(callbacksBuilder); } else { action.goTo('next'); }`;

const tree = (id: string, entry: string, nodes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  _id: id,
  entryNodeId: entry,
  nodes,
  staticNodes: { startNode: { x: '20', y: 40 }, [S]: { x: 900, y: 40 }, [F]: { x: 'abc', y: 200 } },
  ...extra,
});

const doc = {
  meta: { exportTool: 'platform-admin ui tree export', exportToolVersion: '1.1' },
  trees: {
    Main: {
      tree: tree('Main', 's1', {
        s1: { nodeType: 'ScriptedDecisionNode', displayName: 'Ask', connections: { next: 'i1' }, x: '120', y: 40 },
        i1: {
          nodeType: 'InnerTreeEvaluatorNode',
          displayName: 'Run A',
          connections: { true: 'v1', false: F },
          x: 380,
          y: 40,
        },
        v1: {
          nodeType: 'CustomVendorNode',
          displayName: 'Vendor',
          connections: { outcome: S, bad: 42 },
          x: 640,
          y: 40,
        },
      }),
      nodes: {
        s1: { _id: 's1', script: 'scr-main', outcomes: ['next'], _outcomes: [{ id: 'next' }] },
        i1: { _id: 'i1', tree: 'suba' }, // different case than the journey id
        v1: { _id: 'v1' },
      },
      scripts: {
        ...script('scr-main', 'Main script', MAIN_SRC),
        ...script('lib-ui', 'UiLib', UI_LIB, 'LIBRARY'),
        ...script('lib-form', 'FormLib', FORM_LIB, 'LIBRARY'),
      },
    },
    // Map key differs from the tree _id.
    'sub-a-key': {
      tree: tree(
        'SubA',
        'a1',
        {
          a1: { nodeType: 'ScriptedDecisionNode', displayName: 'Loop', connections: { next: 'a2' }, x: 100, y: 40 },
          a2: {
            nodeType: 'InnerTreeEvaluatorNode',
            displayName: 'Run B',
            connections: { true: S, false: F },
            x: 360,
            y: 40,
          },
        },
        { innerTreeOnly: true },
      ),
      nodes: { a1: { _id: 'a1', script: 'scr-loop' }, a2: { _id: 'a2', tree: 'SubB' } },
      scripts: script('scr-loop', 'Loop script', LOOP_SRC),
    },
    SubB: {
      tree: tree(
        'SubB',
        'b1',
        {
          b1: { nodeType: 'ScriptedDecisionNode', displayName: 'Missing lib', connections: { next: 'b2' } },
          b2: { nodeType: 'InnerTreeEvaluatorNode', displayName: 'Run C', connections: { true: S, false: F } },
        },
        { innerTreeOnly: true },
      ),
      nodes: { b1: { _id: 'b1', script: 'scr-missing' }, b2: { _id: 'b2', tree: 'SubC' } },
      scripts: script('scr-missing', 'Missing lib script', MISSING_LIB_SRC),
    },
    SubC: {
      tree: tree(
        'SubC',
        'c1',
        {
          c1: { nodeType: 'InnerTreeEvaluatorNode', displayName: 'Run ghost', connections: { true: S, false: F } },
        },
        { innerTreeOnly: true },
      ),
      nodes: { c1: { _id: 'c1', tree: 'Ghost' } },
    },
    Broken: 'not a bundle',
  },
};

const bundle = loadExport(doc);

describe('complex export', () => {
  it('loads every journey, names them by tree _id and lists what was skipped', () => {
    expect([...bundle.journeys.keys()].sort()).toEqual(['Main', 'SubA', 'SubB', 'SubC']);
    expect(bundle.stats).toEqual({ found: 5, loaded: 4, skipped: [{ name: 'Broken', reason: 'not an object' }] });
    expect(bundle.journeys.get('SubA')?.innerTreeOnly).toBe(true);
  });

  it('tolerates odd fields instead of dropping the journey', () => {
    const main = bundle.journeys.get('Main');
    expect(main?.nodes.get('s1')?.x).toBe(120); // "120"
    expect(main?.staticNodes.startNode).toEqual({ x: 20, y: 40 });
    expect(main?.staticNodes[F]).toBeUndefined(); // x "abc" dropped
    expect(main?.nodes.get('v1')?.outcomes).toEqual({ outcome: S });
    expect(bundle.warnings.some((w) => w.code === 'bad-connection')).toBe(true);
  });

  it('resolves inner journey references by case and reports missing ones', () => {
    expect(bundle.journeys.get('Main')?.nodes.get('i1')?.config.tree).toBe('SubA');
    expect(bundle.warnings.find((w) => w.code === 'missing-inner-journey')?.message).toContain('"Ghost"');
  });

  it('follows require() into library scripts, in call order, with argument values', () => {
    const scan = scanScript(MAIN_SRC, {
      library: (n) => ({ UiLib: UI_LIB, FormLib: FORM_LIB })[n],
    });
    expect(scan.callbacks.map((c) => [c.type, c.prompt])).toEqual([
      ['TextOutputCallback', 'Hello'],
      ['NameCallback', 'Your city'],
    ]);
    expect(scan.libraries.sort()).toEqual(['FormLib', 'UiLib']);
    expect(scan.builtInLoop).toBe(false);
  });

  it('flags loops, conditions and missing libraries', () => {
    expect(scanScript(LOOP_SRC).builtInLoop).toBe(true);
    expect(scanScript(MISSING_LIB_SRC).missingLibraries).toEqual(['NopeLib']);
    const cond = scanScript(
      `if (callbacks.isEmpty()) { if (nodeState.get('x')) { callbacksBuilder.nameCallback('A'); } }`,
    );
    expect(cond.builtConditionally).toBe(true);
    const plain = scanScript(
      `if (callbacks.isEmpty()) { callbacksBuilder.nameCallback('A'); } else { action.goTo('x'); }`,
    );
    expect(plain.builtConditionally).toBe(false);
    // Methods inherited from Object are not callback builders.
    expect(scanScript(`var s = x.toString(); x.constructor(1);`).callbacks).toEqual([]);
  });

  it('plans through nested sub-journeys with the library callbacks', () => {
    const plan = new Planner(bundle).plan('Main');
    expect(plan.steps[0]?.callbacks.map((c) => c.type)).toEqual(['TextOutputCallback', 'NameCallback']);
    expect(plan.steps[0]?.callbacks[1]?.inputs[0]?.variable).toBe('IN_ASK'); // one input: named after the node
    expect(plan.trail.map((t) => t.journey)).toEqual(['Main', 'Main', 'SubA', 'SubA', 'SubB', 'SubB', 'SubC', 'Main']);
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(['script-loop', 'missing-library', 'unknown-node', 'missing-journey']),
    );
    expect(plan.coverage).toBe('partial');
  });

  it('report marks sub-journeys and lists skipped entries', () => {
    const planner = new Planner(bundle);
    const report = buildReport(
      [...bundle.journeys.keys()].map((n) => planner.plan(n)),
      bundle.meta,
      'x',
      'T',
      bundle,
    );
    expect(report.journeys.find((j) => j.journey === 'SubA')).toMatchObject({ innerTreeOnly: true, usedBy: ['Main'] });
    const md = renderReportMd(report);
    expect(md).toContain('SubB (sub-journey of SubA)');
    expect(md).toContain('## Not loaded (1 of 5)');
  });

  it('the flow page has a tab for every sub-journey, on the path or not', () => {
    const data = buildViewerData(new Planner(bundle, { choose: ['Main/Run A=false'] }).plan('Main'), bundle);
    expect(data.canvases.map((c) => [c.journey, !!c.offPath])).toEqual([
      ['Main', false],
      ['SubA', true],
      ['SubB', true],
      ['SubC', true],
    ]);
  });

  it('inspect summarises without code, and redacts names', () => {
    const text = inspectExport(bundle, { redact: true });
    expect(text).toContain('Journeys: 5 found, 4 loaded, 1 skipped');
    expect(text).toContain('Libraries required but not in the export: L');
    expect(text).toContain('callbacks built in a loop: 1 node(s)');
    expect(text).toContain('CustomVendorNode  (unknown)');
    for (const secret of ['Main', 'SubA', 'UiLib', 'NopeLib', 'Hello', 'Your city', 'Ghost']) {
      expect(text).not.toContain(secret);
    }
  });
});
