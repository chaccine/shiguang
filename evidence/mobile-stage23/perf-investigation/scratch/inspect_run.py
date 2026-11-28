"""Reconcile the runner, original assertions, target counters and owned file workers."""
import collections
import json
import re
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text())


def case_names(raw):
    main = re.split(r"^[ℹ#] tests \d+", raw, flags=re.M)[0]
    spec = re.findall(r"^[✔✖] (.*?) \([0-9.]+ms\)$", main, re.M)
    return spec or re.findall(r"^(?:not )?ok \d+ - (.*?)(?: # .*)?$", main, re.M)


def assess(run, sample, files, runner_pid, code, timeout, previous_page, is_profile):
    problems = []
    raw = (run / "console.txt").read_text()
    raw = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    totals = {k: int(v) for k, v in re.findall(r"^[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$", raw, re.M)}
    ref = Path("/workspace/sg-stage23/verification/t4-core/npm.log")
    reference = [n for n in case_names(ref.read_text()) if len(files) != 1 or n.startswith("U011 ")]
    names = case_names(raw)
    if len(reference) != (285 if len(files) > 1 else 19) or collections.Counter(names) != collections.Counter(reference):
        problems.append("Original case census differs or unavailable")
    if totals.get("pass", 0) + totals.get("fail", 0) != len(reference) or any(totals.get(k) != 0 for k in ("skipped", "cancelled", "todo")):
        problems.append("Original case counts incomplete")
    result = dict(totals=totals, caseNamesMatched=collections.Counter(names) == collections.Counter(reference),
                  breaches={}, target=None, fidelityOrCorrectness=problems)
    target_path = run / "museum.json"
    if not target_path.exists():
        problems.append("Museum worker did not flush its evidence")
        return result
    m = read_json(target_path)
    problems.extend(m["failures"])
    times = m["times"]
    breaches = {k: v for k, v in times.items() if v is not None and v >= 150}
    result.update(breaches=breaches, reached=sum(v is not None for v in times.values()),
                  unreached=[k for k, v in times.items() if v is None],
                  pageSha256=m["output"]["pageSha256"] if m["output"] else None)
    if previous_page and result["pageSha256"] and previous_page != result["pageSha256"]:
        problems.append("Complete reunion page digest changed")
    if m["output"] is None and times["adapter.reunionPage"] is not None:
        problems.append("Target returned without passing original equality")
    if any(times["adapter." + n] is not None and not ok for n, ok in m["equal"].items()):
        problems.append("Reached pair failed original equality")
    if code == 0 and (not m["fullAssertions"] or result["unreached"] or breaches):
        problems.append("Passing exit disagrees with measured work or original assertions")
    if code != 0:
        # Unknown or non-budget failures stop the investigation. Never run past them.
        failing = re.findall(r"^[✖] (.*?) \([0-9.]+ms\)$", raw, re.M)
        if not failing:
            failing = re.findall(r"^not ok \d+ - (.*)$", raw, re.M)
        stress = "U011 5000-record domain and MemoryAdapter first-page budgets with no persisted projections"
        if timeout or set(failing) != {stress} or not breaches or totals.get("fail") != 1:
            problems.append("Non-budget, incomplete or unclassified failed launch; inspect console")
    if not (run / "parent.json").exists() or not (run / "workers.jsonl").exists():
        problems.append("Missing worker registry")
        return result
    registry = read_json(run / "parent.json")
    children = [json.loads(line) for line in (run / "workers.jsonl").read_text().splitlines()]
    if sorted(r["file"] for r in registry) != sorted(files) or sorted(r["file"] for r in children) != sorted(files):
        problems.append("Full expected file-worker census missing or duplicated")
    parent = {r["pid"]: r for r in registry}
    workers = {r["pid"]: r for r in children}
    sampled_pids = {pid for poll in sample for pid, *_ in poll["threads"]}
    if set(parent) != set(workers) or not set(workers).issubset(sampled_pids) or not sampled_pids.issubset(parent):
        problems.append("Owned worker identities do not reconcile")
    for pid, child in workers.items():
        p = parent.get(pid, {})
        if (child["parent"] != runner_pid or p.get("file") != child["file"] or
                p.get("code") != child["code"] or p.get("signal") is not None or
                not (p.get("spawnEarliestNs", float("inf")) <= child["startNs"] <= child["endNs"] <= p.get("exitReportedNs", 0))):
            problems.append("Worker birth, parent, exit or clock mismatch")
            break
    result["workerCount"] = len(workers)
    result["workerExitCodes"] = dict(collections.Counter(r.get("code") for r in registry))
    target = m["target"]
    elapsed = times["adapter.reunionPage"]
    if elapsed is None:
        return result
    if not target or not (m["pid"] in workers and workers[m["pid"]]["file"] == "tests/unit011-museum.test.ts"):
        problems.append("Target thread identity not verified")
        return result
    pre, post = target["before"], target["after"]
    a, b = target["beforeClockNs"], target["afterClockNs"]
    inner_start, inner_end = b - elapsed * 1e6, a + elapsed * 1e6
    target_worker = workers[m["pid"]]
    if (b < a or inner_start > inner_end or inner_start < a - 1000 or
            not target_worker["startNs"] <= pre["lo"] <= pre["hi"] <= a <= b <= post["lo"] <= post["hi"] <= target_worker["endNs"]):
        problems.append("Counter/clock bracketing did not reconcile")
    def cpu(kind):
        return sum(post[kind][k] - pre[kind][k] for k in ("user", "system")) / 1000
    runtime = (post["runtimeNs"] - pre["runtimeNs"]) / 1e6
    wait = (post["waitNs"] - pre["waitNs"]) / 1e6
    if runtime <= 0 or wait < 0 or cpu("thread") <= 0 or cpu("cpu") <= 0:
        problems.append("Main-thread and process counters unavailable or backwards")
    # Worker self-reports prove lifetime overlap. A CPU lower bound requires two direct
    # kernel readings lying wholly inside the guaranteed subset of the original interval.
    live, possible, cpu_active = [], [], {}
    for pid, w in workers.items():
        if pid == m["pid"]:
            continue
        if w["startNs"] < inner_end and w["endNs"] > inner_start:
            live.append(w["file"])
        p = parent[pid]
        if p["spawnEarliestNs"] < b and p["exitReportedNs"] > a:
            possible.append(w["file"])
        rs = [runtime_ns for poll in sample if poll["lo"] >= inner_start and poll["hi"] <= inner_end
              for worker_pid, runtime_ns, _, _ in poll["threads"] if worker_pid == pid]
        if len(rs) >= 2 and rs[-1] > rs[0]:
            cpu_active[w["file"]] = (rs[-1] - rs[0]) / 1e6
    ctx_pre, ctx_post = target["contextBefore"], target["contextAfter"]
    result["target"] = dict(wallMs=elapsed, procMs=cpu("cpu"), threadMs=cpu("thread"), schedCpuMs=runtime,
        runnableWaitMs=wait, slices=post["slices"] - pre["slices"],
        outerClockSlackMs=(b - a) / 1e6 - elapsed, counterEnvelopeSlackMs=(post["hi"] - pre["lo"]) / 1e6 - elapsed,
        externalSetupMs=(a - target["beforeWorkNs"]) / 1e6, externalTeardownMs=(target["afterWorkNs"] - b) / 1e6,
        cgroupDelta={k: ctx_post[k] - ctx_pre[k] for k in ("periods", "throttled", "throttledUsec")},
        livePeers=sorted(live), possiblePeers=sorted(possible), peerCpuObservedMs=cpu_active,
        targetPolls=sum(poll["lo"] >= inner_start and poll["hi"] <= inner_end for poll in sample))
    if is_profile:
        expected = dict(parse=1, rowValidation=5000, snapshotSlots=10000, snapshotValidation=5000,
                        photoValidation=5000, tagRowValidation=5000, eligibility=5000, projection=48)
        if m.get("helper") != expected or [p["name"] for p in m.get("phases", [])] != [
                "storageRead", "parse", "validation", "projection", "promiseReturn"]:
            problems.append("Separate phase attribution/helper work incomplete")
    return result
