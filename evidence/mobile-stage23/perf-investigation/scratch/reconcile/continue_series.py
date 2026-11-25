"""Consume only unused slots, with identical Node/worker/sampling code and original deadline."""
import gzip
import json
import os
import signal
import subprocess
import time
from pathlib import Path

from audit import audit  # Also adds the original driver directory to sys.path.
from launch import D, FILES, ROOT, TFILE, check, clock, host, poll_children, read_json, save, sha, stamp

ledger_path = D / "registry.json"
ledger = read_json(ledger_path)
first = ledger["firstLaunchNs"]
old = ledger["launches"]
assert len(old) == 1 and old[0]["run"] == "run-01-P" and old[0]["exit"] == 0
assert ledger["failedAttempts"] == 0 and ledger["diagnosticBreaches"] == 0
assert set(old[0]["issues"]) == {"Original case census differs or unavailable", "Original case counts incomplete", "Missing worker registry"}
recovered = audit(old[0])
assert not recovered["issues"] and recovered["reached"] == 18
with (D / "reconcile/initial-registry.json").open("x") as out:
    out.write(ledger_path.read_text())
ledger["firstAssessmentPause"] = dict(reason=ledger["stop"], time=ledger["finished"],
    original="reconcile/initial-registry.json", resolution="run-01-P/reconciled.json",
    resumedAt=stamp(), elapsedSecondsSinceFirst=(clock() - first) / 1e9)
ledger["stop"] = None
old[0]["reconciled"] = old[0]["run"] + "/reconciled.json"
ledger["analysisSha256"] = {str(p.relative_to(D.parent)): sha(p) for p in (D / "reconcile").glob("*") if p.is_file()}


def verify():
    assert check() == read_json(D / "integrity-before.json"), "Provenance drift"
    for key in ("harnessSha256", "analysisSha256"):
        assert all(sha(D.parent / name) == val for name, val in ledger[key].items()), key + " drift"


def launch(seq, kind):
    verify()
    assert seq == len(ledger["launches"]) + 1 and ledger["failedAttempts"] < 3 and not ledger["stop"]
    if clock() >= first + 2700_000_000_000:
        ledger["stop"] = "45-minute limit before next launch"
        return
    run = D / ("run-%02d-%s" % (seq, kind))
    run.mkdir()  # O_EXCL equivalent for a new run: no replacement or overwrite.
    files = [TFILE] if kind == "I" else FILES
    args = ["node", "--import", str(D / ("profile.mjs" if kind == "profile" else "observe.mjs")), "--test", *files]
    rec = dict(run=run.name, kind=kind, pair=(seq + 1) // 2 if kind != "profile" else None,
               args=args, before=host(), at=stamp(), status="starting")
    ledger["launches"].append(rec)
    save(ledger_path, ledger)
    samples = []
    timed_out = False
    with (run / "console.txt").open("xb") as log:
        start_ns = clock()
        deadline = min(first + 2700_000_000_000, start_ns + 90_000_000_000)
        proc = subprocess.Popen(args, cwd=ROOT, env={**os.environ, "MUSEUM_PERF_RUN": str(run)},
                                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        rec.update(pid=proc.pid, startNs=start_ns, status="running")
        save(ledger_path, ledger)
        child_path = Path("/proc", str(proc.pid), "task", str(proc.pid), "children")
        while proc.poll() is None:
            if clock() >= deadline:
                timed_out = True
                os.killpg(proc.pid, signal.SIGKILL)
                break
            samples.append(poll_children(proc, child_path))
            time.sleep(0.007)
        code = proc.wait()
    end = clock()
    rec.update(after=host(), endNs=end, end=stamp(), exit=code, timeout=timed_out, status="exited",
               seconds=(end - start_ns) / 1e9)
    if code != 0 or timed_out:
        ledger["failedAttempts"] += 1
    if ledger["failedAttempts"] == 3:
        ledger["stop"] = "Three new failed attempts"
    save(ledger_path, ledger)
    with gzip.open(run / "worker-samples.json.gz", "wt") as f:
        json.dump(samples, f, separators=(",", ":"))
    rec.update(monitorPolls=len(samples), monitorCpuMs=sum(r["monitorCpuNs"] for r in samples) / 1e6,
               samplesSha256=sha(run / "worker-samples.json.gz"), consoleSha256=sha(run / "console.txt"))
    try:
        verify()
        outcome = audit(rec)
        save(run / "reconciled.json", outcome)
        rec.update(reconciled=run.name + "/reconciled.json", totals=outcome["totals"], issues=outcome["issues"],
                   breaches=outcome["breaches"])
        if kind != "profile":
            ledger["diagnosticBreaches"] += len(outcome["breaches"])
        if outcome["issues"]:
            raise ValueError(outcome["issues"])
    except Exception as exc:
        ledger["stop"] = (ledger["stop"] + "; " if ledger["stop"] else "") + "Integrity/measurement stop: " + repr(exc)
    save(ledger_path, ledger)
    print(rec["run"], "exit", code, "breaches", rec.get("breaches"), "failed attempts", ledger["failedAttempts"],
          "stop", ledger["stop"], flush=True)


for position, condition in enumerate(ledger["order"][1:], 2):
    launch(position, condition)
    if ledger["stop"]:
        break
if not ledger["stop"] and any("adapter.reunionPage" in r["breaches"] for r in ledger["launches"] if r["kind"] == "P"):
    launch(11, "profile")
if ledger["stop"] is None:
    ledger["stop"] = "Scheduled series complete"
ledger["finished"] = stamp()
ledger["elapsedSecondsFromFirstLaunch"] = (clock() - first) / 1e9
save(ledger_path, ledger)
