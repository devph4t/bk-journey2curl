import type { ViewerCanvas, ViewerNode } from '../../src/model/types';

// Geometry of a node card, in canvas units. Positions come from the export (same as the P1AIC canvas).
export const NODE_W = 190;
export const PAGE_W = 210;
const HEAD = 50;
const CHILD = 34;
const ROW = 19;
const PAD = 10;
export const BOX_GAP = 12;
export const BOX_H = 74;
export const START_R = 28;
export const END_R = 22;

export const SUCCESS = '70e691a5-1e33-4ac3-a356-e7b6d60d92e0';
export const FAILURE = 'e301438c-0bd0-429c-ab0c-66126501069a';

export function nodeWidth(n: ViewerNode): number {
  return n.children?.length ? PAGE_W : NODE_W;
}

export function nodeHeight(n: ViewerNode): number {
  const children = n.children?.length ?? 0;
  // Inner tree nodes get room for their "Open" button under the outcome rows.
  return HEAD + (children ? children * CHILD + PAD : 0) + n.outcomes.length * ROW + PAD + (n.innerJourney ? 30 : 0);
}

/** Right-side port of an outcome row. */
export function outPort(n: ViewerNode, outcome: string): { x: number; y: number } {
  const i = Math.max(0, n.outcomes.indexOf(outcome));
  const children = n.children?.length ?? 0;
  const top = HEAD + (children ? children * CHILD + PAD : 0);
  return { x: n.x + nodeWidth(n), y: n.y + top + i * ROW + ROW / 2 };
}

export function inPort(n: ViewerNode): { x: number; y: number } {
  return { x: n.x, y: n.y + 26 };
}

export function childTop(i: number): number {
  return HEAD + i * CHILD;
}

export function rowTop(n: ViewerNode, i: number): number {
  const children = n.children?.length ?? 0;
  return HEAD + (children ? children * CHILD + PAD : 0) + i * ROW;
}

export interface Bounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** Canvas bounds including Start/Success/Failure and the curl boxes under step nodes. */
export function bounds(c: ViewerCanvas, withBoxes: boolean): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of c.nodes) {
    add(n.x, n.y);
    const boxes = withBoxes && n.steps.length ? BOX_GAP + BOX_H : 0;
    add(n.x + Math.max(nodeWidth(n), withBoxes && n.steps.length ? 250 : 0), n.y + nodeHeight(n) + boxes);
  }
  for (const p of Object.values(c.staticNodes)) {
    add(p.x - START_R, p.y - START_R);
    add(p.x + START_R * 2 + 40, p.y + START_R * 2 + 20);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 400, height: 300 };
  const pad = 40;
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/** Center of a static node circle (positions in the export are the top-left corner). */
export function staticCenter(c: ViewerCanvas, id: string): { x: number; y: number } | undefined {
  const p = c.staticNodes[id === 'start' ? 'startNode' : id];
  if (!p) return undefined;
  const r = id === 'start' ? START_R : END_R;
  return { x: p.x + r, y: p.y + r };
}

export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
