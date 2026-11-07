import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ViewerData } from '../../src/model/types';
import { Canvas, type Mode } from './Canvas';
import { bounds } from './layout';
import { type Selection, StepPanel } from './StepPanel';

const COVERAGE_TEXT = {
  full: 'Full: the script runs on its own',
  partial: 'Partial: needs an email, session or code',
  manual: 'Manual: a person must help',
};

function readMode(): Mode {
  try {
    return localStorage.getItem('bkj2c-mode') === 'simple' ? 'simple' : 'engineer';
  } catch {
    return 'engineer';
  }
}

export function App({ data }: { data: ViewerData }) {
  const [mode, setMode] = useState<Mode>(readMode);
  // Deep link: #step-3 opens step 3 (and its journey).
  const linked = Number(/^#step-(\d+)$/.exec(location.hash)?.[1] ?? Number.NaN);
  const linkedStep = data.steps.find((s) => s.index === linked);
  const [journey, setJourney] = useState(linkedStep?.journey ?? data.journey);
  const [sel, setSel] = useState<Selection>(linkedStep?.index ?? data.steps[0]?.index ?? 'setup');
  useEffect(() => {
    if (typeof sel === 'number') history.replaceState(null, '', `#step-${sel}`);
  }, [sel]);
  const [scale, setScale] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  const canvas = data.canvases.find((c) => c.journey === journey) ?? data.canvases[0];
  const b = useMemo(() => (canvas ? bounds(canvas, mode === 'engineer') : undefined), [canvas, mode]);

  const fit = () => {
    const el = scroller.current;
    if (!el || !b) return;
    const s = Math.min(1.2, Math.max(0.3, (el.clientWidth - 16) / b.width, (el.clientHeight - 16) / b.height));
    setScale(Number(Math.min(s, (el.clientWidth - 16) / b.width, 1.2).toFixed(2)));
  };

  // Readable zoom on open (wide journeys scroll sideways, like the P1AIC canvas).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !b) return;
    const s = Math.min(1, Math.max(0.75, (el.clientWidth - 16) / b.width));
    setScale(Number(s.toFixed(2)));
  }, [journey, mode]);

  // Keep the selected step's node in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !b || !canvas || typeof sel !== 'number') return;
    const node = canvas.nodes.find((n) => n.steps.includes(sel));
    if (!node) return;
    const x = (node.x - b.minX) * scale;
    const y = (node.y - b.minY) * scale;
    el.scrollTo({
      left: Math.max(0, x - el.clientWidth / 3),
      top: Math.max(0, y - el.clientHeight / 3),
      behavior: 'smooth',
    });
  }, [sel, journey, scale, b, canvas]);

  useEffect(() => {
    try {
      localStorage.setItem('bkj2c-mode', mode);
    } catch {
      // Storage may be blocked (file://, private window): the toggle still works for this visit.
    }
  }, [mode]);

  const selectStep = (n: number) => {
    setSel(n);
    const step = data.steps.find((s) => s.index === n);
    // Show the journey that owns the step, unless the step is visible from the current one.
    if (step && step.journey !== journey) {
      const visibleHere = canvas?.nodes.some((node) => node.steps.includes(n) && node.innerJourney === undefined);
      if (!visibleHere) setJourney(step.journey);
    }
  };

  if (!canvas || !b) return <p class="empty">No journey data.</p>;
  const path = data.canvases.map((c) => c.journey);

  return (
    <div class={`app mode-${mode}`}>
      <header class="top">
        <div class="title">
          <h1>{data.journey}</h1>
          <span class={`cov cov-${data.coverage}`} title={data.coverageNotes.join('\n')}>
            {COVERAGE_TEXT[data.coverage]}
          </span>
        </div>
        <div class="controls">
          <fieldset class="seg" aria-label="View">
            <button type="button" class={mode === 'simple' ? 'on' : ''} onClick={() => setMode('simple')}>
              Simple
            </button>
            <button type="button" class={mode === 'engineer' ? 'on' : ''} onClick={() => setMode('engineer')}>
              Engineer
            </button>
          </fieldset>
          <fieldset class="seg" aria-label="Zoom">
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(0.3, +(s - 0.1).toFixed(2)))}
              aria-label="Zoom out"
            >
              −
            </button>
            <button type="button" onClick={fit}>
              Fit
            </button>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(2, +(s + 0.1).toFixed(2)))}
              aria-label="Zoom in"
            >
              +
            </button>
          </fieldset>
        </div>
      </header>

      {path.length > 1 && (
        <nav class="journeys" aria-label="Journeys">
          {path.map((j) => (
            <button key={j} type="button" class={j === journey ? 'on' : ''} onClick={() => setJourney(j)}>
              {j === data.journey ? j : `↳ ${j}`}
            </button>
          ))}
        </nav>
      )}

      <div class="layout">
        <nav class="steps" aria-label="Steps">
          <ol>
            <li>
              <button type="button" class={sel === 'setup' ? 'on' : ''} onClick={() => setSel('setup')}>
                <span class="num">0</span>
                <span>{mode === 'simple' ? 'Overview' : 'Setup and start'}</span>
              </button>
            </li>
            {data.steps.map((s) => (
              <li key={s.index}>
                <button type="button" class={sel === s.index ? 'on' : ''} onClick={() => selectStep(s.index)}>
                  <span class="num">{s.index}</span>
                  <span>
                    {mode === 'simple' ? s.plainText : s.nodeName}
                    {s.kind !== 'submit' && <em class={`kind kind-${s.kind}`}>{s.kind}</em>}
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button type="button" class={sel === 'finish' ? 'on' : ''} onClick={() => setSel('finish')}>
                <span class="num">✓</span>
                <span>Finish</span>
              </button>
            </li>
          </ol>
        </nav>

        <div class="board" ref={scroller}>
          <Canvas
            canvas={canvas}
            steps={data.steps}
            bounds={b}
            scale={scale}
            mode={mode}
            selected={typeof sel === 'number' ? sel : undefined}
            onSelectStep={selectStep}
            onOpenJourney={(j) => data.canvases.some((c) => c.journey === j) && setJourney(j)}
          />
        </div>

        <aside class="panel">
          <StepPanel data={data} sel={sel} mode={mode} />
        </aside>
      </div>

      {data.warnings.length > 0 && mode === 'engineer' && (
        <details class="warnings">
          <summary>
            {data.warnings.length} warning{data.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
