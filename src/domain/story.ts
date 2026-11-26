import type { PhotoUse, Snapshot } from "./types.ts";

export interface TextRun { text: string; bold: boolean; italic: boolean }
export type TextKind = "paragraph" | "smallHeading" | "quote";
export interface TextBlock { kind: TextKind; runs: TextRun[] }
export type StoryBlock = TextBlock | { kind: "photo"; photoUse: PhotoUse } | { kind: "divider" };
export interface Story { blocks: StoryBlock[]; coverPhotoUseId: string | null }
type LegacyContent = Pick<Snapshot, "body" | "photos" | "coverPhotoUseId">;

export const plain = (text: string): TextRun => ({ text, bold: false, italic: false });
export const runText = (runs: TextRun[]) => runs.map(run => run.text).join("");
export const storyPhotos = (story: Story) => story.blocks.flatMap(block => block.kind === "photo" ? [block.photoUse] : []);
export const plainText = (story: Story) => story.blocks.flatMap(block => "runs" in block ? [runText(block.runs)] : []).join("\n");
export const hasContent = (story: Story) => story.blocks.some(block => block.kind === "photo" ||
  ("runs" in block && block.runs.some(run => /[^\p{White_Space}]/u.test(run.text))));
export const isSimple = (story: Story) => story.blocks.every((block, index) => block.kind === "photo" ||
  (index === 0 && block.kind === "paragraph" && block.runs.every(run => !run.bold && !run.italic)));

function invalid(): never { throw new Error("故事块、照片使用位或封面无效"); }
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

/** Same exact variant fields and occurrence/cover invariants as core::story::Story. */
export function decodeStory(value: unknown): Story {
  const { blocks, coverPhotoUseId } = fields(value, ["blocks", "coverPhotoUseId"]);
  if (!Array.isArray(blocks)) invalid();
  const ids = new Set<string>();
  const decoded = blocks.map((block): StoryBlock => {
    const kind = block?.kind;
    if (kind === "divider") { fields(block, ["kind"]); return { kind }; }
    if (kind === "photo") {
      const { photoUse } = fields(block, ["kind", "photoUse"]);
      const p = fields(photoUse, ["photoUseId", "assetId", "caption", "sha256", "bytes", "mediaType"]);
      if (typeof p.photoUseId !== "string" || !/[^\p{White_Space}]/u.test(p.photoUseId) || ids.has(p.photoUseId) ||
          typeof p.assetId !== "string" || !/[^\p{White_Space}]/u.test(p.assetId) || typeof p.caption !== "string" ||
          typeof p.sha256 !== "string" || p.sha256.length !== 64 || !/^[0-9a-f]+$/.test(p.sha256) ||
          typeof p.bytes !== "number" || !Number.isSafeInteger(p.bytes) || p.bytes < 0 || typeof p.mediaType !== "string") invalid();
      ids.add(p.photoUseId);
      return { kind, photoUse: { photoUseId: p.photoUseId, assetId: p.assetId, caption: p.caption,
        sha256: p.sha256, bytes: p.bytes, mediaType: p.mediaType } };
    }
    if (kind !== "paragraph" && kind !== "smallHeading" && kind !== "quote") invalid();
    const { runs } = fields(block, ["kind", "runs"]);
    if (!Array.isArray(runs)) invalid();
    return { kind, runs: runs.map(run => {
      const { text, bold, italic } = fields(run, ["text", "bold", "italic"]);
      if (typeof text !== "string" || typeof bold !== "boolean" || typeof italic !== "boolean") invalid();
      return { text, bold, italic };
    }) };
  });
  if (coverPhotoUseId !== null && typeof coverPhotoUseId !== "string") invalid();
  if (coverPhotoUseId === null ? ids.size > 0 : !ids.has(coverPhotoUseId)) invalid();
  return { blocks: decoded, coverPhotoUseId };
}

export function fromLegacy({ body, photos, coverPhotoUseId }: LegacyContent): Story {
  if (typeof body !== "string" || !Array.isArray(photos)) invalid();
  return decodeStory({ blocks: [
    ...(body.length ? [{ kind: "paragraph", runs: [plain(body)] }] : []),
    ...photos.map(photoUse => ({ kind: "photo", photoUse })),
  ], coverPhotoUseId });
}

export const sessionOnlyMessage = "此故事含有当前存储格式无法保存的排版。修改仅保留在本次会话，关闭或刷新后会丢失。保留至多一个开头的普通段落，其后只放照片，即可恢复自动保存。";
export function toLegacy(story: Story): LegacyContent {
  const checked = decodeStory(story);
  if (!isSimple(checked)) throw Object.assign(new Error(sessionOnlyMessage), { code: "STORY_SESSION_ONLY" });
  return { body: plainText(checked), photos: storyPhotos(checked), coverPhotoUseId: checked.coverPhotoUseId };
}
