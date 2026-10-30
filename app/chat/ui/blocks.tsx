// Renders parsed UI blocks (Phase 14b). Every string becomes a React text
// node; classes and geometry are ChatUI's own (docs/threat-model-14b.md).
import "./blocks.css";
import { useId, useState, type KeyboardEvent } from "react";
import { parseUiBlock, type UiNode } from "./parse";

function Nodes({ nodes }: { nodes: readonly UiNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Node key={index} node={node} />
      ))}
    </>
  );
}

function Tabs({ tabs }: { tabs: Extract<UiNode, { type: "tabs" }>["tabs"] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 || tabs.length === 0) return;
    event.preventDefault();
    const next = (active + step + tabs.length) % tabs.length;
    setActive(next);
    document.getElementById(`${id}-tab-${String(next)}`)?.focus();
  };
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div className="ui-tabs">
      <div role="tablist" className="ui-tablist">
        {tabs.map((tab, index) => (
          <button
            key={index}
            id={`${id}-tab-${String(index)}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={`${id}-panel`}
            tabIndex={index === active ? 0 : -1}
            className="ui-tab"
            onClick={() => {
              setActive(index);
            }}
            onKeyDown={onKey}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${String(active)}`}
        className="ui-tabpanel"
      >
        {current ? <Nodes nodes={current.children} /> : null}
      </div>
    </div>
  );
}

function Quiz({ node }: { node: Extract<UiNode, { type: "quiz" }> }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const name = useId();
  const correct = choice !== null && node.options[choice]?.correct === true;
  return (
    <fieldset className="ui-quiz">
      <legend className="ui-quiz-question">{node.question}</legend>
      {node.options.map((option, index) => (
        <label
          key={index}
          className={`ui-quiz-option${checked && option.correct ? " is-correct" : ""}${checked && index === choice && !option.correct ? " is-wrong" : ""}`}
        >
          <input
            type="radio"
            name={name}
            checked={choice === index}
            onChange={() => {
              setChoice(index);
              setChecked(false);
            }}
          />
          <span>{option.text}</span>
        </label>
      ))}
      <div className="ui-quiz-foot">
        <button
          type="button"
          className="pill-button"
          disabled={choice === null}
          onClick={() => {
            setChecked(true);
          }}
        >
          Check
        </button>
        {checked ? (
          <p role="status" className="ui-quiz-result">
            {correct ? "Correct." : "Not quite."}
            {node.explain ? ` ${node.explain}` : ""}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function Chart({ node }: { node: Extract<UiNode, { type: "chart" }> }) {
  const values = node.points.map((p) => p.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const width = 320;
  const height = 160;
  const pad = 4;
  const step = node.points.length > 0 ? (width - pad * 2) / node.points.length : 0;
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const zero = y(0);
  return (
    <figure className="ui-chart">
      {node.title ? <figcaption className="ui-chart-title">{node.title}</figcaption> : null}
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        aria-label={node.title || "Chart"}
        className="ui-chart-svg"
      >
        <line x1={pad} x2={width - pad} y1={zero} y2={zero} className="ui-chart-axis" />
        {node.kind === "bar" ? (
          node.points.map((p, i) => {
            const top = Math.min(y(p.value), zero);
            return (
              <rect
                key={i}
                x={pad + i * step + step * 0.15}
                width={Math.max(1, step * 0.7)}
                y={top}
                height={Math.max(1, Math.abs(zero - y(p.value)))}
                className="ui-chart-bar"
              />
            );
          })
        ) : (
          <polyline
            className="ui-chart-line"
            points={node.points
              .map((p, i) => `${String(pad + i * step + step / 2)},${String(y(p.value))}`)
              .join(" ")}
          />
        )}
      </svg>
      <ul className="ui-chart-labels" aria-hidden>
        {node.points.map((p, i) => (
          <li key={i}>{p.label}</li>
        ))}
      </ul>
      <table className="visually-hidden">
        <tbody>
          {node.points.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Node({ node }: { node: UiNode }) {
  switch (node.type) {
    case "callout":
      return <div className={`ui-callout tone-${node.tone}`}>{node.text}</div>;
    case "card":
      return (
        <section className="ui-card">
          {node.title ? <h4 className="ui-card-title">{node.title}</h4> : null}
          <Nodes nodes={node.children} />
        </section>
      );
    case "text":
      return <p className="ui-text">{node.text}</p>;
    case "steps":
      return node.ordered ? (
        <ol className="ui-steps">
          {node.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul className="ui-list">
          {node.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "tabs":
      return <Tabs tabs={node.tabs} />;
    case "stats":
      return (
        <dl className="ui-stats">
          {node.stats.map((s, i) => (
            <div key={i} className="ui-stat">
              <dt>{s.label}</dt>
              <dd className="ui-stat-value">{s.value}</dd>
              {s.note ? <dd className="ui-stat-note">{s.note}</dd> : null}
            </div>
          ))}
        </dl>
      );
    case "chart":
      return <Chart node={node} />;
    case "quiz":
      return <Quiz node={node} />;
    case "progress":
      return (
        <div className="ui-progress">
          <span>{node.label}</span>
          <progress max={100} value={node.value} aria-label={node.label} />
          <span className="ui-progress-value">{Math.round(node.value)}%</span>
        </div>
      );
    case "divider":
      return <hr className="ui-divider" />;
  }
}

/**
 * A ```ui block, or null when it can't be shown (the caller then renders the
 * source as code). While streaming, only finished lines are shown.
 */
export function UiBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const parsed = parseUiBlock(source, !streaming);
  if (!parsed.ok) return null;
  return (
    <div className="ui-block" data-testid="ui-block">
      <p className="ui-block-label">Interactive block</p>
      <Nodes nodes={parsed.nodes} />
    </div>
  );
}

export { parseUiBlock };
