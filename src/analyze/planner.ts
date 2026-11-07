import type { BkConfig } from '../config.js';
import {
  type ExportBundle,
  FAILURE_NODE_ID,
  type JNode,
  type Journey,
  type Plan,
  type Step,
  SUCCESS_NODE_ID,
  type TrailEntry,
  type Variant,
  type Warning,
} from '../model/types.js';
import { nameInputs, signature } from './catalog/callbacks.js';
import { type CatalogContext, describeNode, type NodeInfo } from './catalog/index.js';
import { computeCoverage } from './coverage.js';
import { assignInputs } from './inputs.js';
import { stepPlainText } from './plain-text.js';
import { applySolvers } from './solvers.js';

export const MAX_INNER_DEPTH = 5;
const MAX_BRANCH_PATHS = 2000;

export interface PlanOptions {
  target?: 'success' | 'failure';
  /** "<node name or id>=<outcome>" or "<journey>/<node>=<outcome>" */
  choose?: string[];
  config?: BkConfig;
  /** Journey to run first for a session (e.g. Login). */
  withSession?: string;
}

const PREFERRED = [
  'true',
  'success',
  'created',
  'patched',
  'accept',
  'valid',
  'pass',
  'outcome',
  'next',
  'successoutcome',
  'done',
];
const NEGATIVE = [
  'false',
  'failure',
  'failureoutcome',
  'retry',
  'reject',
  'locked',
  'cancelled',
  'expired',
  'error',
  'decline',
  'invalid',
  'unsupported',
  'nodevice',
  'notregisteredoutcome',
  'recoverycodeoutcome',
  'exited',
  'spam',
  'fail',
];

export function outcomeRank(outcome: string): number {
  const o = outcome.toLowerCase();
  const p = PREFERRED.indexOf(o);
  if (p >= 0) return p;
  return NEGATIVE.includes(o) ? 100 + NEGATIVE.indexOf(o) : 50;
}

function outcomePenalty(outcome: string): number {
  const r = outcomeRank(outcome);
  return r < 50 ? 0 : r < 100 ? 1 : 4;
}

interface Pin {
  journey?: string;
  node: string;
  outcome: string;
}

export function parseChoose(list: string[] = []): Pin[] {
  return list.map((c) => {
    const eq = c.lastIndexOf('=');
    if (eq <= 0) throw new Error(`--choose "${c}": expected "<node>=<outcome>"`);
    const left = c.slice(0, eq).trim();
    const outcome = c.slice(eq + 1).trim();
    const slash = left.indexOf('/');
    return slash > 0
      ? { journey: left.slice(0, slash), node: left.slice(slash + 1), outcome }
      : { node: left, outcome };
  });
}

/** A step-producing fragment of a path (one node, or a whole inner journey). */
interface Fragment {
  steps: Step[];
  trail: TrailEntry[];
  warnings: Warning[];
  unknownTypes: string[];
  needsSession: boolean;
  headers: Record<string, string>;
}

interface PathEntry {
  node: JNode;
  outcome: string;
}

function emptyFragment(): Fragment {
  return { steps: [], trail: [], warnings: [], unknownTypes: [], needsSession: false, headers: {} };
}

function mergeInto(into: Fragment, f: Fragment): void {
  into.steps.push(...f.steps);
  into.trail.push(...f.trail);
  for (const w of f.warnings) addWarning(into.warnings, w);
  for (const t of f.unknownTypes) if (!into.unknownTypes.includes(t)) into.unknownTypes.push(t);
  into.needsSession ||= f.needsSession;
  Object.assign(into.headers, f.headers);
}

function addWarning(list: Warning[], w: Warning): void {
  if (!list.some((x) => x.code === w.code && x.message === w.message)) list.push(w);
}

function isTerminal(id: string): boolean {
  return id === SUCCESS_NODE_ID || id === FAILURE_NODE_ID;
}

export class Planner {
  private readonly pins: Pin[];
  private readonly config: BkConfig;
  private readonly infoCache = new Map<string, NodeInfo>();
  private readonly innerCache = new Map<string, Fragment & { reachable: boolean }>();

