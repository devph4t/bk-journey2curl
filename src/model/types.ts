// Shared data model for the CLI and the viewer. Keep this file free of Node-only imports.

export type NodeId = string;

/** Fixed static node ids used by every P1AIC journey. */
export const SUCCESS_NODE_ID = '70e691a5-1e33-4ac3-a356-e7b6d60d92e0';
export const FAILURE_NODE_ID = 'e301438c-0bd0-429c-ab0c-66126501069a';

export type ExportFormat = 'admin-ui' | 'frodo' | 'single-bundle' | 'raw-tree';

export interface ExportMeta {
  format: ExportFormat;
  origin?: string;
  exportTool?: string;
  exportToolVersion?: string;
  exportDate?: string;
}

export interface Script {
  id: string;
  name: string;
  language?: string;
  context?: string;
  evaluatorVersion?: string;
  /** Plain source after decoding. */
  source: string;
}

export interface ExportBundle {
  meta: ExportMeta;
  journeys: Map<string, Journey>;
  scripts: Map<string, Script>;
  warnings: Warning[];
}

export interface Journey {
  id: string;
  entry: NodeId;
  description?: string;
  innerTreeOnly?: boolean;
  /** Canvas positions of Start, Success and Failure. */
  staticNodes: Record<string, { x: number; y: number }>;
  nodes: Map<NodeId, JNode>;
}

export interface JNode {
  id: NodeId;
  type: string;
  name: string;
  /** Canvas position from the export (0 when missing). */
  x: number;
  y: number;
  /** outcome id -> next node */
  outcomes: Record<string, NodeId>;
  /** Outcome ids in the order the node declares them (falls back to `outcomes` keys). */
  outcomeOrder: string[];
  /** Node config (script id, attributes, ...). */
  config: Record<string, unknown>;
  /** Page Node children, in page order. */
  inner?: JNode[];
}

export type InputKind = 'string' | 'number' | 'boolean' | 'fixed';

export interface InputSpec {
  /** IDToken1, IDToken1validateOnly, IDToken2question ... (assigned per step, by callback position). */
  name: string;
  kind: InputKind;
  /** Environment variable that provides the value (IN_USERNAME ...). */
  variable?: string;
  /** Default value (fixed inputs, choice index, ...). */
  value?: unknown;
  /** Solver id when the value is computed from the response at run time. */
  solver?: string;
  /** jq expression (run against the last response) that computes the value. */
  jq?: string;
}

export interface CallbackSpec {
  type: string;
  prompt?: string;
  inputs: InputSpec[];
  origin: 'catalog' | 'script';
  /** Options for Choice / Confirmation callbacks. */
  options?: string[];
  /** Attribute name for *AttributeInputCallback. */
  attribute?: string;
  /** Node that produced this callback (inside a Page Node this is the child node). */
  sourceNodeId?: NodeId;
}

export type StepKind = 'submit' | 'poll' | 'variant' | 'optional' | 'suspend' | 'redirect' | 'manual';

export interface Step {
  index: number;
  journey: string;
  nodeId: NodeId;
  nodeName: string;
  nodeType: string;
  kind: StepKind;
  callbacks: CallbackSpec[];
  /** Outcome taken after this step on the planned path. */
  outcome: string;
  /** Wording for normal users. */
  plainText: string;
  /** Branches the server picks at run time. */
  variants?: Variant[];
  /** For optional steps: why it may or may not appear. */
  condition?: string;
  /** Extra notes (manual instructions, resume command ...). */
  notes?: string[];
  /** Inner-journey nesting level (0 = top journey). */
  depth: number;
}

export interface Variant {
  label: string;
  /** Comma-joined callback types, used to recognise the variant at run time. */
  signature: string;
  callbacks: CallbackSpec[];
  solver?: string;
  /** Kind of the underlying step (submit, suspend ...). */
  kind: StepKind;
  nodeId?: NodeId;
  nodeName?: string;
  notes?: string[];
}

