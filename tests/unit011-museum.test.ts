// M04 projections and preview mirror; every fixture is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as museum from "../src/domain/museum.ts";
import * as timeline from "../src/domain/timeline.ts";
import { MemoryAdapter, migrateToV5 } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import type { MuseumReunionPage, SortOrder } from "../src/domain/types.ts";
import { KEY, TODAY, code, dated, device, draftOnly, ids, photos, pick, raw, record,
  repack, rid, stateWithRows, storage, syntheticRows, trash } from "./support/museum.ts";

const reunionIds = (page: MuseumReunionPage) => page.groups.flatMap((g) => ids(g.items));

test("U011 exact event month/day, prior years, formal-only and M03 share eligibility", async () => {
  const rows = dated(["2025-11-12", "2024-11-12", "2026-11-12", "2027-11-12",
    "2025-11-11", "2025-11-13", "2020-11-12", "2020-11-12", "2021-11-12"]);
  rows[0]!.createdAt = "2026-01-01T00:00:00Z";
  rows[0]!.formal!.title = "";
  rows[0]!.draft = { ...rows[0]!.formal!, title: "未提交标题", eventDate: "2030-01-01" };
  rows[1]!.createdAt = `${TODAY}T00:00:00Z`;
  draftOnly(rows[6]!); trash(rows[7]!); rows[8]!.museumHidden = true;
  const before = structuredClone(rows), { api, saved } = device(rows), disk = saved.getItem(KEY);
  const page = museum.museumReunionPage(rows, null, 50, TODAY);
  assert.deepEqual(reunionIds(page), [rid(1), rid(2)]);
  assert.deepEqual(page.groups.map(({ year, yearsAgo, label }) => [year, yearsAgo, label]),
    [[2025, 1, "1 年前的今天"], [2024, 2, "2 年前的今天"]]);
  assert.equal(page.groups[0]!.items[0]!.title, "");
  assert.deepEqual(await api.museumReunionPreview(), page);
  assert.deepEqual(await api.museumReunionPage(null, 50), page);
  assert.deepEqual((await api.onThisDay(11, 12, TODAY)).flatMap((g) => ids(g.items)), reunionIds(page));
  assert.deepEqual(timeline.onThisDay(rows, 11, 12, TODAY).flatMap((g) => ids(g.items)), reunionIds(page));
  assert.equal((await api.museumHomeSummary()).reunionCount, page.total);
  const wrongDate = dated(["2025-06-01"]); wrongDate[0]!.createdAt = `${TODAY}T00:00:00Z`;
  assert.equal(museum.museumReunionPage(wrongDate, null, 50, TODAY).total, 0);
  assert.deepEqual(rows, before); assert.equal(saved.getItem(KEY), disk);
});

test("U011 leap day, century and year boundaries never shift or widen dates", async () => {
  const rows = dated(["2000-02-29", "2024-02-29", "2024-02-28", "2024-03-01",
    "2028-02-29", "2025-12-31", "2025-01-01", "2026-01-01"]), { api } = device(rows);
  for (const [today, expected] of [
    ["2028-02-29", [2, 1]], ["2027-02-28", [3]], ["2027-03-01", [4]],
    ["2026-01-01", [7]], ["2026-12-31", [6]], ["2100-02-28", [3]],
  ] as const) {
    const page = museum.museumReunionPage(rows, null, 50, today);
    assert.deepEqual(reunionIds(page), expected.map(rid), today);
    assert.deepEqual(await api.museumReunionPage(null, 50, today), page);
    assert.deepEqual((await api.onThisDay(Number(today.slice(5, 7)), Number(today.slice(8)), today))
      .flatMap((g) => ids(g.items)), reunionIds(page));
  }
  // getFullYear/getMonth/getDate define local today; never slice a UTC ISO string.
  const now = new Date(2026, 0, 1, 0, 0, 1);
  assert.equal(timeline.localToday(now), "2026-01-01");
});

