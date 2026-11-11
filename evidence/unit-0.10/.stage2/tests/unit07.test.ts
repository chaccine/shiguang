// Unit-0.7：时光轴 / 日历 / 珍藏（G01）/ 标签事务（G06）——MemoryAdapter 与纯函数，同 Rust core 语义。全部为合成数据。
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter, migrateToV4 } from "../src/platform/memory-adapter.ts";
import * as tl from "../src/domain/timeline.ts";
import { normalizeTagName } from "../src/domain/tags.ts";
import type { RecordRow, Snapshot } from "../src/domain/types.ts";

const KEY = "shiguang.synthetic.unit02";
const hasCode = (code: string) => (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; };
function storage(failOn?: (key: string) => boolean) {
  const data = new Map<string, string>();
  let fail = false;
  return { data, arm: () => { fail = true; }, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {
    if (fail || failOn?.(key)) { fail = false; throw new Error("合成写入失败"); } data.set(key, value); } };
}
function clock(base: number) { let t = base; return () => new Date(t += 1000).toISOString(); }
function device(base = Date.UTC(2026, 10, 10)) {
  const saved = storage();
  const api = new MemoryAdapter({ storage: saved, now: clock(base), search: "" });
  api.today = () => "2026-11-10";
  return { saved, api };
}
async function rec(api: MemoryAdapter, eventDate: string, body = "合成正文", eventTime: string | null = null, photo = false) {
  const id = (await api.createDraft({ title: "", body, eventDate, eventTime })).row.recordId;
  if (photo) await api.attachPhotoBytes({ recordId: id, fileName: "p.png", bytes: [137, 80, 78, 71, 9, 9, eventDate.length], caption: "合成" });
  await api.commitRecord(id, 0);
  return id;
}

// ---------- 纯函数：B02 排序 / 分页 / 日历 ----------
const snap = (eventDate: string, eventTime: string | null = null, photos = 0): Snapshot => ({
  title: "", body: "合成", eventDate, eventTime, location: "", mood: null, coverPhotoUseId: photos ? `pu-${eventDate}-0` : null, photos: Array.from({ length: photos }, (_, i) => ({
    photoUseId: `pu-${eventDate}-${i}`, assetId: `a${i}`, caption: "", sha256: "0".repeat(64), bytes: 1, mediaType: "image/png" })) });
function row(id: string, createdAt: string, formal: Snapshot | null, extra: Partial<RecordRow> = {}): RecordRow {
  return { status: "active", trashedAt: null, recordId: id, contentRevision: formal ? 1 : 0, createdAt, updatedAt: createdAt,
    committedAt: formal ? createdAt : null, baseRevision: formal ? 1 : 0, formal, draft: null,
    favorite: false, favoriteRevision: 0, tagIds: [], tagRevision: 0, ...extra };
}

test("U07 B02：同日有时刻组在前、无时刻组在后（两个方向）；同时刻/无时刻按 createdAt，再按 id", () => {
  const rows = [
    row("r1", "2026-01-01T00:00:01Z", snap("2026-05-01")),
    row("r2", "2026-01-01T00:00:02Z", snap("2026-05-01", "09:00")),
    row("r3", "2026-01-01T00:00:03Z", snap("2026-05-01", "18:30")),
    row("r4", "2026-01-01T00:00:04Z", snap("2026-05-01")),
    row("r5", "2026-01-01T00:00:05Z", snap("2026-05-01", "09:00")),
    row("r6", "2026-01-01T00:00:06Z", snap("2026-05-02")),
  ];
  const desc = tl.sortedFormal(rows, { order: "desc" }).map((r) => r.recordId);
  assert.deepEqual(desc, ["r6", "r3", "r5", "r2", "r4", "r1"]);
  const asc = tl.sortedFormal(rows, { order: "asc" }).map((r) => r.recordId);
  assert.deepEqual(asc, ["r2", "r5", "r3", "r1", "r4", "r6"]);
});