export interface TrailEntry {
  journey: string;
  nodeId: NodeId;
  nodeName: string;
  nodeType: string;
  /** Outcome taken out of this node ('' for the final node). */
  outcome: string;
  depth: number;
}

export type WarningLevel = 'info' | 'warn' | 'error';

export interface Warning {
  level: WarningLevel;
  code: string;
  message: string;
  journey?: string;
  nodeId?: NodeId;
}

export interface InputVar {
  variable: string;
  kind: InputKind;
  /** Default written into the script; CHANGE_ME for secrets/unknowns. */
  defaultValue: string;
  description: string;
  secret?: boolean;
}

export type Coverage = 'full' | 'partial' | 'manual';

export interface Plan {
  journey: string;
  target: 'success' | 'failure';
  steps: Step[];
  trail: TrailEntry[];
  coverage: Coverage;
  /** Why the coverage is not full, in plain words. */
  coverageNotes: string[];
  warnings: Warning[];
  /** Environment variables the generated script reads. */
  inputs: InputVar[];
  /** Headers sent with the first request (Zero Page Login): header -> variable. */
  headers?: Record<string, string>;
  /** Journey that must run first to create a session (from --with-session). */
  needsSession?: boolean;
  withSession?: string;
  /** Nodes not reachable from the entry node. */
  unreachable: NodeId[];
  /** Node types the catalog does not know. */
  unknownTypes: string[];
  /** Whether a path to the target was found at all. */
  reachable: boolean;
}

// ---- Curl blocks (runbook + viewer) ---------------------------------------------------------------

/** A shell snippet that can be copied and run on its own, in order, in one terminal. */
export interface CurlBlock {
  label: string;
  code: string;
}

export interface StepCurl {
  index: number;
  /** One block per variant, otherwise one block. */
  run: CurlBlock[];
  /** Example request body (Postman style) for reading; values shown as <IN_X>. */
  body?: string;
  /** What the server should send next, in plain words. */
  expect: string;
}

export interface CurlSet {
  setup: CurlBlock;
  start: CurlBlock;
  steps: StepCurl[];
  finish: CurlBlock;
  /** Check the session created by the journey (serverinfo cookie name + getSessionInfo). */
  session: CurlBlock;
  /** Prints the callback types of the last response (to pick a variant). */
  types: string;
}

// ---- Flow viewer data ----------------------------------------------------------------------------

export interface ViewerNode {
  id: NodeId;
  name: string;
  type: string;
  x: number;
  y: number;
  outcomes: string[];
  children?: Array<{ name: string; type: string }>;
  innerJourney?: string;
  onPath: boolean;
  /** Step numbers attached to this node (inner journey nodes list their spliced steps). */
  steps: number[];
}

export interface ViewerEdge {
  from: NodeId;
  to: NodeId;
  outcome: string;
  onPath: boolean;
}

export interface ViewerCanvas {
  journey: string;
  entry: NodeId;
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  staticNodes: Record<string, { x: number; y: number }>;
}

export interface ViewerStep {
  index: number;
  kind: StepKind;
  journey: string;
  nodeId: NodeId;
  nodeName: string;
  plainText: string;
  condition?: string;
  notes?: string[];
  callbacks: string;
  variants?: Array<{ label: string; callbacks: string; solver?: string; nodeId?: NodeId; plainText: string }>;
  curl: StepCurl;
}

export interface ViewerData {
  journey: string;
  target: Plan['target'];
  coverage: Coverage;
  coverageNotes: string[];
  warnings: string[];
  source?: string;
  /** Top journey first, then every inner journey on the path. */
  canvases: ViewerCanvas[];
  steps: ViewerStep[];
  curl: Omit<CurlSet, 'steps'>;
  inputs: Array<{ variable: string; defaultValue: string; secret: boolean; description: string }>;
}
