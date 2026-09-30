import { gfmFromMarkdown } from "mdast-util-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { mathFromMarkdownChat, mathSyntax } from "./remark-math-parse";
import { count } from "./render-counters";

/**
 * Incremental block splitting for a streaming reply (Phase 14, INV-46).
 *
 * A streaming reply only ever grows. Its top-level Markdown blocks (a
 * paragraph, a list, a table, a fence…) are found by parsing. New text can
 * change the last block, and can merge it into the one before (a paragraph
 * `2` becoming `2. item` continues the previous ordered list), but nothing
 * reaches further back: every block before the last two is final. So each
 * update parses only the text from the start of the second-to-last block, and
 * every block is rendered by its own component keyed by its start offset:
 * finished blocks never re-parse or re-render, and their DOM (with any
 * selection in it) stays.
 *
 * Only reference-style link definitions and footnotes can point across blocks;
 * they resolve once the reply is stored and rendered as one document.
 */

const syntax = [gfm(), mathSyntax()];
const conversion = [gfmFromMarkdown(), mathFromMarkdownChat()];

/** Offsets where top-level blocks start in `text` (the first is 0). */
function blockStarts(text: string, from: number): number[] {
  count("blockParseChars", text.length - from);
  const tree = fromMarkdown(text.slice(from), { extensions: syntax, mdastExtensions: conversion });
  const starts = [from];
  for (const child of tree.children.slice(1)) {
    const offset = child.position?.start.offset;
    if (offset === undefined) continue;
    // Split at the start of the block's line, keeping any indentation.
    const lineStart = text.lastIndexOf("\n", from + offset - 1) + 1;
    if (lineStart > (starts.at(-1) ?? 0)) starts.push(lineStart);
  }
  return starts;
}

export interface Block {
  /** Offset of the block in the reply: a stable React key. */
  start: number;
  source: string;
}

/**
 * Splits a growing text into blocks. Memoizes the block starts of the
 * previous text, so appending costs a parse of the last two blocks; any text
 * that doesn't extend the previous one starts over (same result, more work).
 */
export class BlockSplitter {
  private text = "";
  private starts: number[] = [0];

  split(text: string): Block[] {
    if (!text.startsWith(this.text)) this.starts = [0];
    const kept = this.starts.slice(0, -2);
    this.starts = [...kept, ...blockStarts(text, this.starts.at(-2) ?? 0)];
    this.text = text;
    return this.starts.map((start, index) => ({
      start,
      source: text.slice(start, this.starts[index + 1] ?? text.length),
    }));
  }
}