test("U011 bounded reunion preview and all pages preserve every year and sorting tie", async () => {
  const rows = syntheticRows(203);
  rows.forEach((r, i) => { r.formal!.eventDate = `${2020 + i % 6}-11-12`; });
  const { api } = device(rows), expected = timeline.onThisDay(rows, 11, 12, TODAY).flatMap((g) => ids(g.items));
  const preview = await api.museumReunionPreview();
  assert.equal(reunionIds(preview).length, 6); assert.equal(preview.total, 203); assert.ok(preview.nextCursor);
  const got = reunionIds(preview); let cursor: string | null = preview.nextCursor;
  for (let n = 0; cursor !== null; n++) {
    assert.ok(n < 203, "cursor must terminate");
    const page = await api.museumReunionPage(cursor, 7);
    assert.deepEqual(page, museum.museumReunionPage(rows, cursor, 7, TODAY));
    assert.equal(page.total, 203); got.push(...reunionIds(page)); cursor = page.nextCursor;
  }
  assert.deepEqual(got, expected); assert.equal(new Set(got).size, 203);
});

test("U011 favourites in both directions include text, hidden and future records; stable cursor survives removal", async () => {
  const rows = syntheticRows(217);
  rows.forEach((r, i) => { r.favorite = true; r.museumHidden = i % 2 === 0; if (i % 3 === 0) photos(r, 1); });
  trash(rows[0]!); draftOnly(rows[1]!);
  for (const order of ["asc", "desc"] as const) {
    const { api } = device(rows), expected = timeline.timelinePage(rows, { favoriteOnly: true, order }, null, 500, TODAY);
    let cursor: string | null = null; const got: string[] = [];
    do {
      assert.ok(got.length < 217);
      const page = await api.museumFavoritesPage(cursor, 11, order);
      assert.deepEqual(page, museum.museumFavoritesPage(rows, order, cursor, 11, TODAY));
      got.push(...ids(page.items)); cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(got, ids(expected.items)); assert.equal(new Set(got).size, 215);
    assert.ok(expected.items.some((r) => r.photoCount === 0)); assert.ok(expected.items.some((r) => r.isFuture));
    const first = await api.museumFavoritesPage(null, 11, order), boundary = first.items.at(-1)!.recordId;
    await api.setFavorite(boundary, false);
    const next = await api.museumFavoritesPage(first.nextCursor, 11, order);
    assert.deepEqual(ids(next.items), got.slice(11, 22)); assert.equal(next.total, 214);
    assert.ok(!(await api.museumFavoritesPage(null, 500, order)).items.some((r) => r.recordId === boundary));
  }
});

test("U011 photo wall pages use formal photo positions with independent captions and shared thumbnail keys", async () => {
  const rows = dated(["2024-11-12", "2024-11-12", "2099-01-01", "2020-01-01", "2020-01-01"]);
  rows.forEach((r) => photos(r, 3));
  rows[0]!.formal!.title = ""; rows[0]!.museumHidden = true;
  rows[0]!.draft = { ...rows[0]!.formal!, title: "未提交标题", photos: [], coverPhotoUseId: null };
  trash(rows[3]!); draftOnly(rows[4]!);
  const before = structuredClone(rows), { api, saved } = device(rows), disk = saved.getItem(KEY);
  for (const order of ["desc", "asc"] as const) {
    const expected = timeline.sortedFormal(rows, { order }).flatMap((r) => r.formal.photos.map((p) => p.photoUseId));
    const tiles = []; let cursor: string | null = null;
    do {
      assert.ok(tiles.length < 15);
      const page = await api.museumPhotosPage(cursor, 2, order);
      assert.deepEqual(page, museum.museumPhotosPage(rows, order, cursor, 2, TODAY));
      assert.equal(page.total, 9); tiles.push(...page.items); cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(tiles.map((p) => p.photoUseId), expected);
    assert.equal(new Set(tiles.map((p) => p.photoUseId)).size, 9);
    assert.equal(new Set(tiles.map((p) => p.assetId)).size, 1);
    for (const tile of tiles) {
      const f = rows.find((r) => r.recordId === tile.recordId)!.formal!, photo = f.photos[tile.photoIndex]!;
      assert.equal(tile.caption, photo.caption); assert.equal(tile.thumbnailKey, "ast-shared.thumb-v2.png");
      assert.equal(tile.eventDate, f.eventDate); assert.equal(tile.title, f.title || null);
      assert.equal(tile.isFuture, f.eventDate > TODAY);
    }
    const first = await api.museumPhotosPage(null, 2, order);
    await assert.rejects(api.museumPhotosPage(first.nextCursor, 2, order === "asc" ? "desc" : "asc"), code("INVALID_CURSOR"));
  }
  assert.deepEqual(rows, before); assert.equal(saved.getItem(KEY), disk);
});

test("U011 actual years, 12 month counts, year pagination and deterministic featured priority", async () => {
  const rows = dated(["2024-01-01", "2024-02-01", "2024-02-02", "2024-03-01", "2024-03-02",
    "2024-03-03", "2024-04-01", "2024-04-02", "2099-01-01", "2024-05-01", "2024-05-02"]);
  rows[0]!.favorite = rows[1]!.favorite = true;
  photos(rows[2]!, 2); photos(rows[3]!, 1); photos(rows[7]!, 1);
  rows[7]!.museumHidden = rows[7]!.favorite = rows[8]!.favorite = true;
  draftOnly(rows[9]!); trash(rows[10]!);
  const { api } = device(rows), years = museum.museumYears(rows);
  assert.deepEqual(await api.museumYears(), years); assert.deepEqual(years.map((y) => y.year), [2099, 2024]);
  assert.deepEqual(years[1], { year: 2024, recordCount: 8, photoCount: 4, months: [1, 2, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0] });
  for (const order of ["asc", "desc"] as const) {
    const got: string[] = []; let cursor: string | null = null;
    do {
      assert.ok(got.length < 11);
      const room = await api.museumYearRoom(2024, cursor, 3, order);
      assert.deepEqual(room, museum.museumYearRoom(rows, 2024, order, cursor, 3, TODAY));
      assert.deepEqual(room.summary, years[1]); assert.equal(room.page.total, 8);
      assert.deepEqual(ids(room.featured), [2, 1, 4, 3, 7, 6].map(rid));
      got.push(...ids(room.page.items)); cursor = room.page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(got, (order === "asc" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1]).map(rid));
  }
  assert.deepEqual((await api.museumYearRoom(2099, null, 50)).featured, []);
  assert.deepEqual(await api.museumYearRoom(1900, null, 50), { summary: null, featured: [], page: { items: [], total: 0, nextCursor: null } });
});

test("U011 seeded shuffle matches Rust vectors independent of storage order and minimises repeats", async () => {
  const rows = dated(Array<string>(12).fill("2024-11-12"));
  rows[8]!.museumHidden = true; rows[9]!.formal!.eventDate = "2099-01-01"; draftOnly(rows[10]!); trash(rows[11]!);
  const { api } = device(rows);
  for (const [seed, want] of [[0, [6, 3, 4, 1, 7, 5, 2, 8]], [1, [3, 5, 6, 8, 1, 7, 4, 2]],
    [42, [5, 7, 6, 8, 2, 4, 3, 1]], [0xffffffff, [6, 3, 7, 2, 5, 4, 1, 8]]] as const) {
    const page = museum.museumReshuffle(rows, seed, [], 50, TODAY);
    assert.equal(page.eligibleTotal, 8); assert.deepEqual(ids(page.items), want.map(rid));
    assert.deepEqual(await api.museumReshuffle(seed, [], 50), page);
    assert.deepEqual(museum.museumReshuffle([...rows].reverse(), seed, [], 50, TODAY), page);
    const previous = ids(page.items.slice(0, 3)), again = await api.museumReshuffle(seed, previous, 3);
    assert.ok(again.items.every((r) => !previous.includes(r.recordId)));
    const almost = ids(page.items.slice(0, 7)), limited = await api.museumReshuffle(seed, almost, 3);
    assert.equal(limited.items.filter((r) => almost.includes(r.recordId)).length, 2);
    assert.equal(new Set(ids(limited.items)).size, 3);
    assert.deepEqual(await api.museumReshuffle(seed, ids(page.items), 50), page);
  }
});

test("U011 hide persists independent G01 metadata; formal projections change only after explicit commit", async () => {
  const { api, saved } = device(), id = await record(api, "2024-11-12", 2);
  await api.setFavorite(id, true);
  await api.saveDraft({ recordId: id, title: "未提交标题", body: "未提交正文", eventDate: "2020-01-01" });
  const formal = (await api.getRecord(id)).formal!, p = formal.photos[0]!;
  await api.setDraftPhotoCaption(id, p.photoUseId, "未提交说明");
  await api.reorderDraftPhotos(id, [...formal.photos].reverse().map((p) => p.photoUseId));
  const before = await api.getRecord(id);
  const visible = (await api.museumReunionPreview()).groups[0]!.items[0]!;
  assert.equal(visible.eventDate, "2024-11-12"); assert.equal(visible.title, "");
  assert.equal(visible.excerpt, "合成正式正文");
  assert.deepEqual((await api.museumPhotosPage(null, 50)).items.map((p) => [p.photoUseId, p.caption]),
    formal.photos.map((p) => [p.photoUseId, p.caption]));
  await api.setMuseumHidden(id, true);
  assert.deepEqual(await api.getRecord(id), { ...before, museumHidden: true });
  const disk = saved.getItem(KEY), writes = saved.writes;
  await api.setMuseumHidden(id, true); assert.equal(saved.writes, writes); assert.equal(saved.getItem(KEY), disk);
  const restarted = new MemoryAdapter({ storage: saved, storageKey: KEY, search: "" }); restarted.today = () => TODAY;
  assert.equal((await restarted.getRecord(id)).museumHidden, true);
  assert.equal((await restarted.museumReunionPreview()).total, 0);
  assert.deepEqual(await restarted.onThisDay(11, 12, TODAY), []);
  assert.deepEqual((await restarted.museumReshuffle(42, [], 6)).items, []);
  assert.deepEqual((await restarted.museumYearRoom(2024, null, 50)).featured, []);
  assert.equal((await restarted.museumFavoritesPage(null, 50)).total, 1);
  assert.equal((await restarted.museumPhotosPage(null, 50)).total, 2);
  assert.equal((await restarted.museumYearRoom(2024, null, 50)).page.total, 1);
  assert.deepEqual(ids((await restarted.timelinePage({}, null, 50)).items), [id]);
  assert.equal((await restarted.calendarMonth(2024, 11))[0]!.count, 1);
  assert.deepEqual(ids(await restarted.dayEntries("2024-11-12")), [id]);
  await restarted.setFavorite(id, false);
  assert.equal((await restarted.museumFavoritesPage(null, 50)).total, 0);
  await restarted.commitRecord(id, 1);
  const committed = await restarted.getRecord(id);
  assert.equal(committed.museumHidden, true); assert.equal(committed.favorite, false);
  assert.deepEqual(committed.formal, before.draft); assert.equal(committed.draft, null);
  assert.equal((await restarted.museumYearRoom(2024, null, 50)).page.total, 0);
  assert.equal((await restarted.museumYearRoom(2020, null, 50)).page.items[0]!.title, "未提交标题");
});

test("U011 reset clears hidden flags including trash and never restores deleted records", async () => {
  const { api, saved } = device(), a = await record(api), b = await record(api), c = await record(api);
  for (const id of [a, b, c]) await api.setMuseumHidden(id, true);
  await api.trashRecord(b); await api.trashRecord(c); await api.purgeRecord(c);
  assert.equal((await api.museumHomeSummary()).hiddenCount, 2);
  const expected = raw(saved); expected.records.forEach((r) => { r.museumHidden = false; });
  assert.equal((await api.resetMuseumHidden()).affectedRecords, 2); assert.deepEqual(raw(saved), expected);
  assert.equal((await api.getRecord(b)).status, "trashed");
  await assert.rejects(api.getRecord(c), code("RECORD_DELETED"));
  assert.equal((await api.museumReunionPreview()).total, 1);
  const writes = saved.writes; assert.equal((await api.resetMuseumHidden()).affectedRecords, 0); assert.equal(saved.writes, writes);
  const draft = (await api.createDraft({ body: "合成草稿" })).row.recordId;
  for (const [id, expected] of [[draft, "RECORD_NOT_FORMAL"], [b, "RECORD_TRASHED"], [c, "RECORD_DELETED"], ["absent", "NOT_FOUND"]]) {
    await assert.rejects(api.setMuseumHidden(id!, true), code(expected!));
  }
});

test("U011 failed hide or reset keeps persisted and reopened state unchanged", async () => {
  const { api, saved } = device(), id = await record(api);
  for (const hiding of [true, false]) {
    if (!hiding) await api.setMuseumHidden(id, true);
    const before = saved.getItem(KEY), row = await api.getRecord(id);
    saved.arm(); await assert.rejects(hiding ? api.setMuseumHidden(id, true) : api.resetMuseumHidden(), code("PERSIST_REPLACE_FAILED"));
    assert.equal(saved.getItem(KEY), before); assert.deepEqual(await api.getRecord(id), row);
    assert.deepEqual(await new MemoryAdapter({ storage: saved, storageKey: KEY, search: "" }).getRecord(id), row);
  }
});

test("U011 lossless v4 to v5 and v3 chain preserve formal, draft, photo and independent metadata", async () => {
  const { api, saved } = device(), id = await record(api, "2024-11-12", 2);
  await api.setFavorite(id, true); const tag = await api.createTag("合成标签"); await api.setRecordTags(id, [tag.tagId]);
  await api.saveDraft({ recordId: id, location: "合成地点", mood: "想念" });
  const original = raw(saved), v4 = JSON.parse(JSON.stringify(original)); v4.schemaVersion = 4;
  for (const row of v4.records) delete row.museumHidden;
  const migrated = migrateToV5(structuredClone(v4));
  assert.deepEqual(migrated, original); assert.deepEqual(migrateToV5(structuredClone(migrated)), migrated);
  const savedV4 = storage(); savedV4.setItem(KEY, JSON.stringify(v4)); const disk = savedV4.getItem(KEY);
  const old = new MemoryAdapter({ storage: savedV4, storageKey: KEY, search: "" });
  assert.deepEqual(await old.getRecord(id), original.records[0]);
  assert.equal(savedV4.getItem(KEY), disk); // Preview migrates in memory; native core also saves an exact pre-migration backup.
  await old.setMuseumHidden(id, true); assert.equal(raw(savedV4).schemaVersion, 5);
  const v3 = structuredClone(v4); v3.schemaVersion = 3; delete v3.settings;
  for (const row of v3.records) for (const snap of [row.formal, row.draft]) if (snap) {
    delete snap.location; delete snap.mood; delete snap.coverPhotoUseId;
  }
  const expected = structuredClone(original);
  for (const row of expected.records) for (const snap of [row.formal, row.draft]) if (snap) {
    snap.location = ""; snap.mood = null; snap.coverPhotoUseId = snap.photos[0]?.photoUseId ?? null;
  }
  assert.deepEqual(migrateToV5(v3), expected);
});

test("U011 schema v5 requires boolean flag and future schema rejects without writes", () => {
  for (const value of [undefined, null, 0, "true"]) {
    const legacy = JSON.parse(JSON.stringify(stateWithRows(dated(["2024-11-12"]))));
    if (value === undefined) delete legacy.records[0].museumHidden; else legacy.records[0].museumHidden = value;
    const saved = storage(); saved.setItem(KEY, JSON.stringify(legacy)); const disk = saved.getItem(KEY);
    assert.throws(() => new MemoryAdapter({ storage: saved, storageKey: KEY, search: "" }), code("STATE_CORRUPT"));
    assert.equal(saved.getItem(KEY), disk);
  }
  const newer = { ...stateWithRows(), schemaVersion: 6 }, saved = storage(); saved.setItem(KEY, JSON.stringify(newer));
  const writes = saved.writes;
  assert.throws(() => new MemoryAdapter({ storage: saved, storageKey: KEY, search: "" }), code("SCHEMA_TOO_NEW"));
  assert.equal(saved.writes, writes);
});

test("U011 v5 plain and password preview backups roundtrip hidden flags with active edit draft", async () => {
  const a = device(), id = await record(a.api, "2024-11-12", 1);
  await a.api.setMuseumHidden(id, true); await a.api.saveDraft({ recordId: id, body: "未提交正文", eventDate: "2099-01-01" });
  for (const password of [undefined, "synthetic-u011-pass"]) {
    const b = device(), exp = await a.api.exportBackup({ password });
    assert.equal(exp.cancelled, false); if (exp.cancelled) throw new Error("synthetic export cancelled");
    assert.equal(exp.summary.schemaVersion, 5);
    const token = await pick(b.api, a.api.lastExportedPackage()!);
    if (password) await b.api.unlockBackup(token, password);
    await b.api.restoreBackup(token);
    assert.deepEqual(await b.api.getRecord(id), await a.api.getRecord(id));
    assert.equal((await b.api.museumReunionPreview()).total, 0);
    assert.equal((await b.api.museumPhotosPage(null, 50)).items[0]!.eventDate, "2024-11-12");
  }
});

test("U011 old v4 and v3 preview backups restore and merge with default false without clearing local hidden", async () => {
  const a = device(), id = await record(a.api, "2024-11-12", 1);
  await a.api.setMuseumHidden(id, true); await a.api.exportBackup();
  const current = a.api.lastExportedPackage()!;
  for (const version of [4, 3]) {
    const body = JSON.parse(current.body); body.manifest.schemaVersion = body.state.schemaVersion = version;
    for (const row of body.state.records) {
      delete row.museumHidden;
      if (version === 3) for (const snap of [row.formal, row.draft]) if (snap) {
        delete snap.location; delete snap.mood; delete snap.coverPhotoUseId;
      }
    }
    if (version === 3) delete body.state.settings;
    const pkg = repack(body);
    for (const merge of [false, true]) {
      const b = device(), token = await pick(b.api, pkg);
      if (merge) await b.api.mergeBackup(token); else await b.api.restoreBackup(token);
      assert.equal((await b.api.getRecord(id)).museumHidden, false);
      assert.deepEqual((await b.api.getRecord(id)).formal, (await a.api.getRecord(id)).formal);
      assert.equal(raw(b.saved).schemaVersion, 5);
    }
    const own = device(); await own.api.restoreBackup(await pick(own.api, current));
    await own.api.mergeBackup(await pick(own.api, pkg)); assert.equal((await own.api.getRecord(id)).museumHidden, true);
  }
});

test("U011 merge unions hidden by identity, is idempotent, may re-hide after reset and never resurrects", async () => {
  const a = device(), id = await record(a.api), b = device();
  await a.api.exportBackup(); const unhidden = a.api.lastExportedPackage()!;
  await b.api.restoreBackup(await pick(b.api, unhidden)); await a.api.setMuseumHidden(id, true); await a.api.exportBackup();
  const hidden = a.api.lastExportedPackage()!, token = await pick(b.api, hidden);
  assert.equal((await b.api.planMerge(token)).counts.museumHiddenUpdated, 1);
  assert.equal((await b.api.mergeBackup(token)).plan.counts.museumHiddenUpdated, 1);
  assert.equal((await b.api.getRecord(id)).museumHidden, true);
  const before = b.saved.getItem(KEY);
  assert.equal((await b.api.mergeBackup(await pick(b.api, hidden))).plan.counts.museumHiddenUpdated, 0);
  assert.equal(b.saved.getItem(KEY), before);
  await a.api.mergeBackup(await pick(a.api, unhidden)); assert.equal((await a.api.getRecord(id)).museumHidden, true);
  await b.api.resetMuseumHidden(); await b.api.mergeBackup(await pick(b.api, hidden));
  assert.equal((await b.api.getRecord(id)).museumHidden, true);
  const collision = JSON.parse(hidden.body); collision.state.records[0].createdAt = "2026-11-01T00:00:00Z";
  const c = device(); await c.api.restoreBackup(await pick(c.api, unhidden));
  const plan = (await c.api.mergeBackup(await pick(c.api, repack(collision)))).plan;
  assert.equal(plan.counts.added, 1); assert.equal(plan.counts.museumHiddenUpdated, 0);
  assert.equal((await c.api.getRecord(id)).museumHidden, false);
  assert.equal(raw(c.saved).records.filter((r) => r.museumHidden).length, 1);
  await b.api.trashRecord(id); await b.api.mergeBackup(await pick(b.api, hidden));
  assert.equal((await b.api.getRecord(id)).status, "trashed");
  await b.api.purgeRecord(id);
  const deleted = await b.api.mergeBackup(await pick(b.api, hidden));
  assert.deepEqual(deleted.plan.skippedDeleted, [id]); assert.equal(deleted.plan.counts.museumHiddenUpdated, 0);
  assert.equal((await b.api.resetMuseumHidden()).affectedRecords, 0);
  await assert.rejects(b.api.getRecord(id), code("RECORD_DELETED"));
});

test("U011 home counts empty, single, future, hidden and trash consistently without writes or media reads", async () => {
  const { api, saved } = device();
  assert.deepEqual(await api.museumHomeSummary(), { recordCount: 0, reunionCount: 0, favoriteCount: 0,
    photoCount: 0, yearCount: 0, eligibleCount: 0, hiddenCount: 0 });
  assert.deepEqual((await api.museumReunionPreview()).groups, []);
  assert.deepEqual((await api.museumReshuffle(0, ["absent"], 6)).items, []);
  const id = await record(api, "2024-11-12", 1); await api.setFavorite(id, true);
  await api.saveDraft({ recordId: id, title: "未提交", eventDate: "2099-01-01" });
  const before = saved.getItem(KEY), writes = saved.writes;
  // Read failures remain armed: projections must never call either media loader.
  api.failNext("IO_ERROR", "photoDataUrl"); api.failNext("IO_ERROR", "photoThumbUrl");
  assert.deepEqual(await api.museumHomeSummary(), { recordCount: 1, reunionCount: 1, favoriteCount: 1,
    photoCount: 1, yearCount: 1, eligibleCount: 1, hiddenCount: 0 });
  await api.museumReunionPreview(); await api.museumReunionPage(null, 50); await api.museumFavoritesPage(null, 50);
  await api.museumPhotosPage(null, 50); await api.museumYears(); await api.museumYearRoom(2024, null, 50); await api.museumReshuffle(42, [], 6);
  assert.equal(saved.getItem(KEY), before); assert.equal(saved.writes, writes);
  const assetId = (await api.getRecord(id)).formal!.photos[0]!.assetId;
  await assert.rejects(api.photoDataUrl(assetId), code("IO_ERROR")); await assert.rejects(api.photoThumbUrl(assetId), code("IO_ERROR"));
  const future = await record(api, "2099-01-01"); await api.setFavorite(future, true);
  const hidden = await record(api); await api.setMuseumHidden(hidden, true); await api.trashRecord(hidden);
  assert.deepEqual(await api.museumHomeSummary(), { recordCount: 2, reunionCount: 1, favoriteCount: 2,
    photoCount: 1, yearCount: 2, eligibleCount: 1, hiddenCount: 1 });
});

test("U011 invalid dates, limits, cursors, years and seeds reject without changing state", async () => {
  const { api, saved } = device(), before = saved.getItem(KEY);
  for (const today of ["bad", "2100-02-29", "2026-02-29"]) {
    assert.throws(() => museum.museumReunionPage([], null, 1, today), code("INVALID_EVENT_DATE"));
    await assert.rejects(api.museumHomeSummary(today), code("INVALID_EVENT_DATE"));
    await assert.rejects(api.museumReunionPreview(today), code("INVALID_EVENT_DATE"));
  }
  for (const limit of [0, 501, 1.5]) {
    await assert.rejects(api.museumReunionPage(null, limit), code("INVALID_LIMIT"));
    await assert.rejects(api.museumFavoritesPage(null, limit), code("INVALID_LIMIT"));
    await assert.rejects(api.museumPhotosPage(null, limit), code("INVALID_LIMIT"));
  }
  for (const cursor of ["bad", "[]", '["sg11-photo","desc","bad",-1]']) {
    await assert.rejects(api.museumReunionPage(cursor, 1), code("INVALID_CURSOR"));
    await assert.rejects(api.museumPhotosPage(cursor, 1), code("INVALID_CURSOR"));
  }
  for (const year of [-1, 10000, 2024.5]) await assert.rejects(api.museumYearRoom(year, null, 1), code("INVALID_EVENT_DATE"));
  for (const seed of [-1, 0x100000000, 1.5, NaN]) await assert.rejects(api.museumReshuffle(seed, [], 1), code("INVALID_SEED"));
  for (const limit of [0, 51]) await assert.rejects(api.museumReshuffle(0, [], limit), code("INVALID_LIMIT"));
  assert.equal(saved.getItem(KEY), before);
});

test("U011 Tauri adapter wires every museum command, injected date, order, cursor and uint32 seed", async () => {
  const calls: unknown[] = [], api = createTauriApi(async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]); return {} as T;
  });
  await api.museumReunionPreview(TODAY); await api.museumReunionPage("cursor-r", 17, TODAY);
  await api.museumFavoritesPage("cursor-f", 13, "asc", TODAY); await api.museumPhotosPage("cursor-p", 11, "asc", TODAY);
  await api.museumYears(); await api.museumYearRoom(2024, "cursor-y", 7, "asc", TODAY);
  await api.museumReshuffle(0xffffffff, [rid(1)], 6, TODAY); await api.museumHomeSummary(TODAY);
  await api.setMuseumHidden(rid(1), true); await api.resetMuseumHidden(); await api.onThisDay(11, 12, TODAY);
  assert.deepEqual(calls, [
    ["museum_reunion_preview", { today: TODAY }], ["museum_reunion_page", { cursor: "cursor-r", limit: 17, today: TODAY }],
    ["museum_favorites_page", { cursor: "cursor-f", limit: 13, order: "asc", today: TODAY }],
    ["museum_photos_page", { cursor: "cursor-p", limit: 11, order: "asc", today: TODAY }], ["museum_years", undefined],
    ["museum_year_room", { year: 2024, cursor: "cursor-y", limit: 7, order: "asc", today: TODAY }],
    ["museum_reshuffle", { seed: 0xffffffff, previousIds: [rid(1)], limit: 6, today: TODAY }],
    ["museum_home_summary", { today: TODAY }], ["set_museum_hidden", { recordId: rid(1), hidden: true }],
    ["reset_museum_hidden", undefined], ["on_this_day", { month: 11, day: 12, today: TODAY }],
  ]);
  calls.length = 0;
  const before = timeline.localToday();
  await api.museumReunionPreview(); await api.museumFavoritesPage(null, 6); await api.museumPhotosPage(null, 6);
  await api.museumYearRoom(2024, null, 6); const after = timeline.localToday();
  for (const [, args] of calls as [string, Record<string, unknown>][]) {
    assert.ok(args.today === before || args.today === after);
    if ("order" in args) assert.equal(args.order, "desc");
  }
});