test("U07 时光轴只含正式记录：纯草稿与回收站不出现；带修改草稿时显示旧正式版", () => {
  const rows = [
    row("f", "t1", snap("2026-01-01"), { draft: { ...snap("2027-01-01"), body: "草稿新文" } }),
    row("d", "t2", null, { draft: snap("2026-01-02") }),
    row("t", "t3", snap("2026-01-03"), { status: "trashed", trashedAt: "x" }),
  ];
  const page = tl.timelinePage(rows, {}, null, 50, "2026-11-10");
  assert.deepEqual(page.items.map((i) => [i.recordId, i.eventDate, i.excerpt]), [["f", "2026-01-01", "合成"]]);
});

test("U07 分页：3000 条合成记录 limit=50 翻完不重不漏，与一次性全量顺序一致；翻页间插入不重复", () => {
  const rows: RecordRow[] = [];
  for (let i = 0; i < 3000; i++) {
    const d = new Date(Date.UTC(2015, 0, 1) + (i % 1500) * 86400000 * 2).toISOString().slice(0, 10);
    rows.push(row(`rec-${String(i).padStart(6, "0")}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z`, snap(d, i % 3 === 0 ? `0${i % 10}:00` : null)));
  }
  const t0 = performance.now();
  const full = tl.sortedFormal(rows).map((r) => r.recordId);
  const seen: string[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const page = tl.timelinePage(rows, {}, cursor, 50, "2026-11-10");
    seen.push(...page.items.map((i) => i.recordId));
    cursor = page.nextCursor; pages++;
    if (pages === 10) rows.push(row("rec-new-0001", "2030-01-01T00:00:00Z", snap("2016-06-01"))); // 中途新增
  } while (cursor);
  const ms = performance.now() - t0;
  assert.equal(new Set(seen).size, seen.length, "不重复");
  for (const id of full) assert.ok(seen.includes(id), `不漏：${id}`);
  assert.deepEqual(seen.filter((id) => id !== "rec-new-0001"), full);
  assert.ok(ms < 5000, `3000 条全部翻页耗时 ${ms.toFixed(0)}ms`);
});

test("U07 筛选：珍藏 AND 标签 OR AND 日期范围 AND 含照片", () => {
  const rows = [
    row("a", "1", snap("2024-01-01", null, 1), { favorite: true, tagIds: ["t1"] }),
    row("b", "2", snap("2024-02-01", null, 0), { favorite: true, tagIds: ["t2"] }),
    row("c", "3", snap("2024-03-01", null, 1), { favorite: false, tagIds: ["t1"] }),
    row("d", "4", snap("2025-01-01", null, 1), { favorite: true, tagIds: ["t3"] }),
  ];
  const ids = (f: Parameters<typeof tl.sortedFormal>[1]) => tl.sortedFormal(rows, f).map((r) => r.recordId);
  assert.deepEqual(ids({ tagIds: ["t1", "t2"] }), ["c", "b", "a"]);
  assert.deepEqual(ids({ tagIds: ["t1", "t2"], favoriteOnly: true }), ["b", "a"]);
  assert.deepEqual(ids({ tagIds: ["t1", "t2"], favoriteOnly: true, hasPhoto: true }), ["a"]);
  assert.deepEqual(ids({ from: "2024-02-01", to: "2024-12-31" }), ["c", "b"]);
});

test("U07 日历：真实条数、照片数、珍藏提示；空月为空；非法年月报错；远年/未来可用", () => {
  const rows = [
    row("a", "1", snap("2024-05-18", "08:00", 2)), row("b", "2", snap("2024-05-18")), row("c", "3", snap("2024-05-18"), { favorite: true }),
    row("d", "4", snap("2024-05-20")), row("e", "5", null, { draft: snap("2024-05-21") }),
    row("f", "6", snap("1900-02-03")), row("g", "7", snap("2099-12-31")),
  ];
  assert.deepEqual(tl.calendarMonth(rows, 2024, 5), [
    { date: "2024-05-18", count: 3, photoCount: 2, hasFavorite: true },
    { date: "2024-05-20", count: 1, photoCount: 0, hasFavorite: false },
  ]);
  assert.deepEqual(tl.calendarMonth(rows, 2024, 6), []);
  assert.equal(tl.calendarMonth(rows, 1900, 2)[0]!.count, 1);
  assert.equal(tl.calendarMonth(rows, 2099, 12)[0]!.count, 1);
  assert.throws(() => tl.calendarMonth(rows, 2024, 13), hasCode("INVALID_EVENT_DATE"));
  assert.equal(tl.countLabel(12), "9+");
  assert.deepEqual(tl.dayEntries(rows, "2024-05-18", "desc", "2026-11-10").map((i) => i.recordId), ["a", "c", "b"]);
});

