#!/usr/bin/env node
import { basename } from 'node:path';
import { Command, Option } from 'commander';
import { Planner, type PlanOptions } from './analyze/planner.js';
import { type BkConfig, loadConfig } from './config.js';
import { envSettings, loadDotEnv } from './env.js';
import { inspectExport } from './format/inspect.js';
import { formatPlan } from './format/plan-text.js';
import { coverageBelow } from './generate/report.js';
import { writeJourneyFiles, writeReport } from './generate/write.js';
import { loadExportFile } from './load/loader.js';
import type { Coverage, ExportBundle, Plan } from './model/types.js';

interface CommonOpts {
  journey?: string[];
  choose?: string[];
  target?: 'success' | 'failure';
  config?: string;
  debug?: boolean;
  excludeInner?: boolean;
  quiet?: boolean;
}

interface OutOpts extends CommonOpts {
  out?: string;
  tenant?: string;
  realm?: string;
  withSession?: string;
  minCoverage?: Coverage;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

function withCommon(cmd: Command): Command {
  return cmd
    .argument('[export]', 'journey export file (Platform Admin UI 1.1, Frodo, or raw tree JSON); default: BKJ2C_EXPORT')
    .option('-j, --journey <name>', 'journey to process (repeatable; default: all)', collect)
    .option('--choose <node=outcome>', 'pin a branch, e.g. "Choose Channel=partner" (repeatable)', collect)
    .addOption(
      new Option('--target <target>', 'plan to Success or Failure').choices(['success', 'failure']).default('success'),
    )
    .option('-c, --config <file>', 'bk.config.json (default: ./bk.config.json if present)')
    .option('--exclude-inner', 'skip journeys marked "inner tree only" (default: every journey is included)')
    .option('-q, --quiet', 'do not print loader warnings')
    .option('--debug', 'dump intermediate objects as JSON to stderr');
}

function withOut(cmd: Command): Command {
  return cmd
    .option('-o, --out <dir>', 'output directory (default: BKJ2C_OUT or out)')
    .option('--tenant <url>', 'tenant base URL, e.g. https://openam-xyz.forgeblocks.com (default: BKJ2C_TENANT)')
    .option('--realm <realm>', 'realm (default: BKJ2C_REALM or alpha)')
    .option(
      '--with-session <journey>',
      'run this journey first for journeys that need a session (default: BKJ2C_WITH_SESSION)',
    );
}

function withMinCoverage(cmd: Command): Command {
  return cmd.addOption(
    new Option(
      '--min-coverage <level>',
      'exit with code 2 if any journey is below this coverage (default: BKJ2C_MIN_COVERAGE)',
    ).choices(['full', 'partial', 'manual']),
  );
}

/** Fill unset options from BKJ2C_* environment variables (and .env). Flags always win. */
function resolve<T extends CommonOpts & Partial<OutOpts>>(file: string | undefined, opts: T): [string, T] {
  const env = envSettings();
  const exportFile = file ?? env.export;
  if (!exportFile) throw new Error('no export file: pass one, or set BKJ2C_EXPORT in .env');
  return [
    exportFile,
    {
      ...opts,
      out: opts.out ?? env.out ?? 'out',
      tenant: opts.tenant ?? env.tenant,
      realm: opts.realm ?? env.realm,
      withSession: opts.withSession ?? env.withSession,
      minCoverage: opts.minCoverage ?? env.minCoverage,
    },
  ];
}

/** Say how many journeys were found and loaded, and why anything was skipped (stderr). */
function printLoadSummary(file: string, bundle: ExportBundle, quiet?: boolean): void {
  const { found, loaded, skipped } = bundle.stats;
  const inner = [...bundle.journeys.values()].filter((j) => j.innerTreeOnly).length;
  const libs = [...bundle.scripts.values()].filter((s) => s.library).length;
  process.stderr.write(
    `${basename(file)}: ${loaded} of ${found} journeys loaded (${inner} inner-tree-only), ` +
      `${bundle.scripts.size} scripts (${libs} libraries)\n`,
  );
  for (const s of skipped) process.stderr.write(`skipped: ${s.name}: ${s.reason}\n`);
  if (quiet) return;
  for (const w of bundle.warnings) process.stderr.write(`${w.level}: ${w.message}\n`);
}

interface Loaded {
  bundle: ExportBundle;
  config: BkConfig;
  names: string[];
}

function load(file: string, opts: CommonOpts): Loaded {
  const config = loadConfig(opts.config);
  const bundle = loadExportFile(file);
  printLoadSummary(file, bundle, opts.quiet);
  const session = (opts as { withSession?: string }).withSession;
  if (session && !bundle.journeys.has(session)) {
    throw new Error(`--with-session: journey "${session}" is not in the export`);
  }
  let names = opts.journey?.length ? opts.journey : [...bundle.journeys.keys()];
  for (const n of names) {
    if (!bundle.journeys.has(n)) {
      throw new Error(`Journey "${n}" is not in the export (have: ${[...bundle.journeys.keys()].join(', ')})`);
    }
  }
  if (!opts.journey?.length && opts.excludeInner) {
    const innerOnly = new Set([...bundle.journeys.values()].filter((j) => j.innerTreeOnly).map((j) => j.id));
    names = names.filter((n) => !innerOnly.has(n));
  }
  names.sort((a, b) => a.localeCompare(b));
  return { bundle, config, names };
}

function planOptions(opts: CommonOpts & { withSession?: string }, config: BkConfig): PlanOptions {
  return { target: opts.target, choose: opts.choose, config, withSession: opts.withSession };
}

function debugDump(opts: CommonOpts, label: string, value: unknown) {
  if (!opts.debug) return;
  const replacer = (_k: string, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v);
  process.stderr.write(`--- ${label}\n${JSON.stringify(value, replacer, 2)}\n`);
}

function planAllNamed(file: string, opts: CommonOpts & { withSession?: string }) {
  const { bundle, config, names } = load(file, opts);
  debugDump(opts, 'ExportBundle', bundle);
  const planner = new Planner(bundle, planOptions(opts, config));
  const plans = names.map((n) => planner.plan(n));
  debugDump(opts, 'Plans', plans);
  return { bundle, config, planner, plans };
}

function genFiles(file: string, opts: OutOpts & { out: string }) {
  const ctx = planAllNamed(file, opts);
  const written = writeJourneyFiles(ctx.plans, ctx.planner, {
    out: opts.out,
    tenant: opts.tenant ?? ctx.config.tenant,
    realm: opts.realm ?? ctx.config.realm,
    source: basename(file),
    withSession: opts.withSession,
    bundle: ctx.bundle,
  });
  if (!written.some((p) => p.endsWith('.html'))) {
    process.stderr.write(`note: flow viewer not built, so no <journey>.html (run npm run build)${'\n'}`);
  }
  for (const p of written) process.stdout.write(`wrote ${p}\n`);
  return ctx;
}

function reportFiles(file: string, opts: OutOpts & { out: string }, plans: Plan[], bundle: ExportBundle) {
  const { report, written } = writeReport(plans, bundle.meta, { out: opts.out, source: basename(file), bundle });
  for (const p of written) process.stdout.write(`wrote ${p}\n`);
  const s = report.summary;
  process.stdout.write(`${s.journeys} journeys: ${s.full} full, ${s.partial} partial, ${s.manual} manual\n`);
  if (opts.minCoverage) {
    const min = opts.minCoverage;
    const below = plans.filter((p) => coverageBelow(p.coverage, min));
    if (below.length) {
      process.stderr.write(
        `coverage below ${opts.minCoverage}: ${below.map((p) => `${p.journey} (${p.coverage})`).join(', ')}\n`,
      );
      process.exitCode = 2;
    }
  }
}

export function main(argv = process.argv): void {
  const program = new Command();
  program
    .name('bkj2c')
    .description('Turn a PingOne Advanced Identity Cloud journey export into curl scripts, a flow viewer and a report')
    .version('0.1.0');

  withCommon(program.command('plan').description('print the planned path and steps of each journey')).action(
    (arg: string | undefined, raw: CommonOpts) => {
      const [file, opts] = resolve(arg, raw);
      const { plans } = planAllNamed(file, opts);
      process.stdout.write(`${plans.map(formatPlan).join('\n\n')}\n`);
    },
  );

  program
    .command('inspect')
    .description('summarise the export structure (journeys, sub-journeys, libraries, skipped, unknown types)')
    .argument('[export]', 'journey export file; default: BKJ2C_EXPORT')
    .option('--redact', 'replace journey and library names with J1, L1 ... so the output can be shared')
    .option('-c, --config <file>', 'bk.config.json (default: ./bk.config.json if present)')
    .action((arg: string | undefined, raw: { redact?: boolean; config?: string }) => {
      const [file] = resolve(arg, {});
      const bundle = loadExportFile(file);
      process.stdout.write(`${inspectExport(bundle, { redact: raw.redact, config: loadConfig(raw.config) })}\n`);
    });

  withCommon(program.command('paths').description('list every simple path to the target (pick one with --choose)'))
    .option('--limit <n>', 'maximum paths per journey', '50')
    .action((arg: string | undefined, raw: CommonOpts & { limit: string }) => {
      const [file, opts] = resolve(arg, raw);
      const { bundle, config, names } = load(file, opts);
      const planner = new Planner(bundle, planOptions(opts, config));
      for (const n of names) {
        const paths = planner.paths(n, Number(opts.limit));
        process.stdout.write(`Journey: ${n}  (${paths.length} path${paths.length === 1 ? '' : 's'})\n`);
        paths.forEach((p, i) => {
          const text = p.map((e) => `${e.node.name} --${e.outcome}-->`).join(' ');
          const end = opts.target === 'failure' ? 'Failure' : 'Success';
          process.stdout.write(`  ${String(i + 1).padStart(2)}. ${text} ${end}\n`);
        });
        process.stdout.write('\n');
      }
    });

  withOut(
    withCommon(
      program.command('gen').description('write <out>/<journey>/<journey>.sh, .runbook.md and .html (flow viewer)'),
    ),
  ).action((arg: string | undefined, raw: OutOpts) => {
    const [file, opts] = resolve(arg, raw);
    genFiles(file, opts as OutOpts & { out: string });
  });

  withMinCoverage(
    withOut(withCommon(program.command('report').description('write index.html, report.json and report.md'))),
  ).action((arg: string | undefined, raw: OutOpts) => {
    const [file, opts] = resolve(arg, raw);
    const { plans, bundle } = planAllNamed(file, opts);
    reportFiles(file, opts as OutOpts & { out: string }, plans, bundle);
  });

  withMinCoverage(withOut(withCommon(program.command('all').description('gen + report')))).action(
    (arg: string | undefined, raw: OutOpts) => {
      const [file, opts] = resolve(arg, raw);
      const o = opts as OutOpts & { out: string };
      const { plans, bundle } = genFiles(file, o);
      reportFiles(file, o, plans, bundle);
    },
  );

  program.parse(argv);
}

try {
  loadDotEnv();
  main();
} catch (e) {
  process.stderr.write(`bkj2c: ${(e as Error).message}\n`);
  process.exit(1);
}
