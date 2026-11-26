import type { StoryEditor } from "../domain/story-editor.ts";
import { runText, type StoryBlock, type TextKind } from "../domain/story.ts";
import { displayText } from "../domain/story-text.ts";
import { renderRuns } from "./reading.ts";

type TextField = HTMLTextAreaElement | HTMLInputElement;
const composing = new WeakSet<TextField>();
export function bindTyping(field: TextField, apply: () => void) {
  const finish = () => { composing.delete(field); apply(); };
  field.addEventListener("compositionstart", () => composing.add(field));
  field.addEventListener("compositionend", finish);
  field.addEventListener("blur", () => { if (composing.has(field)) finish(); });
  field.addEventListener("input", event => {
    if (!composing.has(field) && !(event as InputEvent).isComposing) apply();
  });
}
export function showValue(field: TextField, raw: string) {
  const value = displayText(raw);
  if (!composing.has(field) && field.value !== value) field.value = value;
}
const labels = { paragraph: "段落", smallHeading: "小标题", quote: "引用", divider: "分隔线", photo: "照片" };
function button(label: string, id: string, action: () => void) {
  const node = document.createElement("button"); node.type = "button"; node.className = "button ghost";
  node.textContent = label; node.dataset.testid = id; node.addEventListener("click", action); return node;
}
function choice(value: string, label: string) {
  const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
}

interface BlockActions {
  photo(index: number): HTMLElement;
  pick(index: number): void;
  remove(index: number): void;
  focusBlock(index: number): void;
}
type TextUpdate = (block: StoryBlock) => void;

/** Preserve live textareas and native selections across typing and write acknowledgements. */
export class StoryBlocksUi {
  private holder: HTMLElement;
  private structure = "";
  private updates = new Map<number, TextUpdate>();
  constructor(holder: HTMLElement) { this.holder = holder; }
  reset() { this.structure = ""; this.updates.clear(); this.holder.replaceChildren(); }
  render(editor: StoryEditor, actions: BlockActions) {
    const { blocks } = editor.story;
    const structure = JSON.stringify(blocks.map(b => b.kind === "photo" ? ["photo", ...editor.photoRenderKey(b.photoUse)] : b.kind));
    if (structure !== this.structure) {
      this.structure = structure;
      this.updates.clear();
      const nodes: HTMLElement[] = [];
      if (blocks.some(block => "runs" in block)) {
        const hint = document.createElement("p"); hint.className = "editor-hint";
        hint.textContent = "选中文字后，可加粗或设为斜体。"; nodes.push(hint);
      }
      for (let i = 0; i <= blocks.length; i++) {
        const insert = document.createElement("select");
        insert.className = "story-insert"; insert.dataset.testid = "story-insert";
        insert.setAttribute("aria-label", i === 0 ? "在故事开头插入" : `在第 ${i} 块后插入`);
        insert.append(choice("", i === 0 ? "＋ 在开头插入" : "＋ 在此处插入"), ...Object.entries(labels).map(([v, name]) => choice(v, name)));
        insert.addEventListener("change", () => {
          const kind = insert.value; insert.value = "";
          if (!editor.editable || editor.mode !== "story") return;
          if (kind === "photo") actions.pick(i);
          else if (kind === "paragraph" || kind === "smallHeading" || kind === "quote" || kind === "divider") {
            editor.insert(i, kind); actions.focusBlock(i);
          }
        });
        nodes.push(insert);
        if (i < blocks.length) nodes.push(this.block(editor, actions, i));
      }
      this.holder.replaceChildren(...nodes);
    }
    this.updates.forEach((update, index) => update(blocks[index]));
  }
  private block(editor: StoryEditor, actions: BlockActions, index: number) {
    const block = editor.story.blocks[index], name = labels[block.kind];
    const card = document.createElement("section");
    card.dataset.blockIndex = String(index);
    card.className = "story-block"; card.dataset.testid = "story-block";
    card.setAttribute("aria-label", `第 ${index + 1} 块，${name}`);
    if (block.kind === "photo") { card.append(actions.photo(index)); return card; }
    const controls = document.createElement("div"); controls.className = "story-tools";
    if ("runs" in block) {
      const kind = document.createElement("select"); kind.setAttribute("aria-label", `第 ${index + 1} 块的文本类型`);
      kind.dataset.testid = "story-kind";
      kind.append(...(["paragraph", "smallHeading", "quote"] as TextKind[]).map(v => choice(v, labels[v])));
      kind.value = block.kind;
      kind.addEventListener("change", () => { editor.kind(index, kind.value as TextKind); actions.focusBlock(index); });
      const field = document.createElement("textarea"); field.className = "story-text"; field.dataset.testid = "story-text";
      field.setAttribute("aria-label", `第 ${index + 1} 块，${name}文字`); field.placeholder = `写下${name}…`;
      bindTyping(field, () => editor.text(index, field.value, field.selectionEnd));
      const formatted = document.createElement("div"); formatted.className = "story-formatted";
      formatted.setAttribute("aria-label", "强调效果");
      const marks = document.createElement("div"); marks.className = "story-tools";
      for (const [mark, label] of [["bold", "加粗"], ["italic", "斜体"]] as const) {
        const toggle = button(label, `story-${mark}`, () => {
          const start = field.selectionStart, end = field.selectionEnd;
          if (start === end) return;
          editor.mark(index, start, end, mark);
          field.focus({ preventScroll: true }); field.setSelectionRange(start, end);
        });
        toggle.setAttribute("aria-label", `切换选中文字的${label}`);
        const selection = () => { toggle.disabled = field.selectionStart === field.selectionEnd; };
        for (const event of ["select", "selectionchange", "keyup", "pointerup", "input"]) field.addEventListener(event, selection);
        selection(); marks.append(toggle);
      }
      let previous: typeof block.runs | undefined;
      this.updates.set(index, current => {
        if (!("runs" in current) || previous === current.runs) return;
        previous = current.runs;
        showValue(field, runText(current.runs));
        formatted.hidden = current.runs.every(run => !run.bold && !run.italic);
        if (!formatted.hidden) renderRuns(formatted, current.runs);
      });
      card.append(kind, field, marks, formatted);
    } else {
      const line = document.createElement("hr"); card.append(line);
    }
    for (const [delta, label] of [[-1, "上移"], [1, "下移"]] as const) {
      const move = button(label, delta < 0 ? "story-up" : "story-down", () => { editor.move(index, delta); actions.focusBlock(index + delta); });
      move.disabled = index + delta < 0 || index + delta >= editor.story.blocks.length;
      move.setAttribute("aria-label", `第 ${index + 1} 块${label}`); controls.append(move);
    }
    controls.append(button("移除", "story-remove", () => actions.remove(index)));
    card.append(controls); return card;
  }
}
