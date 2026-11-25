import { readFileSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism } from "node:os";

export const mono = () => Number(process.hrtime.bigint());
const read = path => readFileSync(path, "utf8").trim();
const cgroup = join("/sys/fs/cgroup", read("/proc/self/cgroup").match(/^0::(\/[^\n]*)$/m)[1]);
export function context() {
  const cpuStat = Object.fromEntries(read(join(cgroup, "cpu.stat")).split("\n")
    .map(line => line.split(" ")).map(([k, v]) => [k, Number(v)]));
  const load = read("/proc/loadavg").split(" ");
  return { atNs: mono(), availableParallelism: availableParallelism(),
    affinity: read("/proc/self/status").match(/^Cpus_allowed_list:\s*(\S+)/m)[1],
    cgroup, quotaAndPeriod: read(join(cgroup, "cpu.max")),
    effectiveCpuset: read(join(cgroup, "cpuset.cpus.effective")),
    periods: cpuStat.nr_periods, throttled: cpuStat.nr_throttled, throttledUsec: cpuStat.throttled_usec,
    load: load.slice(0, 3).map(Number), runnableAndTotal: load[3] };
}

export function counters() {
  const lo = mono();
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const [runtimeNs, waitNs, slices] = read("/proc/thread-self/schedstat").split(/\s+/).map(Number);
  return { lo, hi: mono(), cpu, thread, runtimeNs, waitNs, slices };
}

// Both functions are called from statements OUTSIDE the two original clock reads.
export function before(target) {
  target.beforeWorkNs = mono();
  target.contextBefore = context();
  target.before = counters();
  target.beforeClockNs = mono();
}
export function after(target) {
  target.afterClockNs = mono();
  target.after = counters();
  target.contextAfter = context();
  target.afterWorkNs = mono();
}