  constructor(
    private readonly bundle: ExportBundle,
    private readonly opts: PlanOptions = {},
  ) {
    this.config = opts.config ?? {};
    this.pins = parseChoose([...(this.config.choose ?? []), ...(opts.choose ?? [])]);
  }

  /** Plan one journey from its entry node to Success (or Failure). */
  plan(journeyName: string): Plan {
    const target = this.opts.target ?? 'success';
    const journey = this.bundle.journeys.get(journeyName);
    const frag = this.planFragment(journeyName, target, 0, []);
    const plan: Plan = {
      journey: journeyName,
      target,
      steps: frag.steps,
      trail: frag.trail,
      coverage: 'full',
      coverageNotes: [],
      warnings: frag.warnings,
      inputs: [],
      unreachable: journey ? unreachableNodes(journey) : [],
      unknownTypes: frag.unknownTypes,
      reachable: frag.reachable,
    };
    if (Object.keys(frag.headers).length) plan.headers = frag.headers;
    if (frag.needsSession) plan.needsSession = true;
    if (this.opts.withSession) plan.withSession = this.opts.withSession;

    plan.steps.forEach((s, i) => {
      s.index = i + 1;
    });
    applySolvers(plan, this.config);
    plan.inputs = assignInputs(plan, this.config);
    for (const s of plan.steps) s.plainText = stepPlainText(s);
    const cov = computeCoverage(plan);
    plan.coverage = cov.coverage;
    plan.coverageNotes = cov.notes;
    return plan;
  }

  /** All simple paths from the entry node to the target (top journey only, inner journeys as single nodes). */
  paths(journeyName: string, limit = 100): PathEntry[][] {
    const journey = this.bundle.journeys.get(journeyName);
    if (!journey) return [];
    const targetId = (this.opts.target ?? 'success') === 'success' ? SUCCESS_NODE_ID : FAILURE_NODE_ID;
    const out: PathEntry[][] = [];
    const walk = (id: string, acc: PathEntry[], seen: Set<string>) => {
      if (out.length >= limit) return;
      if (id === targetId) {
        out.push([...acc]);
        return;
      }
      const node = journey.nodes.get(id);
      if (!node || seen.has(id)) return;
      seen.add(id);
      for (const o of node.outcomeOrder) {
        const next = node.outcomes[o];
        if (next) walk(next, [...acc, { node, outcome: o }], seen);
      }
      seen.delete(id);
    };
    walk(journey.entry, [], new Set());
    return out;
  }

  // ---- internals -------------------------------------------------------------------------------

  private nodeInfo(journeyName: string, node: JNode): NodeInfo {
    const key = `${journeyName}/${node.id}`;
    let i = this.infoCache.get(key);
    if (!i) {
      const ctx: CatalogContext = { journey: journeyName, scripts: this.bundle.scripts, config: this.config };
      i = describeNode(node, ctx);
      this.infoCache.set(key, i);
    }
    return i;
  }

  private pinFor(journeyName: string, node: JNode): string | undefined {
    for (const p of this.pins) {
      if (p.journey && p.journey !== journeyName) continue;
      const n = p.node.toLowerCase();
      if (node.id === p.node || node.name.toLowerCase() === n || (p.node.length >= 8 && node.id.startsWith(p.node))) {
        return p.outcome;
      }
    }
    return undefined;
  }

  private allowedOutcomes(journeyName: string, node: JNode): string[] {
    const pin = this.pinFor(journeyName, node);
    if (pin && pin in node.outcomes) return [pin];
    return node.outcomeOrder;
  }

  private innerFragment(name: string, target: 'success' | 'failure', depth: number, stack: string[]) {
    const key = `${name}|${target}|${depth}`;
    let f = this.innerCache.get(key);
    if (!f) {
      f = this.planFragment(name, target, depth, stack);
      this.innerCache.set(key, f);
    }
    return f;
  }

