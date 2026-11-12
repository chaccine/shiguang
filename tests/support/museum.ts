// Synthetic M04 fixtures shared by domain, adapter and persistence tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryAdapter, migrateToV5 } from "../../src/platform/memory-adapter.ts";
import type { PreviewBackup } from "../../src/platform/memory-adapter.ts";
import type { RecordRow } from "../../src/domain/types.ts";
import { sha256 } from "../../src/platform/bytes.ts";

export const KEY = "u011-synthetic";
export const TODAY = "2026-11-12";
export const code = (wanted: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, wanted); return true;
};
export const ids = (items: readonly { recordId: string }[]) => items.map((item) => item.recordId);
export const rid = (n: number) => `rec-${String(n).padStart(6, "0")}`;
export type PreviewState = ReturnType<typeof migrateToV5>;

export function storage() {
  const data = new Map<string, string>();
  let fail = false, writes = 0;
  return {
    data, get writes() { return writes; }, arm() { fail = true; },
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      if (fail) { fail = false; throw new Error("合成写入失败"); }
      writes++; data.set(key, value);
    },
  };
}
export function stateWithRows(records: RecordRow[] = []): PreviewState {
  return { version: 1, schemaVersion: 5, seq: 100000, records, assets: {}, quarantine: {},
    settings: { theme: "system", appLock: null }, deletionMarkers: [], conflictCopies: [],
    tags: [], tagDictRevision: 0, tagAliases: [], tagTombstones: [] };
}
export function device(records: RecordRow[] = [], base = Date.UTC(2026, 10, 12)) {
  const saved = storage(); saved.setItem(KEY, JSON.stringify(stateWithRows(records)));
  let tick = base;
  const api = new MemoryAdapter({ storage: saved, storageKey: KEY, search: "", now: () => new Date(tick += 1000).toISOString() });
  api.today = () => TODAY;
  return { saved, api };
}
export function raw(saved: ReturnType<typeof storage>): PreviewState { return JSON.parse(saved.getItem(KEY)!); }

/** Same date/time/body/ID distribution as core/tests/unit07_support::synthetic_rows,
 * used by unit08_stress and unit011_stress. Photo uses are added separately. */
export function syntheticRows(count: number): RecordRow[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  return Array.from({ length: count }, (_, index) => {
    const i = index + 1, createdAt = `2020-01-01T00:${pad(Math.floor(i / 60) % 60)}:${pad(i % 60)}Z`;
    return { recordId: rid(i), createdAt, updatedAt: createdAt, committedAt: createdAt,
      contentRevision: 1, baseRevision: 1, status: "active", trashedAt: null, draft: null,
      museumHidden: false, favorite: false, favoriteRevision: 0, tagIds: [], tagRevision: 0,
      formal: { title: `合成${i}`, body: "合成\n正文".repeat(50), eventDate: `${2000 + i % 30}-${pad(1 + i % 12)}-${pad(1 + i % 28)}`,
        eventTime: i % 3 !== 0 ? `${pad(i % 24)}:${pad(i % 60)}` : null,
        location: "", mood: null, coverPhotoUseId: null, photos: [] } };
  });
}
export function dated(dates: readonly string[]): RecordRow[] {
  return syntheticRows(dates.length).map((row, i) => ({ ...row, formal: { ...row.formal!, eventDate: dates[i]! } }));
}
export function photos(row: RecordRow, count: number): void {
  const f = row.formal!;
  f.photos = Array.from({ length: count }, (_, i) => ({ photoUseId: `pu-${row.recordId}-${i}`, assetId: "ast-shared",
    caption: `${row.recordId} 使用位 ${i}\n<&>`, sha256: "0".repeat(64), bytes: 1, mediaType: "image/png" }));
  f.coverPhotoUseId = f.photos.at(-1)?.photoUseId ?? null;
}
export function draftOnly(row: RecordRow): void {
  row.draft = row.formal; row.formal = null; row.contentRevision = row.baseRevision = 0; row.committedAt = null;
}
export function trash(row: RecordRow): void { row.status = "trashed"; row.trashedAt = "2026-11-12T00:00:00Z"; }

export const syntheticPng = new Uint8Array(readFileSync(new URL("../../core/tests/fixtures/v3/media/ast-00c2072079ed2cd0.png", import.meta.url)));
export async function record(api: MemoryAdapter, date = "2024-11-12", photoCount = 0): Promise<string> {
  const id = (await api.createDraft({ title: "", body: "合成正式正文", eventDate: date })).row.recordId;
  for (let i = 0; i < photoCount; i++) await api.attachPhotoBytes({ recordId: id, fileName: "synthetic.png", bytes: syntheticPng, caption: `合成说明 ${i}\n<&>` });
  await api.commitRecord(id, 0); return id;
}
export async function pick(api: MemoryAdapter, pkg: PreviewBackup): Promise<string> {
  api.setNextPickedPackage(pkg); const chosen = await api.pickBackup();
  assert.equal(chosen.cancelled, false); if (chosen.cancelled) throw new Error("synthetic backup missing");
  return chosen.token;
}
export function repack(body: object): PreviewBackup {
  const text = JSON.stringify(body), bytes = new TextEncoder().encode(text);
  return { magic: "SGBAK-PREVIEW", body: text, sha256: sha256(bytes), bytes: bytes.length };
}
