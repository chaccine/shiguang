"""Single-use bounded runner. All experiment outputs live next to this script."""
import datetime
import gzip
import json
import os
import signal
import subprocess
import time
from pathlib import Path

from inspect_run import assess, read_json
from integrity import D, ROOT, check, sha

ORDER = ["P", "I", "I", "P", "P", "I", "I", "P", "P", "I"]
TFILE = "tests/unit011-museum.test.ts"
FILES = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("*.test.ts"))
assert len(FILES) == 28
clock = time.monotonic_ns
stamp = lambda: datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")


def save(path, content):
    path.write_text(json.dumps(content, indent=2, ensure_ascii=False) + "\n")


def host():
    base = Path("/sys/fs/cgroup") / Path(Path("/proc/self/cgroup").read_text().strip().split("::")[1]).relative_to("/")
    stat = dict(line.split() for line in (base / "cpu.stat").read_text().splitlines())
    load = Path("/proc/loadavg").read_text().split()
    return dict(atNs=clock(), load=load[:3], runnableAndTotal=load[3], cgroup=str(base),
                effectiveCpuset=(base / "cpuset.cpus.effective").read_text().strip(),
                quotaPeriod=(base / "cpu.max").read_text().strip(),
                cpuStat={k: int(stat[k]) for k in ("nr_periods", "nr_throttled", "throttled_usec")})


def poll_children(proc, path):
    lo = clock()
    cpu_start = time.thread_time_ns()
    threads = []
    try:
        pids = path.read_text().split()
    except (ProcessLookupError, FileNotFoundError):
        pids = []
    for pid in pids:
        # Direct children of this runner only. Cross-check against parent and child
        # registries; do not inspect peer arguments, environments, or other processes.
        try:
            reads = Path("/proc", pid, "task", pid, "schedstat").read_text().split()
        except (ProcessLookupError, FileNotFoundError):
            continue
        if len(reads) == 3:
            threads.append([int(pid), *map(int, reads)])
    return dict(lo=lo, hi=clock(), threads=threads, monitorCpuNs=time.thread_time_ns() - cpu_start)


def main():
    ledger_file = D / "registry.json"
    if ledger_file.exists():
        raise SystemExit("Existing launch registry: never replay observations")
    sources = read_json(D / "integrity-before.json")
    assert check() == sources
    harness_files = sorted([*D.glob("*.mjs"), *D.glob("*.py"), D / "input.json", D / "preflight.json",
                            D.parent / "HYPOTHESIS_MILESTONE.md"])
    frozen = {str(p.relative_to(D.parent)): sha(p) for p in harness_files}
    ledger = dict(order=ORDER, limitSeconds=2700, timeoutSeconds=90, failedAttemptCap=3,
                  failedAttempts=0, diagnosticBreaches=0, failedPlainValidations=0, launches=[],
                  harnessSha256=frozen, stop=None)
    first = None
    page_hash = None
    def guard():
        assert check() == sources, "Input provenance changed"
        assert all(sha(D.parent / k) == v for k, v in frozen.items()), "Harness drift"
    def one(kind, seq):
        nonlocal first, page_hash
        guard()
        if first is not None and clock() >= first + 2700_000_000_000:
            ledger["stop"] = "45-minute limit before next launch"
            return
        run = D / ("run-%02d-%s" % (seq, kind))
        run.mkdir()
        files = [TFILE] if kind == "I" else FILES
        args = ["node", "--import", str(D / ("profile.mjs" if kind == "profile" else "observe.mjs")),
                "--test", *files]
        rec = dict(run=run.name, kind=kind, pair=(seq + 1) // 2 if kind != "profile" else None,
                   args=args, before=host(), at=stamp(), status="starting")
        ledger["launches"].append(rec)
        save(ledger_file, ledger)
        samples = []
        timed_out = False
        with (run / "console.txt").open("xb") as log:
            start_ns = clock()
            if first is None:
                first = start_ns
                ledger["firstLaunchNs"] = first
            deadline = min(first + 2700_000_000_000, start_ns + 90_000_000_000)
            proc = subprocess.Popen(args, cwd=ROOT, env={**os.environ, "MUSEUM_PERF_RUN": str(run)},
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            rec.update(pid=proc.pid, startNs=start_ns, status="running")
            save(ledger_file, ledger)
            child_path = Path("/proc", str(proc.pid), "task", str(proc.pid), "children")
            while proc.poll() is None:
                if clock() >= deadline:
                    timed_out = True
                    os.killpg(proc.pid, signal.SIGKILL)  # Only this experiment's private group.
                    break
                samples.append(poll_children(proc, child_path))
                time.sleep(0.007)
            code = proc.wait()
        end_ns = clock()
        rec.update(after=host(), endNs=end_ns, end=stamp(), exit=code, timeout=timed_out, status="exited",
                   seconds=(end_ns - start_ns) / 1e9)
        if code != 0 or timed_out:
            ledger["failedAttempts"] += 1
        save(ledger_file, ledger)
        with gzip.open(run / "worker-samples.json.gz", "wt") as f:
            json.dump(samples, f, separators=(",", ":"))
        rec.update(monitorPolls=len(samples), monitorCpuMs=sum(r["monitorCpuNs"] for r in samples) / 1e6,
                   samplesSha256=sha(run / "worker-samples.json.gz"), consoleSha256=sha(run / "console.txt"))
        if ledger["failedAttempts"] >= 3:
            ledger["stop"] = "Three new failed attempts"
        try:
            guard()
            outcome = assess(run, samples, files, proc.pid, code, timed_out, page_hash, kind == "profile")
            save(run / "assessment.json", outcome)
            rec.update(assessment=run.name + "/assessment.json", breaches=outcome["breaches"],
                       totals=outcome["totals"], issues=outcome["fidelityOrCorrectness"])
            if kind != "profile":
                ledger["diagnosticBreaches"] += len(outcome["breaches"])
            if rec["issues"]:
                ledger["stop"] = (ledger["stop"] + "; " if ledger["stop"] else "") + "Fidelity/correctness stop: " + "; ".join(rec["issues"])
            if outcome.get("pageSha256"):
                page_hash = outcome["pageSha256"]
        except Exception as error:
            ledger["stop"] = (ledger["stop"] + "; " if ledger["stop"] else "") + "Integrity/measurement stop: " + repr(error)
        save(ledger_file, ledger)
        print(run.name, "exit", code, "breaches", rec.get("breaches"), "failed attempts", ledger["failedAttempts"],
              "stop", ledger["stop"], flush=True)
    for seq, kind in enumerate(ORDER, start=1):
        one(kind, seq)
        if ledger["stop"]:
            break
    if not ledger["stop"] and any(
        "adapter.reunionPage" in r["breaches"] for r in ledger["launches"] if r["kind"] == "P"
    ):
        one("profile", 11)
    if ledger["stop"] is None:
        ledger["stop"] = "Scheduled series complete"
    ledger["finished"] = stamp()
    ledger["elapsedSecondsFromFirstLaunch"] = (clock() - first) / 1e9
    save(ledger_file, ledger)


if __name__ == "__main__":
    main()
