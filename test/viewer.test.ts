import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Planner } from '../src/analyze/planner.js';
import { curlSet, submitBlock } from '../src/generate/curl.js';
import { generateViewer, viewerTemplate } from '../src/generate/viewer.js';
import { buildViewerData, injectViewerData } from '../src/generate/viewer-data.js';
import type { ViewerData } from '../src/model/types.js';
import { sample } from './helpers.js';

const planner = new Planner(sample());
const opts = { tenant: 'https://tenant.example.com', realm: 'alpha' };
const hasBash = spawnSync('bash', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'bkj2c-viewer-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('copyable curl blocks', () => {
  const set = curlSet(planner.plan('DemoSignup'), opts);

  it('setup exports the tenant, URL and every input', () => {
    expect(set.setup.code).toContain("export TENANT='https://tenant.example.com'");
    expect(set.setup.code).toContain(
      'URL="$TENANT/am/json/realms/root/realms/alpha/authenticate?authIndexType=service&authIndexValue=DemoSignup"',
    );
    expect(set.setup.code).toContain('export IN_CHANNEL="${IN_CHANNEL:-0}"');
    expect(set.setup.code).toContain('export IN_PASSWORD="${IN_PASSWORD:-CHANGE_ME}"');
  });

  it('every request uses the headers that work against P1AIC', () => {
    for (const code of [set.start.code, ...set.steps.flatMap((s) => s.run.map((b) => b.code))]) {
      if (!code.includes('curl ')) continue;
      expect(code).toContain("'Accept-API-Version: resource=2.1, protocol=1.0'");
      expect(code).toContain("'X-Requested-With: ForgeRock'");
      expect(code).toContain('-b cookies.txt -c cookies.txt');
    }
  });

  it('a step posts the last response back with its inputs filled (keeps _id)', () => {
    const page = set.steps[1]?.run[0]?.code ?? '';
    expect(page).toContain('--arg v1 "$IN_USERNAME"');
    expect(page).toContain('.callbacks[4].input[0].value = $v5');
    expect(page).toContain('<<<"$RESP"');
    expect(set.steps[1]?.body).toContain('"_id":0');
    expect(set.steps[0]?.run[0]?.code).toContain('--argjson v1 "$IN_CHANNEL"');
  });

  it('variant steps get one block per variant with the solver jq', () => {
    const v = set.steps[2];
    expect(v?.run.map((b) => b.label)).toEqual([
      'Step 3 – if the server sent NameCallback (math)',
      'Step 3 – if the server sent TextOutputCallback,NameCallback (phrase)',
      'Step 3 – if the server sent HiddenValueCallback,PasswordCallback (pin)',
    ]);
    expect(v?.run[0]?.code).toContain('capture(');
    expect(v?.expect).toBe('TextOutputCallback,ConfirmationCallback');
  });

  it('suspend steps print the resume call', () => {
    const reg = curlSet(planner.plan('Registration'), opts);
    expect(reg.steps[1]?.run[0]?.code).toContain('"$URL&suspendedId=$SUSPENDED_ID"');
  });

  it('a step without inputs posts the response as is', () => {
    expect(submitBlock([], 'x').code).toContain('-d "$RESP")');
  });

  it.runIf(hasBash)('every block is valid bash', () => {
    const all = [...sample().journeys.keys()].flatMap((n) => {
      const s = curlSet(new Planner(sample(), { withSession: 'Login' }).plan(n), opts);
      return [s.setup, s.start, ...s.steps.flatMap((x) => x.run), s.finish, s.session].map((b) => b.code);
    });
    const file = join(dir, 'blocks.sh');
    writeFileSync(file, all.join('\n\n'));
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });
});

describe('viewer data', () => {
  const data = buildViewerData(planner.plan('DemoSignup'), sample(), opts);

  it('has the top journey and every inner journey on the path', () => {
    expect(data.canvases.map((c) => c.journey)).toEqual(['DemoSignup', 'DemoVerifySub', 'DemoPreferencesSub']);
  });

  it('keeps export positions and marks the planned path', () => {
    const top = data.canvases[0];
    const channel = top?.nodes.find((n) => n.name === 'Choose Channel');
    expect(channel).toMatchObject({
      x: 497,
      y: 232.5,
      onPath: true,
      steps: [1],
      outcomes: ['web', 'mobile', 'partner'],
    });
    expect(top?.edges.find((e) => e.from === channel?.id && e.outcome === 'web')?.onPath).toBe(true);
    expect(top?.edges.find((e) => e.from === channel?.id && e.outcome === 'partner')?.onPath).toBe(false);
    const page = top?.nodes.find((n) => n.name === 'Registration Page');
    expect(page?.children?.map((c) => c.type)).toEqual([
      'ValidatedUsernameNode',
      'AttributeCollectorNode',
      'ValidatedPasswordNode',
    ]);
  });

  it('attaches steps to nodes, inner journeys and variant nodes', () => {
    const top = data.canvases[0];
    expect(top?.nodes.find((n) => n.name === 'Inner Tree: Verify')?.steps).toEqual([3]);
    const sub = data.canvases[1];
    expect(
      sub?.nodes
        .filter((n) => n.steps.includes(3))
        .map((n) => n.name)
        .sort(),
    ).toEqual(['Math Challenge', 'PIN Challenge', 'Phrase Challenge', 'Random Challenge Picker']);
  });

  it('never embeds secret defaults', () => {
    const d = buildViewerData(
      new Planner(sample(), { config: { inputs: { IN_PASSWORD: 'S3cret!' } } }).plan('Login'),
      sample(),
      opts,
    );
    expect(JSON.stringify(d)).not.toContain('S3cret!');
  });

  it('injects data safely into the page', () => {
    const tpl = '<title>Journey Flow</title><script id="bkj2c-data" type="application/json">__BKJ2C_DATA__</script>';
    const evil = { ...data, journey: '</script><b>x' } as ViewerData;
    const html = injectViewerData(tpl, evil);
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('<title>&#60;/script&#62;&#60;b&#62;x Flow</title>');
    const json = /<script id="bkj2c-data" type="application\/json">(.*)<\/script>/s.exec(html)?.[1] ?? '';
    expect(JSON.parse(json).journey).toBe('</script><b>x');
    expect(() => injectViewerData('<html></html>', data)).toThrow(/placeholder/);
  });

  it.runIf(viewerTemplate() !== undefined)('the built viewer page embeds the plan', () => {
    const html = generateViewer(planner.plan('Login'), sample(), opts) ?? '';
    expect(html).toContain('<title>Login Flow</title>');
    expect(html).toContain('"journey":"Login"');
    expect(html).not.toContain('>__BKJ2C_DATA__<');
  });
});
