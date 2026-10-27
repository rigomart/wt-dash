import { StyledText, TextAttributes, type RGBA, type TextChunk } from "@opentui/core";
import { plain } from "./format";

export interface Style {
  fg?: RGBA;
  bg?: RGBA;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  reverse?: boolean;
}
export interface Seg extends Style {
  text: string;
}
export type Line = Seg[];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function textWidth(value: string): number {
  return Bun.stringWidth(value);
}

/** Cut to at most `width` columns, never splitting a wide character. */
function cut(value: string, width: number): string {
  if (textWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = textWidth(segment);
    if (used + size > width) break;
    out += segment;
    used += size;
  }
  return out;
}

/** Truncate with an ellipsis when the text is wider than `width`. */
export function clip(value: string, width: number): string {
  if (width <= 0) return "";
  const clean = plain(value);
  if (textWidth(clean) <= width) return clean;
  return cut(clean, width - 1) + "…";
}

/** Keep the start and end of a long value, e.g. `feat/de9…e41a4/B`. */
export function middle(value: string, width: number): string {
  const clean = plain(value);
  if (textWidth(clean) <= width) return clean;
  if (width <= 1) return "…".slice(0, width);
  const tail = Math.floor((width - 1) / 2);
  const chars = [...graphemes.segment(clean)].map((item) => item.segment);
  return cut(clean, width - 1 - tail) + "…" + chars.slice(-tail).join("");
}

export function seg(text: string, style: Style = {}): Seg {
  return { text, ...style };
}

export function cell(
  value: string,
  width: number,
  style: Style = {},
  align: "left" | "right" = "left",
): Seg {
  if (width <= 0) return seg("", style);
  const text = clip(value, width);
  const gap = " ".repeat(Math.max(0, width - textWidth(text)));
  return seg(align === "right" ? gap + text : text + gap, style);
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, item) => sum + textWidth(item.text), 0);
}

/** Hard-cut or pad a line to exactly `width` columns; `fill` styles the padding and every segment. */
export function fitLine(line: Line, width: number, fill?: Style): Line {
  const out: Line = [];
  let used = 0;
  for (const item of line) {
    if (used >= width) break;
    const text = cut(item.text, width - used);
    if (!text) continue;
    out.push(
      fill
        ? { ...fill, ...item, ...(fill.bg && !item.bg ? { bg: fill.bg } : {}), text }
        : { ...item, text },
    );
    used += textWidth(text);
  }
  if (used < width) out.push({ ...fill, text: " ".repeat(width - used) });
  return out;
}

export function sliceLine(line: Line, start: number, end: number): Line {
  const out: Line = [];
  let position = 0;
  for (const item of line) {
    for (const { segment } of graphemes.segment(item.text)) {
      const size = textWidth(segment);
      if (position >= start && position + size <= end) {
        const last = out.at(-1);
        if (
          last &&
          last.fg === item.fg &&
          last.bg === item.bg &&
          last.bold === item.bold &&
          last.dim === item.dim &&
          last.underline === item.underline &&
          last.reverse === item.reverse
        )
          last.text += segment;
        else out.push({ ...item, text: segment });
      }
      position += size;
    }
  }
  return out;
}

/** Place `left` and `right` on one line. The side named by `keep` survives when both do not fit. */
export function spread(
  left: Line,
  right: Line,
  width: number,
  keep: "left" | "right" = "left",
  fill?: Style,
): Line {
  const leftWidth = lineWidth(left);
  const rightWidth = lineWidth(right);
  if (leftWidth + rightWidth + 1 <= width) {
    return fitLine(
      [...left, seg(" ".repeat(width - leftWidth - rightWidth)), ...right],
      width,
      fill,
    );
  }
  if (keep === "right" && rightWidth < width) {
    return fitLine([...fitLine(left, width - rightWidth - 1), seg(" "), ...right], width, fill);
  }
  return fitLine(left, width, fill);
}

/** Wrap text to `width`, preferring to break after `/` or a space so paths stay readable. */
export function wrap(value: string, width: number): string[] {
  const text = plain(value);
  if (width <= 0) return [];
  const lines: string[] = [];
  let rest = text;
  while (textWidth(rest) > width) {
    const head = cut(rest, width);
    const breakAt = Math.max(head.lastIndexOf("/") + 1, head.lastIndexOf(" ") + 1);
    const take = breakAt > width / 3 ? breakAt : head.length;
    lines.push(rest.slice(0, take).trimEnd());
    rest = rest.slice(take).trimStart();
  }
  if (rest || !lines.length) lines.push(rest);
  return lines;
}

export function rule(width: number, label = "", style: Style = {}): Line {
  if (!label) return [seg("─".repeat(Math.max(0, width)), { dim: true })];
  const head = "── ";
  return fitLine(
    [seg(head, { dim: true }), seg(label, style), seg(" " + "─".repeat(width), { dim: true })],
    width,
  );
}

export function toStyledText(lines: Line[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
    for (const item of line) {
      if (!item.text) continue;
      const attributes =
        (item.bold ? TextAttributes.BOLD : 0) |
        (item.dim ? TextAttributes.DIM : 0) |
        (item.underline ? TextAttributes.UNDERLINE : 0) |
        (item.reverse ? TextAttributes.INVERSE : 0);
      chunks.push({
        __isChunk: true,
        text: item.text,
        fg: item.fg,
        bg: item.bg,
        attributes: attributes || undefined,
      });
    }
  });
  return new StyledText(chunks);
}
