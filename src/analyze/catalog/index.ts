import type { JNode, StepKind } from '../../model/types.js';
import { flowHandlers } from './flow.js';
import { mfaHandlers } from './mfa.js';
import { platformHandlers } from './platform.js';
import { scriptedHandlers } from './scripted.js';
import { type CatalogContext, type Handler, info, type NodeInfo } from './types.js';

export type { CatalogContext, NodeInfo } from './types.js';

const registry: Record<string, Handler> = {
  ...platformHandlers,
  ...flowHandlers,
  ...mfaHandlers,
  ...scriptedHandlers,
};

export function isKnownType(type: string): boolean {
  return type === 'PageNode' || type in registry;
}

const KIND_RANK: Record<StepKind, number> = {
  submit: 0,
  optional: 0,
  variant: 0,
  poll: 1,
  redirect: 2,
  suspend: 3,
  manual: 4,
};

/** Callbacks and behaviour of one node. Unknown types return no callbacks and a warning. */
export function describeNode(node: JNode, ctx: CatalogContext): NodeInfo {
  if (node.type === 'PageNode') return describePage(node, ctx);
  const handler = registry[node.type];
  if (!handler) {
    return info({
      known: false,
      warnings: [
        {
          level: 'warn',
          code: 'unknown-node',
          nodeId: node.id,
          message: `${node.name}: node type ${node.type} is not in the catalog; no callbacks assumed`,
        },
      ],
    });
  }
  return handler(node, ctx);
}

function describePage(node: JNode, ctx: CatalogContext): NodeInfo {
  const page = info();
  page.warnings = [];
  page.notes = [];
  for (const child of node.inner ?? []) {
    const ci = describeNode(child, ctx);
    page.callbacks.push(...ci.callbacks);
    if (KIND_RANK[ci.kind] > KIND_RANK[page.kind]) page.kind = ci.kind;
    if (!ci.known) page.known = false;
    page.warnings.push(...(ci.warnings ?? []));
    page.notes.push(...(ci.notes ?? []));
    if (ci.needsSession) page.needsSession = true;
  }
  return page;
}
