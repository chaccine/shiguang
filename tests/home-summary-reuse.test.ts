import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { MuseumSummary } from "../src/domain/types.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { code, dated, device, draftOnly, KEY, photos, pick, record, rid, stateWithRows, storage, syntheticPng, TODAY, trash } from "./support/museum.ts";

const empty: MuseumSummary = { recordCount: 0, reunionCount: 0, favoriteCount: 0, photoCount: 0,
  yearCount: 0, eligibleCount: 0, hiddenCount: 0 };
const one: MuseumSummary = { ...empty, recordCount: 1, reunionCount: 1, yearCount: 1, eligibleCount: 1 };
const original = JSON.stringify(stateWithRows(dated(["2024-11-12"])));

function fixture(t: TestContext, raw: string | null = original) {
  const saved = storage();
  if (raw !== null) saved.data.set(KEY, raw);
  const read = t.mock.method(saved, "getItem"), write = t.mock.method(saved, "setItem");
  const parse = t.mock.method(JSON, "parse");
  function open(deferOpen = false, search = "") {
    const api = new MemoryAdapter({ storage: saved, storageKey: KEY, deferOpen, search });
    api.today = () => TODAY;
    return api;
  }
  async function summary(api: MemoryAdapter, expected: MuseumSummary | string,
    { today, reads = 1, parses = 0 }: { today?: string; reads?: 0 | 1; parses?: 0 | 1 } = {}) {
    const before = new Map(saved.data), writes = write.mock.callCount();
    const readStart = read.mock.callCount(), parseStart = parse.mock.callCount();
    const result = api.museumHomeSummary(today);
    if (typeof expected === "string") await assert.rejects(result, code(expected));
    else assert.deepEqual(await result, expected);
    const gets = read.mock.calls.slice(readStart);
    assert.deepEqual(gets.map(call => call.arguments), reads ? [[KEY]] : []);
    assert.deepEqual(parse.mock.calls.slice(parseStart).map(call => call.arguments[0]), parses ? [gets[0]!.result] : []);
    assert.equal(write.mock.callCount(), writes);
    assert.deepEqual(saved.data, before);
  }
  return { saved, open, read, write, parse, summary };
}

test("H1 eager open reads and validates once, then counts today's formal, hidden and leap-day rows", async t => {
  const rows = dated(["2020-02-29", "2024-03-01", "2022-02-28", "2019-03-01", "2000-02-29"]);
  rows[0]!.favorite = true; photos(rows[0]!, 2); photos(rows[2]!, 1);
  draftOnly(rows[3]!); trash(rows[4]!);
  for (const row of rows.slice(2)) row.museumHidden = true;
  const raw = JSON.stringify(stateWithRows(rows));
  const { open, read, parse, summary } = fixture(t, raw), api = open();
  assert.deepEqual(read.mock.calls.map(c => c.arguments), [[KEY]]);
  assert.deepEqual(parse.mock.calls.map(c => c.arguments[0]), [raw]);

  // Intervening preview queries and edits to returned rows cannot modify the opened snapshot.
  const listed = await api.listFormalRecords();
  listed.forEach(r => { r.formal!.photos.length = 0; r.museumHidden = false; });
  await api.mediaReport();
  const days = ["2024-02-29", "2024-03-01"];
  api.today = () => days.shift()!;
  const leap = { recordCount: 3, reunionCount: 1, favoriteCount: 1, photoCount: 3, yearCount: 3, eligibleCount: 1, hiddenCount: 3 };
  await summary(api, leap);
  await summary(api, { ...leap, reunionCount: 0, eligibleCount: 2 }, { parses: 1 });
  await summary(api, leap, { today: "2024-02-29", parses: 1 });
  assert.deepEqual(days, []);
});