test("U011 5000-record domain and MemoryAdapter first-page budgets with no persisted projections", async (t) => {
  const rows = syntheticRows(5000);
  rows.forEach((r, i) => {
    photos(r, 1); if (i % 100 === 0) r.formal!.eventDate = "2024-11-12";
    r.favorite = i % 5 === 0; r.museumHidden = i % 37 === 0;
  });
  const { api, saved } = device(rows), before = saved.getItem(KEY), writes = saved.writes;
  const domain: Record<string, () => unknown> = {
    homeSummary: () => museum.museumHomeSummary(rows, TODAY),
    reunionPreview: () => museum.museumReunionPage(rows, null, 6, TODAY),
    reunionPage: () => museum.museumReunionPage(rows, null, 50, TODAY),
    favoritesFirst: () => museum.museumFavoritesPage(rows, "desc", null, 50, TODAY),
    photosFirst: () => museum.museumPhotosPage(rows, "desc", null, 50, TODAY),
    years: () => museum.museumYears(rows), yearRoomFirst: () => museum.museumYearRoom(rows, 2024, "desc", null, 50, TODAY),
    reshuffle: () => museum.museumReshuffle(rows, 42, [], 6, TODAY),
  };
  const adapter: Record<string, () => Promise<unknown>> = {
    homeSummary: () => api.museumHomeSummary(), reunionPreview: () => api.museumReunionPreview(),
    reunionPage: () => api.museumReunionPage(null, 50), favoritesFirst: () => api.museumFavoritesPage(null, 50),
    photosFirst: () => api.museumPhotosPage(null, 50), years: () => api.museumYears(),
    yearRoomFirst: () => api.museumYearRoom(2024, null, 50), reshuffle: () => api.museumReshuffle(42, [], 6),
  };
  const timings: Record<string, number> = {};
  for (const [name, query] of Object.entries(domain)) {
    let start = performance.now(); const expected = query(); const domainMs = performance.now() - start;
    start = performance.now(); const actual = await adapter[name]!(); const adapterMs = performance.now() - start;
    timings[`domain.${name}`] = Number(domainMs.toFixed(3)); timings[`adapter.${name}`] = Number(adapterMs.toFixed(3));
    assert.deepEqual(actual, expected, name);
    assert.ok(domainMs < 150, `${name} domain ${domainMs.toFixed(3)} ms exceeds 150 ms`);
    assert.ok(adapterMs < 150, `${name} adapter ${adapterMs.toFixed(3)} ms exceeds 150 ms`);
  }
  for (const order of ["asc", "desc"] satisfies SortOrder[]) {
    const first = await api.museumPhotosPage(null, 50, order), start = performance.now();
    const next = await api.museumPhotosPage(first.nextCursor, 50, order), elapsed = performance.now() - start;
    timings[`adapter.photosNext.${order}`] = Number(elapsed.toFixed(3)); assert.ok(elapsed < 150);
    assert.equal(first.total, 5000); assert.equal(next.items.length, 50);
    assert.equal(new Set([...first.items, ...next.items].map((p) => p.photoUseId)).size, 100);
  }
  assert.equal((await api.museumHomeSummary()).recordCount, 5000);
  assert.equal(saved.getItem(KEY), before); assert.equal(saved.writes, writes);
  t.diagnostic(JSON.stringify({ records: 5000, photoUses: 5000, timingsMs: timings }));
});
