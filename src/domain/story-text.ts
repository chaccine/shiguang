import { plain, runText, type TextRun } from "./story.ts";

export const displayText = (text: string) => text.replace(/\r\n?/g, "\n");

// Textarea offsets count UTF-16 code units and normalize CRLF. Keep the original
// line endings in every untouched slice, including when only a mark changes.
function rawOffset(text: string, offset: number): number {
  let i = 0;
  for (let n = 0; n < offset && i < text.length; n++, i++) {
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
  }
  return i;
}
function slice(runs: TextRun[], start: number, end: number): TextRun[] {
  let cursor = 0;
  return runs.flatMap(run => {
    const from = Math.max(0, start - cursor), to = Math.min(run.text.length, end - cursor);
    cursor += run.text.length;
    return from < to ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
}
function join(runs: TextRun[]): TextRun[] {
  const result: TextRun[] = [];
  for (const run of runs) {
    const last = result.at(-1);
    if (last && last.bold === run.bold && last.italic === run.italic) last.text += run.text;
    else if (run.text) result.push({ ...run });
  }
  return result;
}
export function replaceText(runs: TextRun[], value: string, caret = value.length): TextRun[] {
  const raw = runText(runs), before = displayText(raw);
  if (before === value) return runs;
  let left = 0, oldEnd = before.length, newEnd = value.length;
  while (left < caret && left < oldEnd && left < newEnd && before[left] === value[left]) left++;
  while (oldEnd > left && newEnd > left && before[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  const from = rawOffset(raw, left), to = rawOffset(raw, oldEnd);
  const leading = slice(runs, 0, from);
  const style = (from !== to ? slice(runs, from, to)[0] : leading.at(-1)) ?? runs[0] ?? plain("");
  return join([...leading, { ...style, text: value.slice(left, newEnd) }, ...slice(runs, to, raw.length)]);
}
export function toggleMark(runs: TextRun[], start: number, end: number, mark: "bold" | "italic"): TextRun[] {
  if (end <= start) return runs;
  const raw = runText(runs), from = rawOffset(raw, start), to = rawOffset(raw, end);
  const selected = slice(runs, from, to), on = !selected.every(run => run[mark]);
  return join([...slice(runs, 0, from), ...selected.map(run => ({ ...run, [mark]: on })), ...slice(runs, to, raw.length)]);
}
