// Unique source anchors are checked before launch. The diagnostic transform only inserts
// standalone lines. Removing those lines must recover the entire original test file.
export const testFile = "tests/unit011-museum.test.ts";
export const profileFiles = ["src/platform/memory-adapter.ts", "src/domain/tags.ts",
  "src/domain/timeline.ts", "src/domain/museum.ts"];
const marker = " // museum-observer";
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw Error("Non-unique or missing observer anchor: " + anchor);
  return source.replace(anchor, () => replacement);
}
export function instrumentTest(original) {
  let result = original;
  function insertAfter(anchor, additions) {
    const lines = additions.map(line => "    " + line + marker + "\n").join("");
    result = once(result, anchor + "\n", anchor + "\n" + lines);
  }
  insertAfter("  const { api, saved } = device(rows), before = saved.getItem(KEY), writes = saved.writes;", [
    "const obs = globalThis.__museumPerf; obs.fixture(before, saved, writes);"]);
  insertAfter("    let start = performance.now(); const expected = query(); const domainMs = performance.now() - start;", [
    'obs.times["domain." + name] = domainMs;', 'if (name === "reunionPage") obs.beforeTarget();']);
  insertAfter("    start = performance.now(); const actual = await adapter[name]!(); const adapterMs = performance.now() - start;", [
    'if (name === "reunionPage") obs.afterTarget(start, adapterMs);', 'obs.times["adapter." + name] = adapterMs;']);
  insertAfter("    assert.deepEqual(actual, expected, name);", ["obs.matched(name, actual);"]);
  insertAfter("    const next = await api.museumPhotosPage(first.nextCursor, 50, order), elapsed = performance.now() - start;", [
    'obs.times["adapter.photosNext." + order] = elapsed;']);
  insertAfter("    assert.equal(new Set([...first.items, ...next.items].map((p) => p.photoUseId)).size, 100);", [
    "obs.continued[order] = true;"]);
  insertAfter("  assert.equal((await api.museumHomeSummary()).recordCount, 5000);\n" +
    "  assert.equal(saved.getItem(KEY), before); assert.equal(saved.writes, writes);", ["obs.fullAssertions = true;"]);
  if (result.split("\n").filter(line => !line.endsWith(marker)).join("\n") !== original) throw Error("Original test drift");
  return result;
}

// Only the separate profile gets phase boundaries and visits inside the operation.
export function instrumentProfile(file, source) {
  const phase = name => 'globalThis.__museumPerf.phase("' + name + '"); ';
  const count = name => "if (globalThis.__museumPerf.active) globalThis.__museumPerf.helper." + name + "++; ";
  const pre = (needle, addition) => { source = once(source, needle, addition + needle); };
  if (file === profileFiles[0]) {
    pre("try { raw = this.storage?.getItem(this.key) ?? null; }", phase("storageRead"));
    const parse = "const state = JSON.parse(raw) as MemoryState;";
    source = once(source, parse, phase("parse") + parse + phase("validation") + count("parse"));
    pre('if (typeof row.museumHidden !== "boolean" || typeof row.recordId', count("rowValidation"));
    pre("if (snap === null) continue;", count("snapshotSlots"));
    pre("if (![p.photoUseId, p.assetId, p.caption, p.mediaType]", count("photoValidation"));
    pre("if (validateSnapshotDetails(snap))", count("snapshotValidation"));
    const ret = "return museum.museumReunionPage(this.reload().records,cursor,limit,today);";
    source = once(source, ret, "const records = this.reload().records; " + phase("projection") +
      "const result = museum.museumReunionPage(records,cursor,limit,today); " + phase("promiseReturn") + "return result;");
  } else if (file === profileFiles[1]) pre("if (!Array.isArray(r.tagIds) || new Set", count("tagRowValidation"));
  else if (file === profileFiles[2]) pre("const y = Number(r.formal.eventDate.slice(0, 4));\n    return !r.museumHidden", count("eligibility"));
  else if (file === profileFiles[3]) pre("return { ...toItem(row,today), title:row.formal.title", count("projection"));
  return source;
}
