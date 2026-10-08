import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import "./highlight.css";

const lowlight = createLowlight(common);

/** Syntax colors for common languages; anything else stays plain. */
export default function Highlight(props: { code: string; language: string | null }) {
  const language = props.language?.toLowerCase() ?? null;
  if (!language || !lowlight.registered(language)) return <>{props.code}</>;
  const tree = lowlight.highlight(language, props.code);
  // The library's types resolve through `hast`; the result is React nodes.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const node: ReactNode = toJsxRuntime(tree, { Fragment, jsx, jsxs });
  return node;
}