test("U07 那年今日：只含往年同月同日；排除今年与未来；闰日只匹配 2-29", () => {
  const rows = [
    row("a", "1", snap("2025-11-10")), row("b", "2", snap("2020-11-10")), row("c", "3", snap("2020-11-10", "07:00")),
    row("d", "4", snap("2026-11-10")), row("e", "5", snap("2027-11-10")), row("f", "6", snap("2024-11-11")),
    row("g", "7", snap("2024-02-29")), row("h", "8", snap("2023-02-28")),
  ];
  const out = tl.onThisDay(rows, 11, 10, "2026-11-10");
  assert.deepEqual(out.map((g) => [g.year, g.items.map((i) => i.recordId)]), [[2025, ["a"]], [2020, ["c", "b"]]]);
  assert.deepEqual(tl.onThisDay(rows, 2, 29, "2026-11-10").map((g) => g.year), [2024]);
});

test("U07 月历网格：周一起始、42 格、不涉及时区", () => {
  const g = tl.calendarGrid(2026, 11); // 2026-11-01 是周日
  assert.equal(g.length, 42);
  assert.deepEqual(g.slice(0, 7), [null, null, null, null, null, null, "2026-11-01"]);
  assert.equal(g.filter(Boolean).length, 30);
  assert.equal(tl.calendarGrid(2024, 2).filter(Boolean).length, 29);
  assert.equal(tl.localToday(new Date(2026, 10, 10, 23, 59)), "2026-11-10");
});

test("U07 年/月/日分组保持输入顺序；未来时光标记", () => {
  const rows = [row("a", "1", snap("2027-01-02")), row("b", "2", snap("2026-12-31")), row("c", "3", snap("2026-12-31", "10:00")), row("d", "4", snap("2026-11-01"))];
  const items = tl.timelinePage(rows, {}, null, 50, "2026-11-10").items;
  assert.deepEqual(items.map((i) => i.isFuture), [true, true, true, false]);
  const groups = tl.groupByYmd(items);
  assert.deepEqual(groups.map((y) => [y.year, y.months.map((m) => [m.month, m.days.map((d) => [d.date, d.items.map((i) => i.recordId)])])]), [
    [2027, [[1, [["2027-01-02", ["a"]]]]]],
    [2026, [[12, [["2026-12-31", ["c", "b"]]]], [11, [["2026-11-01", ["d"]]]]]],
  ]);
});

// ---------- MemoryAdapter：G01 珍藏 ----------
test("U07 G01：旧草稿存在时切换珍藏，不发布草稿、不改正文修订；随后提交草稿保留最新珍藏", async () => {
  const { api } = device();
  const id = await rec(api, "2026-03-01", "正式旧文");
  await api.saveDraft({ recordId: id, body: "草稿新文" });
  const before = await api.getRecord(id);
  const m = await api.setFavorite(id, true, 0);
  assert.equal(m.favorite, true); assert.equal(m.favoriteRevision, 1);
  const mid = await api.getRecord(id);
  assert.equal(mid.formal!.body, "正式旧文"); assert.equal(mid.draft!.body, "草稿新文"); assert.equal(mid.contentRevision, before.contentRevision);
  await api.commitRecord(id, mid.contentRevision);
  const after = await api.getRecord(id);
  assert.equal(after.formal!.body, "草稿新文"); assert.equal(after.favorite, true); assert.equal(after.favoriteRevision, 1);
});

