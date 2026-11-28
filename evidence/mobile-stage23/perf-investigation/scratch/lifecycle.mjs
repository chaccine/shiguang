import { appendFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tracingChannel } from "node:diagnostics_channel";

const now = () => Number(process.hrtime.bigint());
export function installRegistry(dir) {
  if (!process.env.NODE_TEST_CONTEXT) {
    const workers = [], starts = new WeakMap();
    const trace = tracingChannel("child_process.spawn");
    trace.start.subscribe(({ process: child }) => starts.set(child, now()));
    trace.end.subscribe(({ process: child }) => {
      const file = relative(process.cwd(), resolve(child.spawnargs.at(-1)));
      if (!/^tests\/[^/]+\.test\.ts$/.test(file)) return;
      const row = { file, pid: child.pid, spawnEarliestNs: starts.get(child), spawnReturnedNs: now() };
      workers.push(row);
      child.once("exit", (code, signal) => Object.assign(row, { exitReportedNs: now(), code, signal }));
    });
    process.once("exit", () => writeFileSync(join(dir, "parent.json"), JSON.stringify(workers) + "\n"));
    return false;
  }
  const file = relative(process.cwd(), resolve(process.argv[1]));
  const startNs = now();
  process.once("exit", code => {
    const endNs = now();
    appendFileSync(join(dir, "workers.jsonl"), JSON.stringify({ file, pid: process.pid, parent: process.ppid, startNs, endNs, code }) + "\n");
  });
  return file === "tests/unit011-museum.test.ts";
}
