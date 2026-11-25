"""Offline reconciliation with the actual file-level reporter and two independent PID sources."""
import collections
import gzip
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inspect_run import case_names, read_json
from launch import D, FILES, TFILE


def audit(rec):
    folder = D / rec["run"]
    samples = json.loads(gzip.decompress((folder / "worker-samples.json.gz").read_bytes()))
    raw = (folder / "console.txt").read_text()
    m = read_json(folder / "museum.json")
    events = [json.loads(line) for line in (folder / "workers.jsonl").read_text().splitlines()]
    files = [TFILE] if rec["kind"] == "I" else FILES
    workers = {e["pid"]: e for e in events}
    counts = read_json(D / "reconcile/cases.json")["fileCounts"]
    issues = list(m["failures"])
    def require(ok, msg):
        if not ok:
            issues.append(msg)
    totals = {k: int(v) for k, v in re.findall(r"^[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$", raw, re.M)}
    names = case_names(raw)
    # A wrapper pass means Node observed exit 0 and no terminating signal. A child that
    # failed or was skipped cannot be counted as a file pass. Keep units in the record.
    file_report = collections.Counter(names) == collections.Counter(files)
    expected = len(files) if file_report else sum(counts[f] for f in files)
    if not file_report:
        previous = case_names(Path("/workspace/sg-stage23/verification/t4-core/npm.log").read_text())
        require(collections.Counter(names) == collections.Counter(
            n for n in previous if len(files) > 1 or n.startswith("U011 ")), "Unrecognized case/file report")
    require(totals.get("tests") == expected and totals.get("pass", -1) + totals.get("fail", -1) == expected
            and all(totals.get(k) == 0 for k in ("cancelled", "skipped", "todo")), "Missing results or skip/cancel/todo")
    require(len(workers) == len(events) == len(files) and sorted(e["file"] for e in events) == sorted(files),
            "Missing or duplicate worker/file")
    seen = collections.defaultdict(list)
    for i, poll in enumerate(samples):
        for pid, runtime, wait, slices in poll["threads"]:
            seen[pid].append((i, runtime))
    require(set(seen) == set(workers) and all(e["parent"] == rec["pid"] for e in events),
            "Kernel-owned children and self-reported file PIDs differ")
    for e in events:
        require(rec["startNs"] <= e["startNs"] <= e["endNs"] <= rec["endNs"], "Worker clock bounds")
    times = m["times"]
    reached = {k: v for k, v in times.items() if v is not None}
    breaches = {k: v for k, v in reached.items() if v >= 150}
    failed_files = [e["file"] for e in events if e["code"] != 0]
    equal = m["equal"]
    require(all(ok or "adapter." + n not in reached for n, ok in equal.items()), "Original pair equality failed")
    require(m["input"] == read_json(D / "input.json") and m["stored"]["identical"] and
            m["stored"]["beforeWrites"] == m["stored"]["afterWrites"] == 1, "Input or storage mismatch")
    if m["output"]:
        first = read_json(D / "run-01-P/museum.json")["output"]
        require(m["output"] == first and m["output"]["eligibleIdSetSha256"] == m["input"]["eligibleIdSetSha256"],
                "Page bytes, counts or eligible IDs differ")
    if rec["exit"] == 0:
        require(totals["fail"] == 0 and not failed_files and not breaches and m["fullAssertions"] and
                len(reached) == 18 and all(equal.values()) and all(m["continued"].values()), "Success/coverage disagreement")
    else:
        # A file-only failure can be localized without continuing past an assertion:
        # check that the final measured group has a real breach and earlier equality
        # succeeded. Leave any unrelated failures unclassified and stop.
        last = list(reached)[-1]
        group = last.split(".", 1)[1]
        same_group = {k for k in breaches if k.split(".", 1)[1] == group}
        require(not rec["timeout"] and totals.get("fail") == 1 and failed_files == [TFILE]
                and same_group and set(breaches) == same_group and not m["fullAssertions"],
                "Unclassified failure or incorrect work")
    result = dict(totals=totals, reportUnit="files" if file_report else "cases",
                  sourceCaseCount=sum(counts[f] for f in files), workerCount=len(workers),
                  workerExitCodes=dict(collections.Counter(e["code"] for e in events)),
                  reached=len(reached), unreached=[k for k in times if k not in reached], breaches=breaches,
                  observedPage=m["output"], target=None, issues=issues)
    elapsed = times["adapter.reunionPage"]
    if elapsed is None:
        return result
    t = m["target"]
    pre, post = t["before"], t["after"]
    a, b = t["beforeClockNs"], t["afterClockNs"]
    latest_start, earliest_end = b - elapsed * 1e6, a + elapsed * 1e6
    own = workers[m["pid"]]
    require(own["file"] == TFILE and own["startNs"] <= pre["lo"] <= pre["hi"] <= a <= b <= post["lo"] <= post["hi"]
            <= own["endNs"] and a - 1000 <= latest_start < earliest_end, "Original timer/counter bracket")
    inside = [i for i, p in enumerate(samples) if p["lo"] >= latest_start and p["hi"] <= earliest_end]
    confirmed, possible, cpu_active = [], [], {}
    for pid, e in workers.items():
        if pid == m["pid"]:
            continue
        observations = seen[pid]
        first, last = observations[0][0], observations[-1][0]
        # A worker can have been born/died between polls. Self-report bounds provide
        # a guaranteed live interval; adjacent kernel polls bound startup and teardown.
        earliest = samples[first - 1]["lo"] if first else rec["startNs"]
        latest = samples[last + 1]["hi"] if last + 1 < len(samples) else rec["endNs"]
        values = [v for i, v in observations if i in inside]
        if values or (e["startNs"] < earliest_end and e["endNs"] > latest_start):
            confirmed.append(e["file"])
        if earliest < b and latest > a:
            possible.append(e["file"])
        if len(values) > 1 and values[-1] > values[0]:
            cpu_active[e["file"]] = (values[-1] - values[0]) / 1e6
    def cpu(kind):
        return sum(post[kind][k] - pre[kind][k] for k in ("user", "system")) / 1000
    runtime = (post["runtimeNs"] - pre["runtimeNs"]) / 1e6
    wait = (post["waitNs"] - pre["waitNs"]) / 1e6
    require(runtime > 0 and wait >= 0 and cpu("thread") > 0 and cpu("cpu") > 0, "Thread counters unusable")
    ctx0, ctx1 = t["contextBefore"], t["contextAfter"]
    require(ctx0["affinity"] == ctx1["affinity"] and ctx0["effectiveCpuset"] == ctx1["effectiveCpuset"], "Affinity changed")
    result["target"] = dict(wallMs=elapsed, procMs=cpu("cpu"), threadMs=cpu("thread"), schedCpuMs=runtime,
        runnableWaitMs=wait, slices=post["slices"] - pre["slices"],
        outerClockSlackMs=(b - a) / 1e6 - elapsed, counterEnvelopeSlackMs=(post["hi"] - pre["lo"]) / 1e6 - elapsed,
        externalSetupMs=(a - t["beforeWorkNs"]) / 1e6, externalTeardownMs=(t["afterWorkNs"] - b) / 1e6,
        cgroupDelta={k: ctx1[k] - ctx0[k] for k in ("periods", "throttled", "throttledUsec")},
        livePeers=sorted(confirmed), possiblePeers=sorted(possible), peerCpuObservedMs=cpu_active,
        targetPolls=len(inside))
    if rec["kind"] == "profile":
        require(m["helper"] == dict(parse=1, rowValidation=5000, snapshotSlots=10000, snapshotValidation=5000,
                    photoValidation=5000, tagRowValidation=5000, eligibility=5000, projection=48) and
                [p["name"] for p in m["phases"]] == ["storageRead", "parse", "validation", "projection", "promiseReturn"],
                "Attribution boundaries or work counts missing")
    return result


if __name__ == "__main__":
    record = read_json(D / "registry.json")["launches"][0]
    print(json.dumps(audit(record), indent=2))
