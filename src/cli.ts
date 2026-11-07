#!/usr/bin/env node
import { basename } from 'node:path';
import { Command, Option } from 'commander';
import { Planner, type PlanOptions } from './analyze/planner.js';
import { type BkConfig, loadConfig } from './config.js';
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
  includeInner?: boolean;
}

interface OutOpts extends CommonOpts {
  out: string;
  tenant?: string;
  realm?: string;
  withSession?: string;
  minCoverage?: Coverage;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

function withCommon(cmd: Command): Command {
  return cmd
    .argument('<export>', 'journey export file (Platform Admin UI 1.1, Frodo, or raw tree JSON)')
    .option('-j, --journey <name>', 'journey to process (repeatable; default: all)', collect)
    .option('--choose <node=outcome>', 'pin a branch, e.g. "Choose Channel=partner" (repeatable)', collect)
    .addOption(
      new Option('--target <target>', 'plan to Success or Failure').choices(['success', 'failure']).default('success'),
    )
    .option('-c, --config <file>', 'bk.config.json (default: ./bk.config.json if present)')
    .option('--include-inner', 'also process journeys marked inner-tree-only')
    .option('--debug', 'dump intermediate objects as JSON to stderr');
}

function withOut(cmd: Command): Command {
  return cmd
    .option('-o, --out <dir>', 'output directory', 'out')
    .option('--tenant <url>', 'tenant base URL, e.g. https://openam-xyz.forgeblocks.com')
    .option('--realm <realm>', 'realm (default alpha)')
    .option('--with-session <journey>', 'run this journey first for journeys that need a session');
}

function withMinCoverage(cmd: Command): Command {
  return cmd.addOption(
    new Option('--min-coverage <level>', 'exit with code 2 if any journey is below this coverage (for CI)').choices([
      'full',
      'partial',
      'manual',
    ]),
  );
}

interface Loaded {
  bundle: ExportBundle;
  config: BkConfig;
  names: string[];
}

function load(file: string, opts: CommonOpts): Loaded {
  const config = loadConfig(opts.config);
  const bundle = loadExportFile(file);
  for (const w of bundle.warnings) process.stderr.write(`warning: ${w.message}\n`);
  let names = opts.journey?.length ? opts.journey : [...bundle.journeys.keys()];
  for (const n of names) {
    if (!bundle.journeys.has(n)) {
      throw new Error(`Journey "${n}" is not in the export (have: ${[...bundle.journeys.keys()].join(', ')})`);
    }
  }
  if (!opts.journey?.length && !opts.includeInner) {
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

function genFiles(file: string, opts: OutOpts) {
  const ctx = planAllNamed(file, opts);
  const written = writeJourneyFiles(ctx.plans, ctx.planner, {
    out: opts.out,
    tenant: opts.tenant ?? ctx.config.tenant,
    realm: opts.realm ?? ctx.config.realm,
    source: basename(file),
    withSession: opts.withSession,
  });
  for (const p of written) process.stdout.write(`wrote ${p}\n`);
  return ctx;
}

function reportFiles(file: string, opts: OutOpts, plans: Plan[], bundle: ExportBundle) {
  const { report, written } = writeReport(plans, bundle.meta, { out: opts.out, source: basename(file) });
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
    (file: string, opts: CommonOpts) => {
      const { plans } = planAllNamed(file, opts);
      process.stdout.write(`${plans.map(formatPlan).join('\n\n')}\n`);
    },
  );

  withCommon(program.command('paths').description('list every simple path to the target (pick one with --choose)'))
    .option('--limit <n>', 'maximum paths per journey', '50')
    .action((file: string, opts: CommonOpts & { limit: string }) => {
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

  withOut(withCommon(program.command('gen').description('write <out>/<journey>/<journey>.sh and .runbook.md'))).action(
    (file: string, opts: OutOpts) => {
      genFiles(file, opts);
    },
  );

  withMinCoverage(
    withOut(withCommon(program.command('report').description('write index.html, report.json and report.md'))),
  ).action((file: string, opts: OutOpts) => {
    const { plans, bundle } = planAllNamed(file, opts);
    reportFiles(file, opts, plans, bundle);
  });

  withMinCoverage(withOut(withCommon(program.command('all').description('gen + report')))).action(
    (file: string, opts: OutOpts) => {
      const { plans, bundle } = genFiles(file, opts);
      reportFiles(file, opts, plans, bundle);
    },
  );

  program.parse(argv);
}

try {
  main();
} catch (e) {
  process.stderr.write(`bkj2c: ${(e as Error).message}\n`);
  process.exit(1);
}