test("H1 deferred preview requires a successful storeStatus and consumes each open once", async t => {
  const { open, saved, read, parse, summary } = fixture(t), api = open(true);
  assert.equal(read.mock.callCount(), 0);
  await summary(api, one, { parses: 1 });
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  assert.deepEqual(read.mock.calls.map(c => c.arguments), [[KEY], [KEY], [KEY]]);
  assert.deepEqual(parse.mock.calls.map(c => c.arguments[0]), [original, original, original]);
  await api.getSettings();
  await summary(api, one);
  await summary(api, one, { parses: 1 });

  assert.deepEqual(await api.storeStatus(), { ok: true });
  saved.data.set(KEY, "{");
  assert.partialDeepStrictEqual(await api.storeStatus(), { ok: false, code: "STATE_CORRUPT" });
  saved.data.set(KEY, original);
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  api.failNext("STORE_STARTING", "storeStatus");
  await assert.rejects(api.storeStatus(), code("STORE_STARTING"));
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  await summary(api, one);
});

test("H1 reads the exact string once, including equal-length replacements and legacy inputs", async t => {
  const { open, saved, read, summary } = fixture(t), api = open();
  const tomorrow = original.replace("2024-11-12", "2024-11-13");
  assert.notEqual(tomorrow, original); assert.equal(tomorrow.length, original.length);
  // Only this getItem returns the replacement. A second read would see the original again.
  read.mock.mockImplementationOnce(() => tomorrow);
  await summary(api, { ...one, reunionCount: 0 }, { parses: 1 });
  await summary(api, one, { parses: 1 });

  const hidden = stateWithRows(dated(["2024-11-12"]));
  hidden.records[0]!.museumHidden = true;
  saved.data.set(KEY, JSON.stringify(hidden));
  assert.deepEqual(await api.storeStatus(), { ok: true });
  const legacy = JSON.stringify({ ...hidden, schemaVersion: 4 });
  saved.data.set(KEY, legacy);
  await summary(api, one, { parses: 1 }); // v4 migration resets museumHidden in memory.
  assert.deepEqual(await api.storeStatus(), { ok: true });
  await summary(api, one);
  assert.equal(saved.data.get(KEY), legacy);
});

test("H1 changed input runs full validation before the domain date check and consumes eligibility", async t => {
  const { saved, open, summary } = fixture(t);
  const unlinked = stateWithRows(dated(["2024-11-12"]));
  unlinked.records[0]!.tagIds = ["missing-tag"];
  const badSetting = original.replace('"system"', '"broken"');
  assert.equal(badSetting.length, original.length);
  for (const [raw, error] of [
    ["{", "STATE_CORRUPT"], [badSetting, "STATE_CORRUPT"], [JSON.stringify(unlinked), "STATE_CORRUPT"],
    [JSON.stringify({ schemaVersion: 7, records: null }), "SCHEMA_TOO_NEW"],
  ] as const) {
    const api = open();
    saved.data.set(KEY, raw);
    await summary(api, error, { today: "2100-02-29", parses: 1 });
    saved.data.set(KEY, original);
    await summary(api, one, { parses: 1 });
  }
});

