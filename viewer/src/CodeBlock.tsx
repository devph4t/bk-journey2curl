import { useState } from 'preact/hooks';
import { copyText } from './copy';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      class="btn btn-small"
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setState(ok ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1400);
      }}
    >
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

export function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div class="code">
      <div class="code-bar">
        <span class="code-title">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