test("U07 G01：CAS 冲突不写盘；值未变不写盘；回收站/纯草稿拒绝", async () => {
  const { api, saved } = device();
  const id = await rec(api, "2026-03-01");
  await api.setFavorite(id, true, 0);
  const bytes = saved.getItem(KEY);
  await assert.rejects(api.setFavorite(id, false, 0), hasCode("META_REVISION_CONFLICT"));
  assert.equal(saved.getItem(KEY), bytes);
  await api.setFavorite(id, true);
  assert.equal(saved.getItem(KEY), bytes, "值未变不写");
  const draftOnly = (await api.createDraft({ body: "x", eventDate: "2026-01-01" })).row.recordId;
  await assert.rejects(api.setFavorite(draftOnly, true), hasCode("RECORD_NOT_FORMAL"));
  await api.trashRecord(id);
  await assert.rejects(api.setFavorite(id, false), hasCode("RECORD_TRASHED"));
  const favs = await api.timelinePage({ favoriteOnly: true }, null, 50);
  assert.equal(favs.total, 0, "回收站记录不进珍藏筛选");
});

// ---------- MemoryAdapter：G06 标签 ----------
test("U07 标签：去空白/大小写同名冲突；改名冲突提示合并且不覆盖", async () => {
  const { api } = device();
  const a = await api.createTag("  Travel  ");
  assert.equal(a.name, "Travel");
  await assert.rejects(api.createTag("travel"), (e: unknown) => { assert.equal((e as { code: string; tagId: string }).code, "TAG_NAME_CONFLICT"); assert.equal((e as { tagId: string }).tagId, a.tagId); return true; });
  await assert.rejects(api.createTag("   "), hasCode("TAG_NAME_INVALID"));
  const b = await api.createTag("校园");
  await assert.rejects(api.renameTag(b.tagId, "TRAVEL"), hasCode("TAG_NAME_CONFLICT"));
  assert.deepEqual((await api.listTags()).map((t) => t.name).sort(), ["Travel", "校园"]);
  const renamed = await api.renameTag(a.tagId, "travel");
  assert.equal(renamed.name, "travel", "同一标签仅大小写变化允许");
  assert.equal(normalizeTagName(" A  b ").normName, "a b");
});

test("U07 标签合并：一次性改写关联并去重、回收站记录也改、留别名；删除只解除关联不删记录", async () => {
  const { api } = device();
  const r1 = await rec(api, "2026-01-01", "一", null, true), r2 = await rec(api, "2026-01-02", "二"), r3 = await rec(api, "2026-01-03", "三");
  const old = await api.createTag("学生时代"), neo = await api.createTag("校园生活"), other = await api.createTag("朋友");
  await api.setRecordTags(r1, [old.tagId, neo.tagId]);
  await api.setRecordTags(r2, [old.tagId, other.tagId]);
  await api.setRecordTags(r3, [old.tagId]);
  await api.trashRecord(r3);
  assert.deepEqual(await api.tagImpact(old.tagId), { active: 2, trashed: 1 });
  const res = await api.mergeTags(old.tagId, neo.tagId);
  assert.equal(res.affectedRecords, 3);
  assert.deepEqual((await api.getRecord(r1)).tagIds, [neo.tagId], "去重");
  assert.deepEqual((await api.getRecord(r2)).tagIds, [neo.tagId, other.tagId]);
  assert.deepEqual((await api.getRecord(r3)).tagIds, [neo.tagId]);
  await assert.rejects(api.tagImpact(old.tagId), hasCode("TAG_NOT_FOUND"));
  await assert.rejects(api.mergeTags(neo.tagId, neo.tagId), hasCode("TAG_MERGE_SAME"));
  const del = await api.deleteTag(neo.tagId);
  assert.equal(del.affectedRecords, 3);
  const row1 = await api.getRecord(r1);
  assert.deepEqual(row1.tagIds, []); assert.equal(row1.formal!.body, "一"); assert.equal(row1.formal!.photos.length, 1);
  assert.equal((await api.timelinePage({}, null, 50)).total, 2, "记录一条不少");
});

