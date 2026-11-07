import { describe, expect, it } from 'vitest';
import { Planner } from '../src/analyze/planner.js';
import { journeyFiles, safeFileName } from '../src/generate/paths.js';
import { generateSh } from '../src/generate/sh.js';
import { buildViewerData } from '../src/generate/viewer-data.js';
import { loadExport } from '../src/load/loader.js';
import { SUCCESS_NODE_ID } from '../src/model/types.js';

// A raw AM tree: no canvas positions, a journey name that needs URL encoding and a safe file name.
const raw = loadExport({
  _id: 'My Login: v2/test',
  entryNodeId: 'u',
  nodes: {
    u: { nodeType: 'UsernameCollectorNode', displayName: 'User', connections: { outcome: 'p' } },
    p: { nodeType: 'PasswordCollectorNode', displayName: 'Pass', connections: { outcome: 'd' } },
    d: { nodeType: 'DataStoreDecisionNode', displayName: 'Check', connections: { true: SUCCESS_NODE_ID, false: 'u' } },
  },
});
const name = 'My Login: v2/test';

describe('review fixes', () => {
  it('file names are safe on every OS', () => {
    expect(safeFileName('My Login: v2/test')).toBe('My Login_ v2_test');
    expect(safeFileName('a<b>|c?*. ')).toBe('a_b__c__');
    expect(safeFileName('...')).toBe('_');
    expect(journeyFiles('A/B')).toEqual({
      dir: 'A_B',
      sh: 'A_B/A_B.sh',
      runbook: 'A_B/A_B.runbook.md',
      viewer: 'A_B/A_B.html',
    });
  });

  it('the journey name is URL-encoded in generated scripts', () => {
    const sh = generateSh(new Planner(raw).plan(name));
    expect(sh).toContain("JOURNEY_PARAM='My%20Login%3A%20v2%2Ftest'");
    expect(sh).toContain('URL="$(auth_url "$JOURNEY_PARAM")"');
    expect(sh).toContain('./My Login_ v2_test.sh');
  });

  it('exports without x/y get a column layout in the viewer', () => {
    const data = buildViewerData(new Planner(raw).plan(name), raw);
    const pos = Object.fromEntries((data.canvases[0]?.nodes ?? []).map((n) => [n.name, [n.x, n.y]]));
    expect(pos).toEqual({ User: [160, 60], Pass: [420, 60], Check: [680, 60] });
  });
});
