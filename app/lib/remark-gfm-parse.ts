import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
// Declares the `micromarkExtensions`/`fromMarkdownExtensions` processor data.
import type {} from "remark-parse";
import type { Processor } from "unified";

/**
 * GitHub Flavored Markdown for rendering only: the same micromark syntax and
 * mdast conversion `remark-gfm` registers, without its Markdown serializer
 * extensions (`gfmToMarkdown`), which pull `mdast-util-to-markdown` into the
 * critical bundle although ChatUI never stringifies Markdown.
 */
export function remarkGfmParse(this: Processor): undefined {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
  return undefined;
}
