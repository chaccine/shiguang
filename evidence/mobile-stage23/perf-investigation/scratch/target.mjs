import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { before, after, counters } from "./probes.mjs";
import { inputFacts, keys, hash, idHash, queries } from "./work.mjs";

export function install(dir, profile) {
  const times = Object.fromEntries(keys.map(k => [k, null]));
  const equal = Object.fromEntries(queries.map(k => [k, false]));
  const continued = { asc: false, desc: false };
  const target = {}, gc = [], phases = [];
  const helper = { parse: 0, rowValidation: 0, snapshotSlots: 0, snapshotValidation: 0,
    photoValidation: 0, tagRowValidation: 0, eligibility: 0, projection: 0 };
  let original, storage, writes, page, home, startPerfMs, elapsedPerfMs, gcObserver;
  const expected = JSON.parse(readFileSync(new URL("./input.json", import.meta.url)));
  const onGc = entries => {
    for (const e of entries) gc.push({ startMs: e.startTime, durationMs: e.duration, kind: e.detail.kind });
  };
  if (profile) {
    gcObserver = new PerformanceObserver(list => onGc(list.getEntries()));
    gcObserver.observe({ entryTypes: ["gc"] });
  }
  const obs = {
    times, equal, continued, helper, active: false, fullAssertions: false,
    fixture(bytes, saved, count) { original = bytes; storage = saved; writes = count; },
    beforeTarget() { obs.active = profile; before(target); },
    afterTarget(start, elapsed) {
      after(target);
      obs.active = false;
      startPerfMs = start;
      elapsedPerfMs = elapsed;
    },
    phase(name) {
      if (obs.active) phases.push({ name, perfMs: performance.now(), counters: counters() });
    },
    matched(name, actual) {
      equal[name] = true;
      if (name === "reunionPage") page = actual;
      if (name === "homeSummary") home = actual;
    }
  };
  globalThis.__museumPerf = obs;
  process.once("exit", () => {
    if (gcObserver) { onGc(gcObserver.takeRecords()); gcObserver.disconnect(); }
    const failures = [];
    const check = (ok, desc) => { if (!ok) failures.push(desc); };
    let input = null, stored = null, output = null;
    if (storage) {
      input = inputFacts(original);
      const endBytes = storage.getItem("u011-synthetic");
      stored = { beforeWrites: writes, afterWrites: storage.writes, identical: original === endBytes,
        afterBytes: Buffer.byteLength(endBytes), afterSha256: hash(endBytes) };
      check(isDeepStrictEqual(input, expected), "input fingerprint/work");
      check(stored.identical && writes === 1 && storage.writes === writes, "stored bytes/writes");
    } else check(false, "stress fixture unavailable");
    if (page) {
      const ids = page.groups.flatMap(g => g.items.map(x => x.recordId));
      output = { total: page.total, items: ids.length, years: page.groups.map(g => g.year),
        nextCursor: page.nextCursor, eligibleIdSetSha256: idHash(ids), pageSha256: hash(JSON.stringify(page)) };
      check(page.total === 48 && ids.length === 48 && page.groups.length === 1 && page.groups[0].year === 2024
        && page.nextCursor === null && output.eligibleIdSetSha256 === expected.eligibleIdSetSha256, "reunion result");
    }
    if (home) check(home.recordCount === 5000 && home.photoCount === 5000 && home.reunionCount === 48 &&
      home.favoriteCount === 1000 && home.hiddenCount === 136, "home counts");
    const gcInTarget = gc.filter(e => e.startMs < startPerfMs + elapsedPerfMs && e.startMs + e.durationMs > startPerfMs);
    writeFileSync(join(dir, "museum.json"), JSON.stringify({
      pid: process.pid, parent: process.ppid, times, equal, continued, fullAssertions: obs.fullAssertions,
      input, stored, home, output, startPerfMs, elapsedPerfMs, target, failures,
      ...(profile && { phases, helper, gcInTarget, observedGcEvents: gc.length })
    }, null, 2) + "\n");
  });
}
