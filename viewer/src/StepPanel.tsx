import { useState } from 'preact/hooks';
import type { ViewerData, ViewerStep } from '../../src/model/types';
import type { Mode } from './Canvas';
import { CodeBlock } from './CodeBlock';

export type Selection = number | 'setup' | 'finish';

const KIND_TEXT: Record<string, string> = {
  submit: 'submit',
  optional: 'optional',
  variant: 'server picks one',
  suspend: 'waits for email',
  manual: 'needs a person',
  poll: 'polling',
  redirect: 'redirect',
};

function Setup({ data, mode }: { data: ViewerData; mode: Mode }) {
  return (
    <div>
      <h2 class="panel-title">Before you start</h2>
      <p class="plain">
        {mode === 'simple'
          ? 'The steps on the left are what a person does in this journey, in order.'
          : 'Run the blocks one by one in the same bash terminal (Git Bash works; needs curl and jq). Each block posts the last response back with the inputs filled in.'}
      </p>
      {mode === 'engineer' && (
        <>
          <CodeBlock title="Setup: edit the values first" code={data.curl.setup.code} />
          <CodeBlock title="Start the journey" code={data.curl.start.code} />
          {data.inputs.length > 0 && (
            <table class="inputs">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                {data.inputs.map((i) => (
                  <tr key={i.variable}>
                    <td>
                      <code>{i.variable}</code>
                      {i.secret ? ' (secret)' : ''}
                    </td>
                    <td>{i.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function Finish({ data, mode }: { data: ViewerData; mode: Mode }) {
  return (
    <div>
      <h2 class="panel-title">{data.target === 'success' ? 'Finish' : 'Expected failure'}</h2>
      <p class="plain">
        {data.target === 'success'
          ? 'The journey ends at Success and the server returns a tokenId (the session).'
          : 'The journey ends at Failure and the server answers HTTP 401.'}
      </p>
      {mode === 'engineer' && (
        <>
          <CodeBlock title="Show the result" code={data.curl.finish.code} />
          {data.target === 'success' && <CodeBlock title="Check the session" code={data.curl.session.code} />}
        </>
      )}
    </div>
  );
}

function StepView({ step, mode }: { step: ViewerStep; mode: Mode }) {
  const [showBody, setShowBody] = useState(false);
  const where = step.journey === step.nodeName ? step.nodeName : `${step.journey} / ${step.nodeName}`;
  return (
    <div>
      <div class="panel-kicker">
        Step {step.index} · <span class={`kind kind-${step.kind}`}>{KIND_TEXT[step.kind] ?? step.kind}</span>
      </div>
      <h2 class="panel-title">{where}</h2>
      <p class="plain">{step.plainText}</p>
      {step.condition && <p class="note">Appears only when {step.condition}.</p>}
      {step.variants && (
        <ul class="variants">
          {step.variants.map((v) => (
            <li key={v.label}>
              <b>{v.label}</b>: {v.plainText}
              {mode === 'engineer' && (
                <>
                  {' '}
                  <code>{v.callbacks}</code>
                  {v.solver ? <span class="muted"> · answered by {v.solver}</span> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode === 'engineer' && (
        <>
          {step.kind !== 'variant' && step.callbacks && (
            <p class="muted">
              Server sends: <code>{step.callbacks}</code>
            </p>
          )}
          {step.kind === 'variant' && (
            <CodeBlock
              title="Which one did the server send?"
              code={`jq -r '[.callbacks[]?.type] | join(",")' <<<"$RESP"`}
            />
          )}
          {step.curl.run.map((b) => (
            <CodeBlock key={b.label} title={b.label} code={b.code} />
          ))}
          {step.curl.body && (
            <div class="body-toggle">
              <button type="button" class="btn btn-small" onClick={() => setShowBody(!showBody)}>
                {showBody ? 'Hide' : 'Show'} the request body (Postman style)
              </button>
              {showBody && (
                <CodeBlock
                  title="Example body (values in <...> come from variables or the response)"
                  code={step.curl.body}
                />
              )}
            </div>
          )}
          <p class="expect">
            <span class="muted">Expected next:</span> <code>{step.curl.expect}</code>
          </p>
          {step.notes?.length ? (
            <ul class="notes">
              {step.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export function StepPanel({ data, sel, mode }: { data: ViewerData; sel: Selection; mode: Mode }) {
  if (sel === 'setup') return <Setup data={data} mode={mode} />;
  if (sel === 'finish') return <Finish data={data} mode={mode} />;
  const step = data.steps.find((s) => s.index === sel);
  return step ? <StepView step={step} mode={mode} /> : null;
}
