import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/load/detect.js';
import { loadExport } from '../src/load/loader.js';
import { decodeScript } from '../src/load/script-decode.js';
import { SUCCESS_NODE_ID } from '../src/model/types.js';
import { sample } from './helpers.js';

describe('decodeScript', () => {
  it('unwraps a JSON string inside a string (Admin UI)', () => {
    expect(decodeScript("\"var langs = ['en'];\\naction.goTo('next');\"")).toBe(
      "var langs = ['en'];\naction.goTo('next');",
    );
  });
  it('unwraps several levels', () => {
    expect(decodeScript(JSON.stringify(JSON.stringify('outcome = "true";')))).toBe('outcome = "true";');
  });
  it('joins Frodo line arrays', () => {
    expect(decodeScript(['var a = 1;', 'action.goTo("x");'])).toBe('var a = 1;\naction.goTo("x");');
  });
  it('decodes base64 from raw AM exports', () => {
    const src = "action.goTo('next');";
    expect(decodeScript(Buffer.from(src).toString('base64'))).toBe(src);
  });
  it('leaves plain source alone', () => {
    expect(decodeScript("action.goTo('next');")).toBe("action.goTo('next');");
    expect(decodeScript('abcdefgh')).toBe('abcdefgh');
  });
});

describe('detectFormat', () => {
  it('detects Admin UI exports', () => {
    const d = detectFormat({ meta: { exportTool: 'platform-admin ui tree export' }, trees: { A: { tree: {} } } });
    expect(d.format).toBe('admin-ui');
    expect(Object.keys(d.bundles)).toEqual(['A']);
  });
  it('detects Frodo exports', () => {
    expect(detectFormat({ meta: { exportTool: 'frodo' }, trees: {} }).format).toBe('frodo');
  });
  it('detects a single bundle and a raw tree', () => {
    expect(detectFormat({ tree: { _id: 'X', entryNodeId: 'a' }, nodes: {} }).format).toBe('single-bundle');
    expect(detectFormat({ _id: 'X', entryNodeId: 'a', nodes: {} }).format).toBe('raw-tree');
  });
  it('rejects unknown documents', () => {
    expect(() => detectFormat({ hello: 1 })).toThrow(/Unknown export format/);
  });
});

describe('loadExport', () => {
  it('loads every journey of the sample export', () => {
    const b = sample();
    expect(b.meta.format).toBe('admin-ui');
    expect(b.journeys.size).toBe(13);
    expect(b.scripts.size).toBe(17);
    expect(b.warnings).toEqual([]);
  });

  it('keeps x/y, outcomes and page children', () => {
    const login = sample().journeys.get('Login');
    const page = login?.nodes.get(login.entry);
    expect(page).toMatchObject({ type: 'PageNode', x: 210, y: 103.5, outcomes: { outcome: expect.any(String) } });
    expect(page?.inner?.map((c) => c.type)).toEqual(['ValidatedUsernameNode', 'ValidatedPasswordNode']);
    expect(page?.inner?.[0]?.config.validateInput).toBe(false);
    expect(login?.staticNodes[SUCCESS_NODE_ID]).toBeDefined();
  });

  it('orders outcomes as the node declares them', () => {
    const login = sample().journeys.get('Login');
    const ids = [...(login?.nodes.values() ?? [])].find((n) => n.type === 'IdentityStoreDecisionNode');
    expect(ids?.outcomeOrder).toEqual(['TRUE', 'FALSE', 'LOCKED', 'CANCELLED', 'EXPIRED']);
  });

  it('decodes scripts to plain source', () => {
    const s = [...sample().scripts.values()].find((x) => x.name === 'Demo - channel');
    expect(s?.source.startsWith("var choices = ['web','mobile','partner'];")).toBe(true);
  });

  it('accepts Frodo innernodes and line-array scripts', () => {
    const b = loadExport({
      meta: { exportTool: 'frodo' },
      trees: {
        J: {
          tree: {
            _id: 'J',
            entryNodeId: 'p',
            nodes: { p: { nodeType: 'PageNode', displayName: 'Page', connections: { outcome: SUCCESS_NODE_ID } } },
          },
          nodes: { p: { _id: 'p', nodes: [{ _id: 'c', nodeType: 'ValidatedUsernameNode', displayName: 'U' }] } },
          innernodes: { c: { _id: 'c', validateInput: true } },
          scripts: { s1: { name: 'S', script: ['var a = 1;', 'action.goTo("x");'] } },
        },
      },
    });
    expect(b.meta.format).toBe('frodo');
    expect(b.journeys.get('J')?.nodes.get('p')?.inner?.[0]?.config.validateInput).toBe(true);
    expect(b.scripts.get('s1')?.source).toBe('var a = 1;\naction.goTo("x");');
  });

  it('keeps a journey with problems and says what is wrong; skips only entries without a tree', () => {
    const b = loadExport({ trees: { Bad: { tree: { nodes: {} } }, Junk: 42, NoTree: { meta: {} } } });
    expect([...b.journeys.keys()]).toEqual(['Bad']);
    expect(b.warnings[0]).toMatchObject({ code: 'bad-entry', journey: 'Bad' });
    expect(b.stats).toEqual({
      found: 3,
      loaded: 1,
      skipped: [
        { name: 'Junk', reason: 'not an object' },
        { name: 'NoTree', reason: 'no "tree" object' },
      ],
    });
  });
});