  /** Cost of entering a node: interactive nodes (or inner journeys with steps) cost more. */
  private enterCost(journeyName: string, id: string, depth: number, stack: string[]): number {
    if (isTerminal(id)) return 0;
    const node = this.bundle.journeys.get(journeyName)?.nodes.get(id);
    if (!node) return 0;
    const info = this.nodeInfo(journeyName, node);
    if (info.innerJourney) {
      if (depth + 1 > MAX_INNER_DEPTH || stack.includes(info.innerJourney)) return 0;
      const inner = this.innerFragment(info.innerJourney, 'success', depth + 1, [...stack, journeyName]);
      return 3 * inner.steps.length;
    }
    return info.callbacks.length > 0 ? 3 : 0;
  }

  /** Cheapest path (Dijkstra) from `from` to the target terminal. */
  private bestPath(journey: Journey, journeyName: string, targetId: string, depth: number, stack: string[]) {
    const dist = new Map<string, number>([[journey.entry, 0]]);
    const prev = new Map<string, { from: string; outcome: string }>();
    const done = new Set<string>();
    for (;;) {
      let cur: string | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const [id, d] of dist) {
        if (!done.has(id) && d < best) {
          best = d;
          cur = id;
        }
      }
      if (cur === undefined) return undefined;
      if (cur === targetId) break;
      done.add(cur);
      if (isTerminal(cur)) continue;
      const node = journey.nodes.get(cur);
      if (!node) continue;
      const info = this.nodeInfo(journeyName, node);
      const outcomes = this.allowedOutcomes(journeyName, node);
      outcomes.forEach((o, order) => {
        const next = node.outcomes[o];
        if (!next || done.has(next)) return;
        const penalty = info.branching === 'server' ? 0 : outcomePenalty(o);
        const tie = info.branching === 'server' ? order : outcomeRank(o);
        const cost = best + 1 + penalty + this.enterCost(journeyName, next, depth, stack) + tie * 1e-4;
        if (cost < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
          dist.set(next, cost);
          prev.set(next, { from: cur as string, outcome: o });
        }
      });
    }
    const path: PathEntry[] = [];
    let at = targetId;
    while (at !== journey.entry) {
      const p = prev.get(at);
      if (!p) return undefined;
      const node = journey.nodes.get(p.from);
      if (!node) return undefined;
      path.unshift({ node, outcome: p.outcome });
      at = p.from;
    }
    return path;
  }

  private planFragment(
    journeyName: string,
    target: 'success' | 'failure',
    depth: number,
    stack: string[],
  ): Fragment & { reachable: boolean } {
    const frag = { ...emptyFragment(), reachable: false };
    const journey = this.bundle.journeys.get(journeyName);
    if (!journey) {
      frag.warnings.push({
        level: 'error',
        code: 'missing-journey',
        journey: journeyName,
        message: `Journey "${journeyName}" is not in the export`,
      });
      return frag;
    }
    const targetId = target === 'success' ? SUCCESS_NODE_ID : FAILURE_NODE_ID;
    const path = this.bestPath(journey, journeyName, targetId, depth, stack);
    if (!path) {
      frag.warnings.push({
        level: 'error',
        code: 'no-path',
        journey: journeyName,
        message: `No path from the entry node to ${target === 'success' ? 'Success' : 'Failure'}`,
      });
      return frag;
    }
    frag.reachable = true;

    // Main-path positions whose steps are folded into a variant step, or marked optional.
    const folded = new Set<number>();
    const optionalAt = new Map<number, string>();

    path.forEach((entry, i) => {
      const { node, outcome } = entry;
      const info = this.nodeInfo(journeyName, node);
      const nodeFrag = this.nodeFragment(journeyName, entry, depth, stack, folded.has(i));
      const cond = optionalAt.get(i);
      if (cond) {
        for (const s of nodeFrag.steps) {
          s.kind = 'optional';
          s.condition = cond;
        }
      }
      mergeInto(frag, nodeFrag);

      const pinned = this.pinFor(journeyName, node) !== undefined;
      if (pinned && info.branching === 'server') {
        addWarning(frag.warnings, {
          level: 'info',
          code: 'pinned-server-branch',
          journey: journeyName,
          nodeId: node.id,
          message: `${node.name} is decided by the server (${info.serverReason ?? 'run time'}); the plan assumes "${outcome}"`,
        });
      }
      if (info.branching === 'server' && !pinned && info.kind !== 'poll' && node.outcomeOrder.length > 1) {
        const extra = this.analyzeBranches(journeyName, path, i, targetId, depth, stack, folded, optionalAt);
        mergeInto(frag, extra);
      }
    });
    return frag;
  }

  /** Steps, trail and warnings for one path entry (inner journeys are spliced in). */
  private nodeFragment(
    journeyName: string,
    entry: PathEntry,
    depth: number,
    stack: string[],
    skipSteps = false,
  ): Fragment {
    const { node, outcome } = entry;
    const frag = emptyFragment();
    const info = this.nodeInfo(journeyName, node);
    frag.trail.push({
      journey: journeyName,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      outcome,
      depth,
    });
    for (const w of info.warnings ?? []) addWarning(frag.warnings, { ...w, journey: journeyName });
    if (!info.known) frag.unknownTypes.push(node.type);
    if (info.headers) Object.assign(frag.headers, info.headers);
    if (info.needsSession) frag.needsSession = true;

    if (info.innerJourney) {
      const innerName = info.innerJourney;
      if (depth + 1 > MAX_INNER_DEPTH || stack.includes(innerName) || innerName === journeyName) {
        addWarning(frag.warnings, {
          level: 'error',
          code: 'inner-depth',
          journey: journeyName,
          nodeId: node.id,
          message: `${node.name}: inner journey "${innerName}" skipped (recursion or more than ${MAX_INNER_DEPTH} levels)`,
        });
        return frag;
      }
      const innerTarget = outcome === 'false' ? 'failure' : 'success';
      const inner = this.innerFragment(innerName, innerTarget, depth + 1, [...stack, journeyName]);
      const copy = structuredClone({ steps: inner.steps, trail: inner.trail });
      mergeInto(frag, { ...inner, steps: skipSteps ? [] : copy.steps, trail: copy.trail });
      return frag;
    }

    if (info.callbacks.length > 0 && !skipSteps)
      frag.steps.push(this.makeStep(journeyName, node, info, outcome, depth));
    return frag;
  }

  private makeStep(journeyName: string, node: JNode, info: NodeInfo, outcome: string, depth: number): Step {
    const callbacks = structuredClone(info.callbacks);
    nameInputs(callbacks);
    const link = info.links?.[outcome];
    if (link) {
      const input = callbacks[link.callbackIndex]?.inputs[link.inputIndex];
      if (input) input.value = link.value;
    }
    const step: Step = {
      index: 0,
      journey: journeyName,
      nodeId: node.id,
      nodeName: pageTitle(node) ?? node.name,
      nodeType: node.type,
      kind: info.kind,
      callbacks,
      outcome,
      plainText: '',
      depth,
    };
    if (info.notes?.length) step.notes = [...info.notes];
    return step;
  }

  /** Steps along a path segment (no branch analysis). */
  private segmentSteps(journeyName: string, segment: PathEntry[], depth: number, stack: string[]): Fragment {
    const frag = emptyFragment();
    for (const e of segment) mergeInto(frag, this.nodeFragment(journeyName, e, depth, stack));
    return frag;
  }

  /**
   * At a server-decided node, follow each other outcome until it rejoins the main path and decide whether
   * the branches become one variant step, optional steps, or a warning.
   */
  private analyzeBranches(
    journeyName: string,
    path: PathEntry[],
    i: number,
    targetId: string,
    depth: number,
    stack: string[],
    folded: Set<number>,
    optionalAt: Map<number, string>,
  ): Fragment {
    const out = emptyFragment();
    const journey = this.bundle.journeys.get(journeyName);
    const entry = path[i];
    if (!journey || !entry) return out;
    const { node, outcome: chosen } = entry;
    const info = this.nodeInfo(journeyName, node);

    // Position of each main-path node after i; the target terminal sits at path.length.
    const mainPos = new Map<string, number>();
    for (let k = i + 1; k < path.length; k++) {
      const n = path[k]?.node;
      if (n) mainPos.set(n.id, k);
    }
    mainPos.set(targetId, path.length);
    const avoid = new Set(path.slice(0, i + 1).map((e) => e.node.id));

    interface Alt {
      outcome: string;
      segment: PathEntry[];
      rejoin: number;
      frag: Fragment;
    }
    const alts: Alt[] = [];
    for (const o of node.outcomeOrder) {
      if (o === chosen) continue;
      const start = node.outcomes[o];
      if (!start) continue;
      const best = this.bestBranch(journey, journeyName, start, mainPos, avoid, depth, stack);
      if (best) alts.push({ outcome: o, ...best });
    }
    if (!alts.length) return out;

    const rejoin = Math.min(...alts.map((a) => a.rejoin));
    const chosenSeg = path.slice(i + 1, rejoin);
    const chosenFrag = this.segmentSteps(journeyName, chosenSeg, depth, stack);
    const nChosen = chosenFrag.steps.length;
    const counts = alts.map((a) => a.frag.steps.length);
    const conditionText = (o: string) => info.condition?.(o) ?? `${node.name} goes "${o}"`;

    if (nChosen === 1 && counts.every((c) => c === 1)) {
      // One variant step replaces the chosen branch's step.
      for (let k = i + 1; k < rejoin; k++) folded.add(k);
      const variants: Variant[] = [];
      const all = [
        { outcome: chosen, frag: chosenFrag },
        ...alts.map((a) => ({ outcome: a.outcome, frag: a.frag })),
      ].sort((a, b) => node.outcomeOrder.indexOf(a.outcome) - node.outcomeOrder.indexOf(b.outcome));
      for (const b of all) {
        const s = b.frag.steps[0] as Step;
        const v: Variant = {
          label: b.outcome,
          signature: signature(s.callbacks),
          callbacks: s.callbacks,
          kind: s.kind,
          nodeId: s.nodeId,
          nodeName: s.nodeName,
        };
        if (s.notes) v.notes = s.notes;
        variants.push(v);
      }
      const sigs = variants.map((v) => v.signature);
      const dup = sigs.filter((s, k) => sigs.indexOf(s) !== k);
      if (dup.length) {
        addWarning(out.warnings, {
          level: 'warn',
          code: 'variant-ambiguous',
          journey: journeyName,
          nodeId: node.id,
          message: `${node.name}: branches ${variants
            .filter((v) => dup.includes(v.signature))
            .map((v) => v.label)
            .join(', ')} send the same callbacks (${dup[0]}); the script cannot tell them apart`,
        });
      }
      out.steps.push({
        index: 0,
        journey: journeyName,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        kind: 'variant',
        callbacks: [],
        outcome: chosen,
        plainText: '',
        variants,
        depth,
        notes: [`${node.name} decides on the server (${info.serverReason ?? 'run time'})`],
      });
      for (const a of alts) mergeInto(out, { ...a.frag, steps: [], trail: [] });
      return out;
    }

    if (nChosen === 0) {
      const withSteps = alts.filter((a) => a.frag.steps.length > 0);
      const alt = withSteps[0];
      if (alt) {
        const cond = [conditionText(alt.outcome), ...this.branchConditions(journeyName, alt.segment)].join(', and ');
        for (const s of alt.frag.steps) {
          const opt = { ...s, kind: 'optional' as const, condition: cond };
          if (s.kind !== 'submit') opt.notes = [...(s.notes ?? []), `Underlying step kind: ${s.kind}`];
          out.steps.push(opt);
        }
        mergeInto(out, { ...alt.frag, steps: [], trail: [] });
        if (withSteps.length > 1) {
          addWarning(out.warnings, {
            level: 'warn',
            code: 'branch-skipped',
            journey: journeyName,
            nodeId: node.id,
            message: `${node.name}: branches ${withSteps
              .slice(1)
              .map((a) => a.outcome)
              .join(', ')} also add steps; use --choose to plan them`,
          });
        }
      }
      return out;
    }

    if (counts.some((c) => c === 0)) {
      const cond = conditionText(chosen);
      for (let k = i + 1; k < rejoin; k++) optionalAt.set(k, cond);
      return out;
    }

    addWarning(out.warnings, {
      level: 'warn',
      code: 'branch-differs',
      journey: journeyName,
      nodeId: node.id,
      message: `${node.name}: branch${alts.length > 1 ? 'es' : ''} ${alts
        .map((a) => `${a.outcome} (${a.frag.steps.length} step${a.frag.steps.length === 1 ? '' : 's'})`)
        .join(
          ', ',
        )} differ from the planned ${chosen} (${nChosen}); use --choose "${node.name}=<outcome>" to plan ${alts.length > 1 ? 'them' : 'it'}`,
    });
    return out;
  }

  /** Conditions of the server-decided nodes along an alternative branch. */
  private branchConditions(journeyName: string, segment: PathEntry[]): string[] {
    const out: string[] = [];
    for (const e of segment) {
      const info = this.nodeInfo(journeyName, e.node);
      if (info.branching === 'server' && info.condition) out.push(info.condition(e.outcome));
    }
    return out;
  }

  /** Most interactive simple path from `start` until it rejoins the main path. */
  private bestBranch(
    journey: Journey,
    journeyName: string,
    start: string,
    mainPos: Map<string, number>,
    avoid: Set<string>,
    depth: number,
    stack: string[],
  ): { segment: PathEntry[]; rejoin: number; frag: Fragment } | undefined {
    let best: { segment: PathEntry[]; rejoin: number; frag: Fragment; score: number[] } | undefined;
    let explored = 0;
    const seen = new Set<string>();
    const walk = (id: string, acc: PathEntry[], penalty: number) => {
      if (++explored > MAX_BRANCH_PATHS) return;
      const pos = mainPos.get(id);
      if (pos !== undefined) {
        const frag = this.segmentSteps(journeyName, acc, depth, stack);
        const score = [frag.steps.length, -penalty, -acc.length];
        if (!best || compareScore(score, best.score) > 0) best = { segment: [...acc], rejoin: pos, frag, score };
        return;
      }
      if (isTerminal(id) || avoid.has(id) || seen.has(id)) return;
      const node = journey.nodes.get(id);
      if (!node) return;
      seen.add(id);
      const info = this.nodeInfo(journeyName, node);
      for (const o of this.allowedOutcomes(journeyName, node)) {
        const next = node.outcomes[o];
        if (next)
          walk(next, [...acc, { node, outcome: o }], penalty + (info.branching === 'server' ? 0 : outcomePenalty(o)));
      }
      seen.delete(id);
    };
    walk(start, [], 0);
    if (!best) return undefined;
    const { segment, rejoin, frag } = best;
    return { segment, rejoin, frag };
  }
}

function compareScore(a: number[], b: number[]): number {
  for (let k = 0; k < a.length; k++) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function pageTitle(node: JNode): string | undefined {
  if (node.type !== 'PageNode' || node.name !== 'Page Node') return undefined;
  const h = node.config.pageHeader as Record<string, unknown> | undefined;
  const en = h && typeof h.en === 'string' ? h.en : undefined;
  return en ? `Page Node (${en})` : undefined;
}

export function unreachableNodes(journey: Journey): string[] {
  const seen = new Set<string>();
  const queue = [journey.entry];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = journey.nodes.get(id);
    if (n) queue.push(...Object.values(n.outcomes));
  }
  return [...journey.nodes.keys()].filter((id) => !seen.has(id));
}

/** Plan every journey in the bundle (or the given names). */
export function planAll(bundle: ExportBundle, opts: PlanOptions = {}, names?: string[]): Plan[] {
  const planner = new Planner(bundle, opts);
  return (names ?? [...bundle.journeys.keys()]).map((n) => planner.plan(n));
}