test("U07 标签事务原子性：写盘失败时内存与存储都不变（无半套关联）", async () => {
  const { api, saved } = device();
  const r1 = await rec(api, "2026-01-01"), r2 = await rec(api, "2026-01-02");
  const a = await api.createTag("A"), b = await api.createTag("B");
  await api.setRecordTags(r1, [a.tagId]); await api.setRecordTags(r2, [a.tagId, b.tagId]);
  const bytes = saved.getItem(KEY);
  for (const op of [() => api.mergeTags(a.tagId, b.tagId), () => api.deleteTag(a.tagId), () => api.renameTag(a.tagId, "C"),
    () => api.setFavorite(r1, true), () => api.setRecordTags(r1, [b.tagId])]) {
    saved.arm();
    await assert.rejects(op(), hasCode("PERSIST_REPLACE_FAILED"));
    assert.equal(saved.getItem(KEY), bytes);
    assert.deepEqual((await api.getRecord(r2)).tagIds, [a.tagId, b.tagId]);
    assert.equal((await api.listTags()).length, 2);
  }
});

test("U07 时光轴 + 日历联动：改日期提交后旧日 -1 新日 +1，无重复；草稿不计数", async () => {
  const { api } = device();
  const id = await rec(api, "2025-09-01");
  await rec(api, "2025-09-01");
  assert.equal((await api.calendarMonth(2025, 9)).find((d) => d.date === "2025-09-01")!.count, 2);
  await api.saveDraft({ recordId: id, eventDate: "2025-09-03" });
  assert.equal((await api.calendarMonth(2025, 9)).find((d) => d.date === "2025-09-03"), undefined, "草稿不点亮");
  const row = await api.getRecord(id);
  await api.commitRecord(id, row.contentRevision);
  const cal = await api.calendarMonth(2025, 9);
  assert.deepEqual(cal.map((d) => [d.date, d.count]), [["2025-09-01", 1], ["2025-09-03", 1]]);
  const page = await api.timelinePage({}, null, 50);
  assert.equal(page.items.filter((i) => i.recordId === id).length, 1);
  assert.deepEqual((await api.timelineMonths({})).map((m) => [m.year, m.month, m.count]), [[2025, 9, 2]]);
});

// ---------- 备份 / 合并 ----------
test("U07 备份往返：标签、珍藏、别名、墓碑完整；覆盖恢复后一致", async () => {
  const A = device(), B = device(Date.UTC(2026, 10, 11));
  const r = await rec(A.api, "2026-02-02");
  const t1 = await A.api.createTag("旅行"), t2 = await A.api.createTag("家人"), t3 = await A.api.createTag("待删");
  await A.api.setRecordTags(r, [t1.tagId, t2.tagId]); await A.api.setFavorite(r, true);
  await A.api.mergeTags(t2.tagId, t1.tagId); await A.api.deleteTag(t3.tagId);
  const exp = await A.api.exportBackup();
  assert.equal(exp.cancelled, false);
  if (exp.cancelled) return;
  assert.equal(exp.summary.schemaVersion, 4);
  assert.equal(exp.summary.counts.tags, 1); assert.equal(exp.summary.counts.favorites, 1);
  B.api.setNextPickedPackage(A.api.lastExportedPackage()!);
  const picked = await B.api.pickBackup();
  if (picked.cancelled) throw new Error("x");
  await B.api.restoreBackup(picked.token);
  const s = JSON.parse(B.saved.getItem(KEY)!);
  assert.equal(s.schemaVersion, 4);
  assert.equal(s.tags.length, 1); assert.equal(s.tagAliases.length, 1); assert.equal(s.tagTombstones.length, 1);
  const row = await B.api.getRecord(r);
  assert.equal(row.favorite, true); assert.deepEqual(row.tagIds, [t1.tagId]);
});

