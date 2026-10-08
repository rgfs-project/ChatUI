import temml from "temml";
import "temml/dist/Temml-Local.css";
import "./math.css";

/**
 * LaTeX as MathML (Temml, untrusted commands disabled). A formula that fails
 * to parse shows its source instead.
 */
export default function MathView(props: { tex: string; display: boolean }) {
  let markup: string | null;
  try {
    markup = temml.renderToString(props.tex, {
      displayMode: props.display,
      throwOnError: true,
      trust: false,
      annotate: true,
    });
  } catch {
    markup = null;
  }
  if (markup === null) return <code className="math-error">{props.tex}</code>;
  return (
    <span
      className={props.display ? "math math-display" : "math math-inline"}
      // Temml's output is MathML it generated itself from the escaped source.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
