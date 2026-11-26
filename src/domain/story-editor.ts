import type { AttachPhotoBytesInput, ShiguangApi } from "../platform/api.ts";
import { sha256, sniffMediaType } from "../platform/bytes.ts";
import { describeError, type ErrorDescription } from "./errors.ts";
import { DraftSession } from "./draft-session.ts";
import { fromLegacy, isSimple, plain, runText, sessionOnlyMessage, toLegacy } from "./story.ts";
import type { Story, StoryBlock, TextKind } from "./story.ts";
import { replaceText, toggleMark } from "./story-text.ts";
import type { PhotoUse, RecordRow, Snapshot } from "./types.ts";

export type Mode = "quick" | "story";
export type StoryMeta = Omit<Snapshot, "body" | "photos" | "coverPhotoUseId">;
type PhotoInput = Omit<AttachPhotoBytesInput, "recordId" | "bytes"> & { bytes: Uint8Array };
type Document = { meta: StoryMeta; story: Story };
type Options = {
  api: ShiguangApi; row: RecordRow | null; defaultDate: string; mode?: Mode;
  schedule(fn: () => void, delay: number): number; cancel(id: number): void;
};
function metaOf({ title, eventDate, eventTime, location, mood }: Snapshot): StoryMeta {
  return { title, eventDate, eventTime, location, mood };
}
type PhotoState = Pick<Snapshot, "photos" | "coverPhotoUseId">;
function samePhotos(a: PhotoState, b: PhotoState) {
  return a.coverPhotoUseId === b.coverPhotoUseId && a.photos.length === b.photos.length &&
    a.photos.every((p, i) => {
      const q = b.photos[i];
      return p.photoUseId === q.photoUseId && p.assetId === q.assetId && p.caption === q.caption &&
        p.sha256 === q.sha256 && p.bytes === q.bytes && p.mediaType === q.mediaType;
    });
}
function sessionOnly(): Error { return Object.assign(new Error(sessionOnlyMessage), { code: "STORY_SESSION_ONLY" }); }

/** The editable document and its undo stack live for one edit session. Only a simple
 * projection reaches DraftSession. Store acknowledgements never reopen the editor. */
export class StoryEditor {
  private readonly draft: DraftSession<number>;
  private doc: Document;
  private past: Document[] = [];
  private future: Document[] = [];
  private media = new Map<string, PhotoInput>();
  private photoSequence = 0;
  // An acknowledged attach changes its occurrence ID once. Keep the editing control
  // mounted so a Chinese composition or a caption selection stays with the photo.
  private photoKeys = new Map<string, string>();
  private uncertain = false;
  private photoConflict = false;
  private readonly undoSession = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("");
  private options: Options;
  private timer?: number;
  private running?: Promise<void>;
  private dirty = false;
  private syncError?: ErrorDescription;
  private listeners = new Set<() => void>();
  mode: Mode;
  preview = false;
  publishing = false;

