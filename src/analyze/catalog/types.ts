import type { BkConfig } from '../../config.js';
import type { CallbackSpec, JNode, Script, StepKind, Warning } from '../../model/types.js';

/** Input value that sends a node down a given outcome. */
export interface InputLink {
  callbackIndex: number;
  inputIndex: number;
  value: unknown;
}

/**
 * - `preferred`: the outcome follows the user's input or the action succeeding; the planner prefers
 *   positive outcomes (true, success, CREATED ...).
 * - `server`: the server decides (random, login count, data lookup); no preference, and the other
 *   branches are checked for variant or optional steps.
 */
export type Branching = 'preferred' | 'server';

export interface NodeInfo {
  callbacks: CallbackSpec[];
  kind: StepKind;
  branching: Branching;
  /** The catalog knows this node type. */
  known: boolean;
  /** Outcome -> input value that leads to it. */
  links?: Record<string, InputLink>;
  notes?: string[];
  /** Zero Page Login: header name -> variable. */
  headers?: Record<string, string>;
  needsSession?: boolean;
  /** InnerTreeEvaluatorNode: the journey it runs. */
  innerJourney?: string;
  /** Why the server decides (random, data ...). */
  serverReason?: string;
  /** Plain-language condition for optional branches (Login Count every 3rd login ...). */
  condition?: (outcome: string) => string;
  warnings?: Array<Omit<Warning, 'journey'>>;
}

export interface CatalogContext {
  journey: string;
  scripts: Map<string, Script>;
  config: BkConfig;
}

export type Handler = (node: JNode, ctx: CatalogContext) => NodeInfo;

export function info(partial: Partial<NodeInfo> = {}): NodeInfo {
  return { callbacks: [], kind: 'submit', branching: 'preferred', known: true, ...partial };
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function localized(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return str(o.en) ?? str(Object.values(o)[0]);
  }
  return undefined;
}
