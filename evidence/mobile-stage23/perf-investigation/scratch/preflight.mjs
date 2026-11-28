import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { arch, release, type } from "node:os";
import { hash } from "./work.mjs";
import { before, after, context, mono } from "./probes.mjs";
import { instrumentTest, instrumentProfile, testFile, profileFiles } from "./hooks.mjs";

const transforms = {};
for (const file of [testFile, ...profileFiles]) {
  const source = readFileSync(file, "utf8");
  const changed = file === testFile ? instrumentTest(source) : instrumentProfile(file, source);
  const checked = spawnSync(process.execPath, ["--input-type=module-typescript", "--check"], { input: changed, encoding: "utf8" });
  if (checked.status !== 0) throw Error(checked.stderr);
  transforms[file] = { original: hash(source), observed: hash(changed) };
}
// Empty original clock pair, no test process, fixture construction or query.
const samples = { bareUs: [], outsideSetupUs: [], outsideTeardownUs: [], nearClockSlackUs: [], counterEnvelopeSlackUs: [] };
const target = {};
for (let i = 0; i < 256; i++) {
  let start = performance.now();
  samples.bareUs.push((performance.now() - start) * 1000);
  before(target);
  start = performance.now();
  const elapsed = performance.now() - start;
  after(target);
  samples.outsideSetupUs.push((target.beforeClockNs - target.beforeWorkNs) / 1000);
  samples.outsideTeardownUs.push((target.afterWorkNs - target.afterClockNs) / 1000);
  samples.nearClockSlackUs.push((target.afterClockNs - target.beforeClockNs) / 1000 - elapsed * 1000);
  samples.counterEnvelopeSlackUs.push((target.after.hi - target.before.lo) / 1000 - elapsed * 1000);
}
const calibration = {};
for (const [name, values] of Object.entries(samples)) {
  values.sort((a, b) => a - b);
  calibration[name] = { min: values[0], median: (values[127] + values[128]) / 2, max: values.at(-1) };
}
console.log(JSON.stringify({ transforms, calibration, emptyPairs: 256, monotonicNs: mono(),
  node: process.version, v8: process.versions.v8, os: type(), kernel: release(), arch: arch(),
  cpuModel: readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)[1], context: context()
}, null, 2));
