import type { ViewerCanvas, ViewerNode, ViewerStep } from '../../src/model/types';
import { CopyButton } from './CodeBlock';
import {
  BOX_GAP,
  type Bounds,
  childTop,
  END_R,
  edgePath,
  FAILURE,
  inPort,
  nodeHeight,
  nodeWidth,
  outPort,
  rowTop,
  START_R,
  SUCCESS,
  staticCenter,
} from './layout';

export type Mode = 'simple' | 'engineer';

/** Props that make a card act like a button (click, Enter, Space) while it can contain other buttons. */
function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
  };
}

interface Props {
  canvas: ViewerCanvas;
  steps: ViewerStep[];
  bounds: Bounds;
  scale: number;
  mode: Mode;
  selected: number | undefined;
  onSelectStep: (n: number) => void;
  onOpenJourney: (name: string) => void;
}

const TYPE_LABEL: Record<string, string> = {
  PageNode: 'Page Node',
  ScriptedDecisionNode: 'Scripted Decision',
  InnerTreeEvaluatorNode: 'Inner Tree Evaluator',
};

function typeLabel(t: string): string {
  return (TYPE_LABEL[t] ?? t.replace(/Node$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')).toUpperCase();
}

/** One-line summary of what a curl block sends: its IN_* variables, a computed answer, or nothing. */
function blockSummary(code: string | undefined): string {
  if (!code) return '';
  if (code.includes('suspendedId')) return 'wait for the email, then resume';
  if (code.includes('# Needs a person')) return 'finish in a browser';
  const vars = [...new Set(code.match(/\$IN_[A-Z0-9_]+/g) ?? [])].map((v) => v.slice(1));
  const computed = /# (math-sum|echo-text|echo-hidden|custom|[\w-]+)$/m.test(code) && code.includes('= (');
  const parts = [...vars, ...(computed ? ['computed answer'] : [])];
  return parts.length ? `POST ${parts.join(', ')}` : 'POST the response back';
}

function StepBadge({ n, active }: { n: number; active: boolean }) {
  return <span class={`badge-num${active ? ' active' : ''}`}>{n}</span>;
}

function CurlBox({
  node,
  steps,
  selected,
  onSelect,
}: {
  node: ViewerNode;
  steps: ViewerStep[];
  selected: number | undefined;
  onSelect: (n: number) => void;
}) {
  const own = steps.filter((s) => node.steps.includes(s.index));
  if (!own.length) return null;
  const top = node.y + nodeHeight(node) + BOX_GAP;
  const width = Math.max(nodeWidth(node), 250);
  // An inner journey node lists its steps; a step node shows its own curl.
  if (node.innerJourney) {
    return (
      <div class="curlbox inner" style={{ left: node.x, top, width }}>
        <div class="curlbox-head">
          <span>Steps in {node.innerJourney}</span>
        </div>
        <div class="curlbox-steps">
          {own.map((s) => (
            <button key={s.index} type="button" class="chip" onClick={() => onSelect(s.index)}>
              {s.index}. {s.kind}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const s = own[0] as ViewerStep;
  const isVariantChild = s.nodeId !== node.id;
  if (s.kind === 'variant' && !isVariantChild) {
    return (
      <div
        class={`curlbox${selected === s.index ? ' selected' : ''}`}
        style={{ left: node.x, top, width }}
        {...pressable(() => onSelect(s.index))}
      >
        <div class="curlbox-head">
          <span>
            <StepBadge n={s.index} active={selected === s.index} /> server picks one
          </span>
        </div>
        <div class="curlbox-steps">
          {s.variants?.map((v) => (
            <span key={v.label} class="chip">
              {v.label}
            </span>
          ))}
        </div>
      </div>
    );
  }
  const variant = isVariantChild ? s.variants?.find((v) => v.nodeId === node.id) : undefined;
  const blockIdx = variant ? (s.variants?.indexOf(variant) ?? 0) : 0;
  const block = s.curl.run[blockIdx];
  return (
    <div
      class={`curlbox${selected === s.index ? ' selected' : ''}`}
      style={{ left: node.x, top, width }}
      {...pressable(() => onSelect(s.index))}
    >
      <div class="curlbox-head">
        <span>
          <StepBadge n={s.index} active={selected === s.index} /> curl {variant ? `· ${variant.label}` : `· ${s.kind}`}
        </span>
        {block ? <CopyButton text={block.code} /> : null}
      </div>
      <code class="curlbox-line">
        {variant ? `if ${variant.callbacks}: ${blockSummary(block?.code)}` : blockSummary(block?.code)}
      </code>
    </div>
  );
}

function NodeCard({
  node,
  mode,
  selected,
  onSelectStep,
  onOpenJourney,
}: {
  node: ViewerNode;
  mode: Mode;
  selected: number | undefined;
  onSelectStep: (n: number) => void;
  onOpenJourney: (name: string) => void;
}) {
  const w = nodeWidth(node);
  const h = nodeHeight(node);
  const isSel = selected !== undefined && node.steps.includes(selected);
  const cls = [
    'node',
    node.onPath ? 'on-path' : 'off-path',
    isSel ? 'selected' : '',
    node.steps.length ? 'has-step' : '',
  ].join(' ');
  return (
    <div
      class={cls}
      style={{ left: node.x, top: node.y, width: w, height: h }}
      {...(node.steps.length
        ? pressable(() => {
            const first = node.steps[0];
            if (first !== undefined) onSelectStep(first);
          })
        : {})}
      title={node.type}
    >
      <div class="node-type">{typeLabel(node.type)}</div>
      <div class="node-name">{node.name}</div>
      {node.steps.length > 0 && (
        <div class="node-steps">
          {node.steps.map((n) => (
            <StepBadge key={n} n={n} active={selected === n} />
          ))}
        </div>
      )}
      {node.children?.map((c, i) => (
        <div key={`${c.name}-${i}`} class="node-child" style={{ top: childTop(i) }}>
          <span class="node-type">{typeLabel(c.type)}</span>
          <span>{c.name}</span>
        </div>
      ))}
      {node.outcomes.map((o, i) => (
        <div key={o} class="node-outcome" style={{ top: rowTop(node, i) }}>
          {o}
          <span class="port" />
        </div>
      ))}
      {node.innerJourney && (
        <button
          type="button"
          class="btn btn-small node-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpenJourney(node.innerJourney as string);
          }}
        >
          Open {mode === 'simple' ? '' : node.innerJourney} ›
        </button>
      )}
    </div>
  );
}

export function Canvas({ canvas, steps, bounds, scale, mode, selected, onSelectStep, onOpenJourney }: Props) {
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  const start = staticCenter(canvas, 'start');
  const entry = byId.get(canvas.entry);
  const endPoint = (id: string) => {
    const c = staticCenter(canvas, id);
    return c ? { x: c.x - END_R, y: c.y } : undefined;
  };
  const edges = canvas.edges.flatMap((e) => {
    const from = byId.get(e.from);
    if (!from) return [];
    const to = byId.get(e.to);
    const b = to ? inPort(to) : endPoint(e.to);
    if (!b) return [];
    return [{ key: `${e.from}-${e.outcome}`, d: edgePath(outPort(from, e.outcome), b), onPath: e.onPath }];
  });
  if (start && entry) {
    edges.unshift({ key: 'start', d: edgePath({ x: start.x + START_R, y: start.y }, inPort(entry)), onPath: true });
  }
  const sorted = [...edges].sort((a, b) => Number(a.onPath) - Number(b.onPath));
  const success = staticCenter(canvas, SUCCESS);
  const failure = staticCenter(canvas, FAILURE);

  return (
    <div class="canvas-size" style={{ width: bounds.width * scale, height: bounds.height * scale }}>
      <div
        class="canvas"
        style={{
          width: bounds.width,
          height: bounds.height,
          transform: `scale(${scale}) translate(${-bounds.minX}px, ${-bounds.minY}px)`,
        }}
      >
        <svg
          class="edges"
          width={bounds.width}
          height={bounds.height}
          style={{ left: bounds.minX, top: bounds.minY }}
          viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
          aria-hidden="true"
        >
          {sorted.map((e) => (
            <path key={e.key} d={e.d} class={e.onPath ? 'edge on-path' : 'edge'} />
          ))}
        </svg>
        {start && (
          <div class="circle start" style={{ left: start.x - START_R, top: start.y - START_R }} title="Start">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <circle cx="12" cy="8" r="4" fill="currentColor" />
              <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="currentColor" />
            </svg>
          </div>
        )}
        {success && (
          <div class="circle end success" style={{ left: success.x - END_R, top: success.y - END_R }}>
            ✓<span class="circle-label">Success</span>
          </div>
        )}
        {failure && (
          <div class="circle end failure" style={{ left: failure.x - END_R, top: failure.y - END_R }}>
            ✕<span class="circle-label">Failure</span>
          </div>
        )}
        {canvas.nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            mode={mode}
            selected={selected}
            onSelectStep={onSelectStep}
            onOpenJourney={onOpenJourney}
          />
        ))}
        {mode === 'engineer' &&
          canvas.nodes.map((n) => (
            <CurlBox key={`box-${n.id}`} node={n} steps={steps} selected={selected} onSelect={onSelectStep} />
          ))}
      </div>
    </div>
  );
}