  constructor(options: Options) {
    this.options = options;
    // This controller debounces the whole document. The underlying serialized queue is
    // drained explicitly, after checking the current structure at each write boundary.
    this.draft = new DraftSession({ api: options.api, schedule: () => 0, cancel: () => {} });
    this.draft.open(options.row);
    const source = this.draft.state.snapshot, meta = metaOf(source);
    if (!options.row) meta.eventDate = options.defaultDate;
    this.doc = { story: fromLegacy(source), meta };
    this.mode = options.row?.draft ? options.mode ?? "quick" : "quick";
    this.draft.onChange(state => {
      if (state.status === "savedUncertain") this.uncertain = true;
      this.notify();
    });
  }
  get story() { return this.doc.story; }
  get meta() { return this.doc.meta; }
  get simple() { return isSimple(this.story); }
  get protected() { return this.mode === "quick" && !this.simple; }
  get editable() { return !this.protected && !this.preview && !this.publishing; }
  get pending() { return this.dirty; }
  get needsReload() { return this.photoConflict; }
  get canUndo() { return this.editable && this.past.length > 0; }
  get canRedo() { return this.editable && this.future.length > 0; }
  get saveState() {
    const state = this.draft.state;
    if (this.syncError && state.status !== "conflict") return { ...state, status: "error" as const, lastError: this.syncError };
    if (this.uncertain && state.status === "saved") state.status = "savedUncertain";
    return state;
  }
  get recordId() { return this.draft.state.recordId; }
  photoKey(id: string) { return this.photoKeys.get(id) ?? id; }
  pendingPhoto(id: string) { return this.media.get(id); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { for (const fn of this.listeners) fn(); }
  private cancelTimer() {
    if (this.timer !== undefined) this.options.cancel(this.timer);
    this.timer = undefined;
  }
  private changed() {
    this.cancelTimer();
    this.dirty = true;
    if (this.simple && !this.needsReload && !this.running && this.draft.state.status !== "conflict") {
      this.timer = this.options.schedule(() => { void this.flush().catch(() => {}); }, 800);
    }
    this.notify();
  }
  private change(doc: Document) {
    if (!this.editable) return;
    this.past.push(this.doc);
    this.future = [];
    this.doc = doc;
    this.changed();
  }
  private blocks(blocks: StoryBlock[], coverPhotoUseId = this.story.coverPhotoUseId) {
    this.change({ meta: this.meta, story: { blocks, coverPhotoUseId } });
  }
  switchMode(mode: Mode) {
    if (!this.preview && !this.publishing) { this.mode = mode; this.notify(); }
  }
  resume() { this.preview = false; if (!this.simple) this.mode = "story"; this.notify(); }
  setPreview(on: boolean) { if (!this.publishing && (!on || this.editable)) { this.preview = on; this.notify(); } }
  editMeta(patch: Partial<StoryMeta>) {
    if (Object.entries(patch).some(([key, value]) => this.meta[key as keyof StoryMeta] !== value))
      this.change({ meta: { ...this.meta, ...patch }, story: this.story });
  }
  quickBody(value: string, caret?: number) {
    if (!this.simple || !this.editable) return;
    const [first, ...rest] = this.story.blocks;
    if (first?.kind === "paragraph") {
      const runs = replaceText(first.runs, value, caret);
      if (runs !== first.runs) this.blocks(value ? [{ kind: "paragraph", runs }, ...rest] : rest);
    } else if (value) this.blocks([{ kind: "paragraph", runs: [plain(value)] }, ...this.story.blocks]);
  }
  insert(index: number, kind: TextKind | "divider") {
    if (this.mode !== "story") return;
    const block: StoryBlock = kind === "divider" ? { kind } : { kind, runs: [] };
    const blocks = this.story.blocks.slice(); blocks.splice(index, 0, block); this.blocks(blocks);
  }
  private replace(index: number, block: StoryBlock) {
    this.blocks(this.story.blocks.map((old, i) => i === index ? block : old));
  }
  text(index: number, value: string, caret?: number) {
    const block = this.story.blocks[index];
    if (block && "runs" in block && this.mode === "story") {
      const runs = replaceText(block.runs, value, caret);
      if (runs !== block.runs) this.replace(index, { ...block, runs });
    }
  }
  kind(index: number, kind: TextKind) {
    const block = this.story.blocks[index];
    if (block && "runs" in block && block.kind !== kind && this.mode === "story") this.replace(index, { kind, runs: block.runs });
  }
  mark(index: number, start: number, end: number, mark: "bold" | "italic") {
    const block = this.story.blocks[index];
    if (block && "runs" in block && end > start && this.mode === "story")
      this.replace(index, { ...block, runs: toggleMark(block.runs, start, end, mark) });
  }
  move(index: number, delta: -1 | 1) {
    const blocks = this.story.blocks.slice(), target = index + delta;
    if (!blocks[index] || !blocks[target]) return;
    if (this.mode === "quick" && (blocks[index].kind !== "photo" || blocks[target].kind !== "photo")) return;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    this.blocks(blocks);
  }
  remove(index: number) {
    const block = this.story.blocks[index];
    if (!block) return;
    const blocks = this.story.blocks.filter((_, i) => i !== index);
    const cover = block.kind === "photo" && block.photoUse.photoUseId === this.story.coverPhotoUseId
      ? blocks.find(b => b.kind === "photo")?.photoUse.photoUseId ?? null : this.story.coverPhotoUseId;
    this.blocks(blocks, cover);
  }
  caption(id: string, value: string, caret?: number) {
    const index = this.photoIndex(id), block = this.story.blocks[index];
    if (block?.kind !== "photo") return;
    const caption = runText(replaceText([plain(block.photoUse.caption)], value, caret));
    if (caption !== block.photoUse.caption) this.replace(index, { kind: "photo", photoUse: { ...block.photoUse, caption } });
  }
  cover(id: string) {
    const block = this.story.blocks[this.photoIndex(id)];
    if (block?.kind === "photo" && this.story.coverPhotoUseId !== block.photoUse.photoUseId)
      this.blocks(this.story.blocks, block.photoUse.photoUseId);
  }
  photoIndex(id: string) {
    const key = this.photoKey(id);
    return this.story.blocks.findIndex(block => block.kind === "photo" && this.photoKey(block.photoUse.photoUseId) === key);
  }
  insertPhoto(index: number, input: PhotoInput) {
    if (!this.editable) return;
    if (!input.bytes.length || input.bytes.length > 25 * 1024 * 1024 || !input.fileName ||
        [".", ".."].includes(input.fileName) || /[/\\:\0]/.test(input.fileName)) throw new Error("请选择 25 MB 以内的非空图片文件");
    const hash = sha256(input.bytes), id = `pending-${this.undoSession}-${++this.photoSequence}`;
    const photoUse: PhotoUse = { photoUseId: id, assetId: `ast-${hash.slice(0, 16)}`, caption: input.caption,
      sha256: hash, bytes: input.bytes.length, mediaType: input.mediaType || sniffMediaType(input.fileName, input.bytes) };
    this.media.set(id, input);
    const blocks = this.story.blocks.slice();
    blocks.splice(this.mode === "quick" ? blocks.length : index, 0, { kind: "photo", photoUse });
    this.blocks(blocks, this.story.coverPhotoUseId ?? id);
  }
  undo() {
    if (!this.canUndo) return;
    this.future.push(this.doc); this.doc = this.past.pop()!;
    if (!this.simple) this.mode = "story";
    this.changed();
  }
  redo() {
    if (!this.canRedo) return;
    this.past.push(this.doc); this.doc = this.future.pop()!;
    if (!this.simple) this.mode = "story";
    this.changed();
  }
  private bindOccurrence(localId: string, photo: PhotoUse) {
    const bind = (doc: Document): Document => {
      if (!doc.story.blocks.some(b => b.kind === "photo" && b.photoUse.photoUseId === localId)) return doc;
      return { meta: doc.meta, story: {
        coverPhotoUseId: doc.story.coverPhotoUseId === localId ? photo.photoUseId : doc.story.coverPhotoUseId,
        blocks: doc.story.blocks.map(b => b.kind === "photo" && b.photoUse.photoUseId === localId
          ? { kind: "photo", photoUse: { ...photo, caption: b.photoUse.caption } } : b),
      } };
    };
    this.doc = bind(this.doc); this.past = this.past.map(bind); this.future = this.future.map(bind);
    this.photoKeys.set(photo.photoUseId, localId);
    this.media.delete(localId);
    this.notify();
  }
  private checkPhotos(expected: PhotoState, actual: PhotoState) {
    if (samePhotos(expected, actual)) return;
    this.photoConflict = true;
    this.notify();
    throw new Error("草稿照片已在其他编辑中更改，请打开最新草稿核对。");
  }
  /** Each acknowledged operation updates DraftSession. After an await, re-read the
   * working document before issuing anything else, including if it just became complex. */
  private async sync() {
    await this.draft.flush();
    if (this.recordId && this.simple) {
      const row = await this.options.api.getRecord(this.recordId);
      const current = row.draft ?? row.formal;
      if (current) this.checkPhotos(this.draft.state.snapshot, current);
    }
    while (this.dirty && this.simple) {
      const target = { ...this.meta, ...toLegacy(this.story) }, source = this.draft.state.snapshot;
      const { photos, coverPhotoUseId, ...fields } = target;
      if (Object.entries(fields).some(([key, value]) => value !== source[key as keyof typeof fields])) {
        // Do not materialize the pristine new page if undo beats its first autosave.
        const pristine = !this.recordId && fields.eventDate === this.options.defaultDate &&
          !fields.body && !fields.title && !fields.location && !fields.eventTime && !fields.mood && !photos.length;
        if (!pristine) {
          this.draft.edit(fields); await this.draft.flush();
          this.checkPhotos(source, this.draft.state.snapshot); continue;
        }
      }
      const missing = photos.find(p => !source.photos.some(current => current.photoUseId === p.photoUseId));
      if (missing) {
        const input = this.media.get(missing.photoUseId);
        if (input) {
          const result = await this.draft.attachPhoto({ ...input, caption: missing.caption });
          const added = result.row.draft!.photos.at(-1)!;
          this.bindOccurrence(missing.photoUseId, added);
          this.checkPhotos({ photos: [...source.photos, added], coverPhotoUseId: source.coverPhotoUseId ?? added.photoUseId }, result.row.draft!);
        } else {
          const result = await this.draft.removePhoto(missing.photoUseId, this.undoSession, true);
          // The receipt restores the caption at unlink time. A subsequent caption edit
          // can still be waiting in the working document.
          const restored = result.row.draft!.photos.at(-1)!;
          this.checkPhotos({ photos: [...source.photos, restored], coverPhotoUseId: source.coverPhotoUseId ?? restored.photoUseId }, result.row.draft!);
        }
        continue;
      }
      const extra = source.photos.find(p => !photos.some(wanted => wanted.photoUseId === p.photoUseId));
      if (extra) {
        const remaining = source.photos.filter(p => p.photoUseId !== extra.photoUseId);
        const result = await this.draft.removePhoto(extra.photoUseId, this.undoSession);
        this.checkPhotos({ photos: remaining, coverPhotoUseId: source.coverPhotoUseId === extra.photoUseId
          ? remaining[0]?.photoUseId ?? null : source.coverPhotoUseId }, result.row.draft!);
        continue;
      }
      const caption = photos.find(p => source.photos.find(current => current.photoUseId === p.photoUseId)?.caption !== p.caption);
      if (caption) {
        await this.draft.updatePhoto("caption", caption.photoUseId, caption.caption);
        this.checkPhotos({ ...source, photos: source.photos.map(p => p.photoUseId === caption.photoUseId ? caption : p) }, this.draft.state.snapshot);
        continue;
      }
      if (coverPhotoUseId && coverPhotoUseId !== source.coverPhotoUseId) {
        await this.draft.updatePhoto("cover", coverPhotoUseId);
        this.checkPhotos({ ...source, coverPhotoUseId }, this.draft.state.snapshot); continue;
      }
      if (photos.some((p, i) => p.photoUseId !== source.photos[i].photoUseId)) {
        await this.draft.updatePhoto("order", "", photos.map(p => p.photoUseId));
        this.checkPhotos(target, this.draft.state.snapshot); continue;
      }
      this.dirty = false;
    }
    this.notify();
  }
  flush(): Promise<void> {
    this.cancelTimer();
    if (this.needsReload) return Promise.reject(new Error("请先打开最新草稿核对照片。"));
    if (!this.simple) return Promise.reject(sessionOnly());
    if (!this.running && this.dirty) {
      this.syncError = undefined;
      this.running = this.sync().catch(error => {
        this.syncError = describeError(error); this.notify(); throw error;
      }).finally(() => { this.running = undefined; });
    }
    if (!this.running && this.draft.state.status === "conflict") return this.draft.flush();
    return this.running ?? Promise.resolve();
  }
  /** Navigation/background may park a complex session, never serialize it. */
  async settle() {
    if (this.simple && !this.needsReload) await this.flush(); else await this.running;
  }
  async ensureTagRecord() {
    if (!this.editable) throw sessionOnly();
    if (this.recordId && !this.simple) return this.recordId;
    if (!this.simple) throw sessionOnly();
    await this.flush();
    if (!this.editable || !this.simple) throw sessionOnly();
    if (!this.recordId) await this.draft.ensureDraft();
    return this.recordId!;
  }
  async commit() {
    if (!this.editable || !this.simple) throw sessionOnly();
    this.publishing = true; this.notify();
    try {
      await this.flush();
      return await this.draft.commit();
    } finally { this.publishing = false; this.notify(); }
  }
}