test("H1 date provider, startup and injected errors, getItem failure and invalid dates retain precedence", async t => {
  const { open, read, summary } = fixture(t);
  const blocked = open(true, "?fail=locked");
  blocked.failNext("IO_ERROR", "museumHomeSummary");
  await summary(blocked, "STORE_LOCKED", { today: "bad", reads: 0 });
  assert.partialDeepStrictEqual(await blocked.storeStatus(), { ok: false, code: "STORE_LOCKED" });

  const api = open();
  let days = 0;
  api.today = () => { days++; return "bad"; };
  api.failNext("STORE_STARTING", "museumHomeSummary");
  await summary(api, "STORE_STARTING", { reads: 0 });
  assert.equal(days, 1);
  await summary(api, "INVALID_EVENT_DATE", { parses: 1 });
  assert.equal(days, 2);
  assert.deepEqual(await api.storeStatus(), { ok: true });
  read.mock.mockImplementationOnce(() => { throw new Error("synthetic read failure"); });
  await summary(api, "IO_ERROR", { today: "bad" });
  await summary(api, one, { today: TODAY, parses: 1 });

  assert.deepEqual(await api.storeStatus(), { ok: true });
  await summary(api, "INVALID_EVENT_DATE", { today: "2026-02-29" });
  await summary(api, one, { today: TODAY, parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  api.today = () => { throw { code: "CLOCK_FAILURE" }; };
  await summary(api, "CLOCK_FAILURE", { reads: 0 });
  await summary(api, one, { today: TODAY, parses: 1 });
});

test("H1 missing storage or missing key uses a copy of local state", async t => {
  const { open, saved, summary } = fixture(t, null);
  const cold = open();
  await summary(cold, empty);
  const memory = new MemoryAdapter({ search: "" });
  await record(memory);
  const clone = t.mock.method(globalThis, "structuredClone");
  await summary(memory, one, { today: TODAY, reads: 0 });
  assert.equal(clone.mock.callCount(), 1);

  saved.data.set(KEY, original);
  const api = open();
  saved.data.delete(KEY);
  await summary(api, one);
  assert.equal(clone.mock.callCount(), 2);
  saved.data.set(KEY, original);
  await summary(api, one, { parses: 1 });
});

test("H1 two instances sharing a key see the latest commit and preserve the reader's local conflict draft", async t => {
  const rows = dated(["2024-11-12"]); draftOnly(rows[0]!);
  rows[0]!.draft!.body = "local draft";
  const { open, summary } = fixture(t, JSON.stringify(stateWithRows(rows)));
  const reader = open(), writer = open(), id = rows[0]!.recordId;
  await summary(writer, empty);
  await summary(reader, empty);
  assert.deepEqual(await reader.storeStatus(), { ok: true });
  await writer.saveDraft({ recordId: id, body: "other instance" });
  await writer.commitRecord(id, 0);
  await summary(reader, one, { parses: 1 });
  await assert.rejects(reader.commitRecord(id, 0), code("REVISION_CONFLICT"));
  const row = await writer.getRecord(id);
  assert.equal(row.formal!.body, "other instance"); assert.equal(row.draft!.body, "local draft");
  assert.equal(row.contentRevision, 1); assert.equal(row.baseRevision, 0);
});

test("H1 failed writes, no-op writes, reset and local state replacement invalidate identical bytes", async t => {
  const { saved, write, open, summary } = fixture(t), api = open(), id = rid(1);
  saved.arm();
  await assert.rejects(api.setMuseumHidden(id, true), code("PERSIST_REPLACE_FAILED"));
  assert.equal(saved.data.get(KEY), original); assert.equal(saved.writes, 0); assert.equal(write.mock.callCount(), 1);
  await summary(api, one, { parses: 1 });

  assert.deepEqual(await api.storeStatus(), { ok: true });
  api.failNext("IO_ERROR", "saveDraft");
  await assert.rejects(api.saveDraft({ recordId: id, body: "failed" }), code("IO_ERROR"));
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  await assert.rejects(api.setFavorite(id, true, 99), code("META_REVISION_CONFLICT"));
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  assert.equal((await api.resetMuseumHidden()).affectedRecords, 0);
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  const returned = await api.getRecord(id);
  returned.museumHidden = true;
  await summary(api, one, { parses: 1 });
  assert.equal(saved.writes, 0);

  assert.deepEqual(await api.storeStatus(), { ok: true });
  assert.equal(api.resetUnlockedDemo(), true); assert.equal(saved.writes, 1);
  saved.data.set(KEY, original); // external return to the pre-reset bytes
  await summary(api, one, { parses: 1 });
});

test("H1 failed quarantine and hidden writes keep the opened state isolated from writable reloads", async t => {
  const state = stateWithRows(dated(["2024-11-12"]));
  state.assets.orphan = { dataUrl: "data:image/png;base64,AA==", sha256: "0".repeat(64), bytes: 1 };
  const raw = JSON.stringify(state), { open, saved, summary } = fixture(t, raw), api = open();
  saved.arm();
  await assert.rejects(api.mediaReport(), code("PERSIST_REPLACE_FAILED"));
  assert.equal(saved.data.get(KEY), raw); assert.equal(saved.writes, 0);
  await summary(api, one, { parses: 1 });
  assert.deepEqual(await api.storeStatus(), { ok: true });
  saved.arm();
  await assert.rejects(api.setMuseumHidden(rid(1), true), code("PERSIST_REPLACE_FAILED"));
  assert.equal(saved.data.get(KEY), raw); assert.equal(saved.writes, 0);
  saved.data.delete(KEY);
  await summary(api, one); // The missing-key fallback observes the private conflict baseline.
});

test("H1 reflects draft publication, photo and tag changes, hiding, trash, restore and purge", async t => {
  const rows = dated(["2024-11-12"]); draftOnly(rows[0]!);
  const { open, saved, summary } = fixture(t, JSON.stringify(stateWithRows(rows)));
  const api = open(), id = rows[0]!.recordId;
  async function change(action: () => Promise<unknown>, expected: MuseumSummary) {
    assert.deepEqual(await api.storeStatus(), { ok: true });
    const writes = saved.writes;
    await action();
    assert.equal(saved.writes, writes + 1);
    await summary(api, expected, { parses: 1 });
  }
  const withPhoto = { ...one, photoCount: 1 }, hidden = { ...withPhoto, eligibleCount: 0, reunionCount: 0, hiddenCount: 1 };
  await summary(api, empty);
  await change(() => api.attachPhotoBytes({ recordId: id, fileName: "synthetic.png", bytes: syntheticPng, caption: "draft" }), empty);
  await change(() => api.commitRecord(id, 0), withPhoto);
  const tag = await api.createTag("Synthetic");
  await change(() => api.setRecordTags(id, [tag.tagId]), withPhoto);
  assert.deepEqual((await api.getRecord(id)).tagIds, [tag.tagId]);
  await change(() => api.setMuseumHidden(id, true), hidden);
  await change(() => api.trashRecord(id), { ...empty, hiddenCount: 1 });
  await change(() => api.restoreRecord(id), hidden);
  await change(() => api.trashRecord(id), { ...empty, hiddenCount: 1 });
  await change(() => api.purgeRecord(id), empty);
  await assert.rejects(api.getRecord(id), code("RECORD_DELETED"));
});

for (const operation of ["restoreBackup", "mergeBackup"] as const) {
  test(`H1 import selection, failed safety copy and ${operation} invalidate the open`, async t => {
    const incoming = dated(["2016-11-12"]);
    incoming[0]!.recordId = rid(2); incoming[0]!.favorite = true;
    const source = device(incoming);
    await source.api.exportBackup();
    const { open, saved, write, summary } = fixture(t), api = open();
    const token = await pick(api, source.api.lastExportedPackage()!);
    await summary(api, one, { parses: 1 });
    assert.deepEqual(await api.storeStatus(), { ok: true });
    saved.arm();
    await assert.rejects(api[operation](token), code("RESTORE_SAFETY_BACKUP_FAILED"));
    assert.equal(saved.data.get(KEY), original); assert.equal(saved.writes, 0);
    await summary(api, one, { parses: 1 });

    assert.deepEqual(await api.storeStatus(), { ok: true });
    await api[operation](token);
    assert.equal(saved.writes, 2);
    const [safety, replacement] = write.mock.calls.slice(-2);
    assert.ok(safety!.arguments[0].startsWith(KEY + ".pre-")); assert.equal(safety!.arguments[1], original);
    assert.equal(replacement!.arguments[0], KEY); assert.equal(replacement!.arguments[1], saved.data.get(KEY));
    const count = operation === "mergeBackup" ? 2 : 1;
    await summary(api, { ...one, recordCount: count, reunionCount: count, yearCount: count, eligibleCount: count, favoriteCount: 1 }, { parses: 1 });
  });
}
