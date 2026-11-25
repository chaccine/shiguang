"""Run the single diagnostic, recording its manifest before spawning the Node coordinator."""
import datetime
import gzip
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
PRIOR = OUT.parent / "perf-investigation/scratch"
sys.path.insert(0, str(PRIOR))
from launch import host, poll_children

stamp = lambda: datetime.datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()


def system():
    data = host()
    paths = {}
    for directory in (Path("/sys/fs/cgroup"), Path(data["cgroup"])):
        for name in ("cpu.max", "cpu.stat", "cpu.pressure", "cpuset.cpus.effective", "memory.current",
                     "memory.max", "memory.pressure", "memory.events"):
            file = directory / name
            paths[str(file)] = file.read_text().strip() if file.is_file() else None
    for name in ("cpu", "memory", "io"):
        file = Path("/proc/pressure") / name
        paths[str(file)] = file.read_text().strip() if file.is_file() else None
    info = Path("/proc/cpuinfo").read_text().splitlines()
    data.update(at=stamp(), kernel=platform.release(), machine=platform.machine(), logicalCpus=os.cpu_count(),
                affinity=sorted(os.sched_getaffinity(0)), cpuModel=next(x.split(":", 1)[1].strip() for x in info if x.startswith("model name")),
                memory=[s for s in Path("/proc/meminfo").read_text().splitlines() if s.startswith(("MemTotal:", "MemAvailable:"))],
                counters=paths)
    return data


def write_ledger():
    temp = OUT / ".ledger.tmp"
    temp.write_text(json.dumps(ledger, indent=2) + "\n")
    temp.replace(ledger_path)


ledger_path = OUT / "ledger.json"
# A used or interrupted slot cannot be replayed.
with ledger_path.open("x") as f:
    f.write('{"state":"reserving diagnostic slot","originalFailures":1}\n')
files = sys.argv[1:]
args = ["node", "--import", str(OUT / "observe.mjs"), "--test", *files]
rec = dict(slot=1, kind="observation", command=args, cwd=str(ROOT), started=stamp(), status="reserved",
           coordinatorTimeoutSeconds=90, sampleSleepMs=7, before=system())
original = json.loads((OUT / "original-evidence.json").read_text())
original_npm = next(r for r in original["independent"] if r["suite"] == "npm")
ledger = dict(zone="Asia/Shanghai", head=json.loads((OUT / "integrity.json").read_text())["before"]["head"],
              limitNewLaunches=2, cumulativeStop=3, original=dict(original_npm, failureNumber=1),
              newLaunches=1, cumulativeFailures=1, helperIssues=[], launches=[rec],
              slot2=dict(kind="plain npm test after a justified fix", status="RESERVED"))
dependencies = [OUT / n for n in ("PLAN.md", "observe.mjs", "capture.py")] + [
    PRIOR / n for n in ("lifecycle.mjs", "probes.mjs", "work.mjs", "input.json", "run-01-P/museum.json", "launch.py")]
rec["sourceSha256"] = {str(p.relative_to(ROOT)): sha(p) for p in dependencies}
rec["nodeOptionsNonempty"] = bool(os.getenv("NODE_OPTIONS"))
rec["parentHadNodeTestContext"] = bool(os.getenv("NODE_TEST_CONTEXT"))
write_ledger()
raw = OUT / ".capture"
raw.mkdir()
samples = []
rec["timedOut"] = False
with (raw / "console.log").open("xb") as log:
    try:
        if sorted(files) != sorted(str(f.relative_to(ROOT)) for f in (ROOT / "tests").glob("*.test.ts")) or len(files) != 28:
            raise RuntimeError("Test file census differs from the default shell glob")
        start = time.monotonic_ns()
        rec.update(spawnAt=stamp(), startNs=start, status="launching")
        write_ledger()
        process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   env=dict(os.environ, HOME_SUMMARY_CAPTURE=str(raw)), start_new_session=True)
        rec.update(pid=process.pid, status="running")
        write_ledger()
        children = Path("/proc", str(process.pid), "task", str(process.pid), "children")
        while process.poll() is None:
            if time.monotonic_ns() - start > 90_000_000_000:
                rec["timedOut"] = True
                os.killpg(process.pid, signal.SIGKILL)  # This run's private process group only.
                break
            samples.append(poll_children(process, children))
            time.sleep(0.007)
        rec["exit"] = process.wait()
    except (OSError, RuntimeError) as error:
        log.write((str(error) + "\n").encode())
        ledger["helperIssues"].append(str(error))
        rec["exit"] = 1
rec.update(endNs=time.monotonic_ns(), ended=stamp(), status="exited")
if rec["exit"] != 0 or rec["timedOut"]:
    ledger["cumulativeFailures"] += 1
write_ledger()
rec["after"] = system()
rec["polls"] = len(samples)
rec["samplerThreadCpuMs"] = sum(s["monitorCpuNs"] for s in samples) / 1e6
(raw / "samples.json").write_text(json.dumps(samples, separators=(",", ":")) + "\n")
trace = raw / "trace.json"
ledger["helperIssues"].extend(json.loads(trace.read_text())["issues"] if trace.exists() else ["Missing museum worker trace"])
rec["raw"] = {}
for path in sorted(raw.iterdir()):
    data = path.read_bytes()
    packed = OUT / (path.name + ".gz")
    with packed.open("xb") as archive:
        archive.write(gzip.compress(data, mtime=0))
    rec["raw"][packed.name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), gzipSha256=sha(packed))
    path.unlink()
raw.rmdir()
write_ledger()
print(json.dumps(dict(exit=rec["exit"], cumulativeFailures=ledger["cumulativeFailures"], helperIssues=ledger["helperIssues"],
                      raw=list(rec["raw"]))))
sys.exit(0 if rec["exit"] == 0 else 1)