test("U07 合并导入：同名标签跨设备映射；本机已删标签不复活；本机已合并标签重映射；珍藏按修订胜出；二次合并幂等", async () => {
  const A = device(), B = device(Date.UTC(2026, 10, 12));
  const r = await rec(A.api, "2026-02-02", "共同记录");
  const travel = await A.api.createTag("旅行"), gone = await A.api.createTag("旧标签"), merged = await A.api.createTag("学生");
  await A.api.setRecordTags(r, [travel.tagId, gone.tagId, merged.tagId]);
  await A.api.exportBackup();
  const oldPkg = A.api.lastExportedPackage()!;
  // 本机（A）之后：删除“旧标签”、把“学生”合并进新建的“校园”、珍藏两次（修订 2）。
  const campus = await A.api.createTag("校园");
  await A.api.deleteTag(gone.tagId); await A.api.mergeTags(merged.tagId, campus.tagId);
  await A.api.setFavorite(r, true); await A.api.setFavorite(r, false); await A.api.setFavorite(r, true);
  A.api.setNextPickedPackage(oldPkg);
  let picked = await A.api.pickBackup(); if (picked.cancelled) throw new Error("x");
  const res = await A.api.mergeBackup(picked.token);
  const tags = await A.api.listTags();
  assert.deepEqual(tags.map((t) => t.name).sort(), ["旅行", "校园"], "旧标签不复活、学生不复活");
  assert.equal(res.plan.counts.tagsSkippedDeleted, 1); assert.equal(res.plan.counts.tagsRemapped, 1);
  const row = await A.api.getRecord(r);
  assert.equal(row.favorite, true, "本机珍藏修订更高，保留");
  // 另一台设备 B：独立创建同名“旅行”（不同 tagId），合并 A 的新包 → 映射到 B 本地的“旅行”。
  await B.api.createTag("占位"); const bTravel = await B.api.createTag("旅行");
  await A.api.exportBackup();
  B.api.setNextPickedPackage(A.api.lastExportedPackage()!);
  picked = await B.api.pickBackup(); if (picked.cancelled) throw new Error("x");
  await B.api.mergeBackup(picked.token);
  const bRow = await B.api.getRecord(r);
  assert.ok(bRow.tagIds.includes(bTravel.tagId), "同名映射到本地已有标签");
  assert.equal((await B.api.listTags()).filter((t) => t.name === "旅行").length, 1);
  const bytes = B.saved.getItem(KEY);
  B.api.setNextPickedPackage(A.api.lastExportedPackage()!);
  picked = await B.api.pickBackup(); if (picked.cancelled) throw new Error("x");
  const again = await B.api.planMerge(picked.token);
  assert.equal(again.counts.tagsAdded, 0); assert.equal(again.counts.favoritesUpdated, 0); assert.equal(again.counts.tagLinksUpdated, 0); assert.equal(again.counts.added, 0);
  await B.api.mergeBackup(picked.token);
  assert.deepEqual(JSON.parse(B.saved.getItem(KEY)!).tags, JSON.parse(bytes!).tags, "幂等");
});

test("U07 迁移：v2 预览状态 → v4 默认值；v5 拒绝", async () => {
  const saved = storage();
  saved.data.set(KEY, JSON.stringify({ version: 1, schemaVersion: 2, seq: 1, records: [{ status: "active", trashedAt: null, recordId: "rec-000001",
    contentRevision: 1, createdAt: "t", updatedAt: "t", committedAt: "t", baseRevision: 1, formal: snap("2026-01-01"), draft: null }],
    assets: {}, deletionMarkers: [], conflictCopies: [], quarantine: {} }));
  const api = new MemoryAdapter({ storage: saved, search: "" });
  const r = await api.getRecord("rec-000001");
  assert.equal(r.favorite, false); assert.deepEqual(r.tagIds, []); assert.equal(r.tagRevision, 0);
  assert.deepEqual(await api.listTags(), []);
  const s2 = storage(); s2.data.set(KEY, JSON.stringify({ version: 1, schemaVersion: 5, seq: 0, records: [], assets: {} }));
  assert.throws(() => new MemoryAdapter({ storage: s2, search: "" }), hasCode("SCHEMA_TOO_NEW"));
  assert.equal(migrateToV4({ version: 1, seq: 0, records: [], assets: {}, deletionMarkers: [], conflictCopies: [], quarantine: {} }).schemaVersion, 4);
});

test("U07 严格校验：悬空标签引用 → STATE_CORRUPT（预览状态不被静默修复）", async () => {
  const saved = storage();
  saved.data.set(KEY, JSON.stringify({ version: 1, schemaVersion: 3, seq: 1, records: [{ ...row("rec-000001", "t", snap("2026-01-01")), tagIds: ["tag-404"] }],
    assets: {}, deletionMarkers: [], conflictCopies: [], quarantine: {}, tags: [], tagDictRevision: 0, tagAliases: [], tagTombstones: [] }));
  assert.throws(() => new MemoryAdapter({ storage: saved, search: "" }), hasCode("STATE_CORRUPT"));
});
