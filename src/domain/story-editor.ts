import type { AttachPhotoBytesInput, PhotoFile, ShiguangApi } from "../platform/api.ts";
import { sha256, sniffMediaType } from "../platform/bytes.ts";
import { describeError, type ErrorDescription } from "./errors.ts";
import { DraftSession } from "./draft-session.ts";
import { isSimple, plain, runText, sameStory, storyOf, storyPhotos } from "./story.ts";
import type { Story, StoryBlock, TextKind } from "./story.ts";
import { replaceText, toggleMark } from "./story-text.ts";
import type { PhotoUse, RecordRow, Snapshot } from "./types.ts";

export type Mode = "quick" | "story";
export type StoryMeta = Omit<Snapshot, "story" | "body" | "photos" | "coverPhotoUseId">;
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
function readOnly(): Error { return Object.assign(new Error("请先返回故事编辑"), { code: "EDITOR_READ_ONLY" }); }

/** Undo history is local. The serialized save queue persists the full working story. */
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
  private savedMode?: Mode;
  private syncError?: ErrorDescription;
  private listeners = new Set<() => void>();
  mode: Mode;
  preview = false;
  publishing = false;
  changingPhoto = false;

  constructor(options: Options) {
    this.options = options;
    // This controller debounces the whole document. The underlying serialized queue is
    // drained explicitly, after checking the current structure at each write boundary.
    this.draft = new DraftSession({ api: options.api, schedule: () => 0, cancel: () => {} });
    this.draft.open(options.row);
    const source = this.draft.state.snapshot, meta = metaOf(source);
    if (!options.row) meta.eventDate = options.defaultDate;
    this.doc = { story: storyOf(source), meta };
    this.savedMode = options.row?.draftMode;
    this.mode = !this.simple ? "story" : options.row?.draft ? this.savedMode ?? options.mode ?? "quick" : "quick";
    this.draft.onChange(state => {
      if (state.status === "savedUncertain") this.uncertain = true;
      this.notify();
    });
  }
  get story() { return this.doc.story; }
  get meta() { return this.doc.meta; }
  get simple() { return isSimple(this.story); }
  get protected() { return this.mode === "quick" && !this.simple; }
  get editable() { return !this.protected && !this.preview && !this.publishing && !this.changingPhoto; }
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
  photoRenderKey(photo: PhotoUse) { return [this.photoKey(photo.photoUseId), photo.assetId, photo.sha256]; }
  async releaseHistory() {
    if (this.recordId) await this.options.api.releasePhotoHistory(this.recordId, this.undoSession);
  }
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
    if (!this.needsReload && !this.running && this.draft.state.status !== "conflict") {
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
    if (this.preview || this.publishing || this.changingPhoto || this.mode === mode) return;
    this.mode = mode;
    if (this.simple && this.recordId && this.draft.state.status !== "idle") this.changed();
    else this.notify();
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
  private movedBlocks(index: number, target: number) {
    const blocks = this.story.blocks.slice();
    if (!blocks[index] || !blocks[target] || index === target) return;
    if (this.mode === "quick" && (blocks[index].kind !== "photo" || blocks[target].kind !== "photo")) return;
    const [block] = blocks.splice(index, 1);
    blocks.splice(target, 0, block);
    return blocks;
  }
  move(index: number, delta: -1 | 1) {
    const blocks = this.movedBlocks(index, index + delta);
    if (blocks) this.blocks(blocks);
  }
  // A picker result or drop is one history step, published locally only after its
  // checked store operation succeeds. Pending inserts must first obtain their real IDs.
  private async photoOperation(id: string, operation: (index: number, photo: PhotoUse) => Promise<Story | undefined>) {
    if (!this.editable || this.needsReload) throw readOnly();
    this.changingPhoto = true;
    this.notify();
    try {
      await this.flush();
      const index = this.photoIndex(id), block = this.story.blocks[index];
      if (block?.kind !== "photo") throw new Error("照片使用位已改变，请重新选择");
      const story = await operation(index, block.photoUse);
      if (story && !sameStory(story, this.story)) {
        this.past.push(this.doc); this.future = [];
        this.doc = { meta: this.meta, story };
      }
    } catch (error) {
      if ((error as { code?: string })?.code === "STORY_CHANGED") this.photoConflict = true;
      if (!this.dirty) this.draft.dismissPhotoError();
      throw error;
    } finally { this.changingPhoto = false; this.notify(); }
  }
  movePhoto(id: string, target: number) {
    return this.photoOperation(id, async index => {
      const blocks = this.movedBlocks(index, target);
      if (!blocks) return;
      const story = { blocks, coverPhotoUseId: this.story.coverPhotoUseId };
      const result = await this.draft.saveDocument({ story, editorMode: this.mode }, this.story);
      this.savedMode = this.mode;
      return storyOf(result.row.draft!);
    });
  }
  replacePhoto(id: string, input: PhotoFile) {
    return this.photoOperation(id, async (_index, photo) => {
      const result = await this.draft.replacePhoto({ photoUseId: photo.photoUseId,
        expectedStory: this.story, editorMode: this.mode, undoSession: this.undoSession, source: { ...input, kind: "file" } });
      this.savedMode = this.mode;
      return storyOf(result.row.draft!);
    });
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
  /** Attach and unlink keep their original-media and undo contracts. Once all
   * occurrences exist, save metadata, marks, positions, captions and cover together. */
  private async sync() {
    await this.draft.flush();
    let expected = storyOf(this.draft.state.snapshot);
    if (this.recordId) {
      const row = await this.options.api.getRecord(this.recordId);
      const current = row.draft ?? row.formal;
      if (current) {
        this.checkPhotos(this.draft.state.snapshot, current);
        if (!row.draft && row.contentRevision !== this.options.row?.contentRevision) {
          // Preserve a concurrent publication. Commit still compares the revision at entry.
          expected = storyOf(current);
        } else if (!sameStory(expected, storyOf(current))) {
          this.photoConflict = true;
          throw new Error("草稿内容已在其他编辑中更改，请打开最新草稿核对。");
        }
      }
    }
    while (this.dirty) {
      const source = this.draft.state.snapshot;
      const photos = storyPhotos(this.story);
      const missing = photos.find(p => !source.photos.some(current => current.photoUseId === p.photoUseId));
      if (missing) {
        const input = this.media.get(missing.photoUseId);
        if (input) {
          const result = await this.draft.attachPhoto({ ...input, caption: missing.caption, expectedStory: expected });
          const added = result.row.draft!.photos.at(-1)!;
          this.bindOccurrence(missing.photoUseId, added);
          this.checkPhotos({ photos: [...source.photos, added], coverPhotoUseId: source.coverPhotoUseId ?? added.photoUseId }, result.row.draft!);
        } else {
          const result = await this.draft.removePhoto(missing.photoUseId, this.undoSession, true, expected);
          // The receipt restores the caption at unlink time. A subsequent caption edit
          // can still be waiting in the working document.
          const restored = result.row.draft!.photos.at(-1)!;
          this.checkPhotos({ photos: [...source.photos, restored], coverPhotoUseId: source.coverPhotoUseId ?? restored.photoUseId }, result.row.draft!);
        }
        expected = storyOf(this.draft.state.snapshot);
        continue;
      }
      const extra = source.photos.find(p => !photos.some(wanted => wanted.photoUseId === p.photoUseId));
      if (extra) {
        const remaining = source.photos.filter(p => p.photoUseId !== extra.photoUseId);
        const result = await this.draft.removePhoto(extra.photoUseId, this.undoSession, false, expected);
        this.checkPhotos({ photos: remaining, coverPhotoUseId: source.coverPhotoUseId === extra.photoUseId
          ? remaining[0]?.photoUseId ?? null : source.coverPhotoUseId }, result.row.draft!);
        expected = storyOf(result.row.draft!);
        continue;
      }
      const previousById = new Map(source.photos.map(p => [p.photoUseId, p]));
      const restored = photos.find(p => {
        const previous = previousById.get(p.photoUseId)!;
        return previous.assetId !== p.assetId || previous.sha256 !== p.sha256 || previous.mediaType !== p.mediaType;
      });
      if (restored) {
        const result = await this.draft.replacePhoto({ photoUseId: restored.photoUseId, expectedStory: expected,
          undoSession: this.undoSession, source: { kind: "history", assetId: restored.assetId, sha256: restored.sha256, mediaType: restored.mediaType } });
        expected = storyOf(result.row.draft!);
        continue;
      }
      const { meta, story } = this.doc;
      const pristine = !this.recordId && meta.eventDate === this.options.defaultDate &&
        !meta.title && !meta.location && !meta.eventTime && !meta.mood && !story.blocks.length;
      const mode = this.simple ? this.mode : "story";
      if (!pristine && (!sameStory(story, storyOf(source)) ||
          Object.entries(meta).some(([key, value]) => value !== source[key as keyof StoryMeta]) ||
          mode !== (this.savedMode ?? "quick"))) {
        const sent = this.doc;
        const result = await this.draft.saveDocument({ ...meta, story, editorMode: mode }, expected);
        expected = storyOf(result.row.draft!);
        if (!sameStory(expected, story)) throw new Error("写入后的故事与编辑内容不一致");
        this.savedMode = mode;
        if (this.doc === sent && (this.simple ? this.mode : "story") === mode) this.dirty = false;
        continue;
      }
      this.dirty = false;
    }
    this.notify();
  }
  flush(): Promise<void> {
    this.cancelTimer();
    if (this.needsReload) return Promise.reject(new Error("请先打开最新草稿核对照片。"));
    if (!this.running && this.dirty) {
      this.syncError = undefined;
      this.running = this.sync().catch(error => {
        if ((error as { code?: string })?.code === "STORY_CHANGED") this.photoConflict = true;
        this.syncError = describeError(error); this.notify(); throw error;
      }).finally(() => { this.running = undefined; });
    }
    if (!this.running && this.draft.state.status === "conflict") return this.draft.flush();
    return this.running ?? Promise.resolve();
  }
  async settle() {
    if (!this.needsReload) await this.flush(); else await this.running;
  }
  async ensureTagRecord() {
    if (!this.editable) throw readOnly();
    await this.flush();
    if (!this.editable) throw readOnly();
    if (!this.recordId) await this.draft.ensureDraft();
    return this.recordId!;
  }
  async commit() {
    if (!this.editable) throw readOnly();
    this.publishing = true; this.notify();
    try {
      await this.flush();
      return await this.draft.commit();
    } finally { this.publishing = false; this.notify(); }
  }
}
