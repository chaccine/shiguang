// Single-run observation of the existing test. File workers retain the runner's default settings.
import { registerHooks } from "node:module";
import { installRegistry } from "../perf-investigation/scratch/lifecycle.mjs";

const dir = process.env.HOME_SUMMARY_CAPTURE;
if (installRegistry(dir)) {
  const { performance, PerformanceObserver } = await import("node:perf_hooks");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { isDeepStrictEqual } = await import("node:util");
  const { context, counters } = await import("../perf-investigation/scratch/probes.mjs");
  const { hash, inputFacts } = await import("../perf-investigation/scratch/work.mjs");

  const points = [], intervals = {}, gc = [], contexts = {}, sourceHashes = {};
  const matched = [], issues = [], deliveries = [];
  let group, bytes, storage, writes, domain, adapter, passedLastAssertions = false;
  let deliveryTurnAfterTargetMs = null;

  function noteEntries(entries) {
    for (const e of entries) gc.push({ startMs: e.startTime, durationMs: e.duration, kind: e.detail.kind, flags: e.detail.flags });
  }
  const collector = new PerformanceObserver(list => {
    const lo = performance.now();
    noteEntries(list.getEntries());
    deliveries.push([lo, performance.now()]);
  });
  collector.observe({ entryTypes: ["gc"] });

  function snapshot(name) {
    const point = { group, name, enterMs: performance.now() };
    points.push(point);
    point.counters = counters();
    point.leaveMs = performance.now();
  }
  function system() {
    const data = context();
    data.cpuPressure = readFileSync(join(data.cgroup, "cpu.pressure"), "utf8").trim();
    return data;
  }
  const obs = globalThis.__homeObservation = {
    begin(label) {
      group = label;
      if (group === "adapter.homeSummary") contexts.before = system();
      snapshot("begin");
    },
    phase(name) {
      if (group === "setup" || group === "adapter.homeSummary" || group === "domain.homeSummary") snapshot(name);
    },
    fixture(raw, saved, count) {
      snapshot("end");
      group = null;
      bytes = raw; storage = saved; writes = count;
    },
    end(start, elapsed) {
      snapshot("end");
      intervals[group] = { startMs: start, elapsedMs: elapsed };
      if (group === "adapter.homeSummary") {
        contexts.after = system();
        setImmediate(() => {
          noteEntries(collector.takeRecords());
          deliveryTurnAfterTargetMs = performance.now();
        });
      }
      group = null;
    },
    home(expected, actual) { domain = expected; adapter = actual; },
    matched(name) { matched.push(name); },
    complete() { passedLastAssertions = true; }
  };

  process.once("exit", code => {
    noteEntries(collector.takeRecords());
    collector.disconnect();
    let input, stored;
    try {
      input = inputFacts(bytes);
      const finalBytes = storage.getItem("u011-synthetic");
      stored = { identical: finalBytes === bytes, beforeWrites: writes, afterWrites: storage.writes, finalSha256: hash(finalBytes) };
      const prior = new URL("../perf-investigation/scratch/", import.meta.url);
      const expectedInput = JSON.parse(readFileSync(new URL("input.json", prior), "utf8"));
      const expectedHome = JSON.parse(readFileSync(new URL("run-01-P/museum.json", prior), "utf8")).home;
      if (!isDeepStrictEqual(input, expectedInput)) issues.push("fixture differs from archived fingerprint");
      if (!isDeepStrictEqual(domain, adapter) || !isDeepStrictEqual(adapter, expectedHome)) issues.push("home counts differ");
      if (!stored.identical || writes !== 1 || storage.writes !== writes) issues.push("storage changed");
    } catch (error) { issues.push(String(error)); }
    const raw = { pid: process.pid, parent: process.ppid, code, node: process.version, v8: process.versions.v8,
      timeOrigin: performance.timeOrigin, contexts, points, intervals, gc, deliveries, deliveryTurnAfterTargetMs,
      input, stored, domain, adapter, matched, passedLastAssertions, issues, sourceHashes };
    writeFileSync(join(dir, "trace.json"), JSON.stringify(raw) + "\n");
  });

  // Insert complete statements AFTER the given original lines. The hash pins the line map.
  // Every original line remains in its original order, including both clock reads and every assert.
  const files = new Map();
  function observe(file, sha, afterLine) {
    files.set(pathToFileURL(resolve(file)).href, { file, sha, afterLine });
  }
  observe("tests/unit011-museum.test.ts", "2a86299ac8bea1fe7fb38f73bf41e27f3ea1dd59a919907a6f490bc807cef8e8", {
    422: 'const obs = globalThis.__homeObservation; obs.begin("setup");',
    423: 'obs.phase("rowsBuilt");',
    427: 'obs.phase("rowsDecorated");',
    428: 'obs.fixture(before, saved, writes);',
    445: 'obs.begin("domain." + name);',
    446: 'obs.end(start, domainMs); obs.begin("adapter." + name);',
    447: 'obs.end(start, adapterMs); if (name === "homeSummary") obs.home(expected, actual);',
    449: 'obs.matched(name);',
    // Here the native clock has just started on the same line as the first page's await.
    456: 'obs.begin("adapter.photosNext." + order);',
    457: 'obs.end(start, elapsed);',
    463: 'obs.complete();'
  });
  const phase = name => 'globalThis.__homeObservation.phase("' + name + '");';
  observe("tests/support/museum.ts", "a8b74b697545836a9efec66499567c0d82d9787d2fc075d087b0c2ad2023dca0", {
    36: phase("serializedAndStored"), 38: phase("constructorReturned")
  });
  observe("src/platform/memory-adapter.ts", "6ea1c368c26de5fd61929f9b09cfec3c83807376da775d66610adffeafc7b5da", {
    129: phase("reloadEntered"), 134: phase("beforeParse"), 135: phase("afterParse"),
    173: phase("beforeSnapshots"), 188: phase("beforeTags"), 191: phase("validationDone")
  });
  observe("src/domain/museum.ts", "455bab400759211c65a33c422d726c3aea6a06de60ec964e406119fb2c322db1", {
    97: phase("summaryEntered"), 106: phase("rowsCounted")
  });
  registerHooks({ load(url, options, next) {
    const loaded = next(url, options);
    const mapped = files.get(url);
    if (!mapped) return loaded;
    const source = Buffer.from(loaded.source).toString("utf8");
    const digest = hash(source);
    sourceHashes[mapped.file] = digest;
    if (digest !== mapped.sha) throw Error("Source differs from frozen line map: " + mapped.file);
    const marked = " // home-summary-observer";
    const lines = source.split("\n");
    const transformed = lines.flatMap((line, i) => mapped.afterLine[i + 1] ? [line, mapped.afterLine[i + 1] + marked] : [line]);
    if (transformed.filter(line => !line.endsWith(marked)).join("\n") !== source) throw Error("Original source recovery failed");
    return { ...loaded, source: transformed.join("\n") };
  } });
}
