"""Verify the frozen inputs using raw worktree bytes, without updating the index."""
import hashlib
import json
import subprocess
from pathlib import Path

D = Path(__file__).resolve().parent
ROOT = D.parents[3]
PROTECTED = Path("/workspace/sg-stage23/investigation")
SCOPE = ["src", "tests", "package.json", "package-lock.json", "core/tests/fixtures/v3"]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check():
    manifest = json.loads((PROTECTED / "ORACLE_PREIMAGE.json").read_text())
    saved = json.loads((D.parent / "SOURCE_FINGERPRINTS.json").read_text())
    head = git("rev-parse", "HEAD").decode().strip()
    branch = git("branch", "--show-current").decode().strip()
    assert head == saved["current"] == manifest["head"] and branch == "feat/mobile-stage23"
    plan_hash = sha(D.parent / "PREREGISTERED_PLAN.md")
    assert plan_hash == saved["preregisteredPlanSha256"]
    source_hash = sha(D.parent / "SOURCE_FINGERPRINTS.json")
    assert source_hash == "bb19568fa09216311d66c46e5e9cbb2ae51d3246e8ca8d891bde569eeee5f4b3"
    for name, fingerprint in saved["fingerprints"].items():
        for revision in ("current", "baseline"):
            actual = git("rev-parse", saved[revision] + ":" + name).decode().strip()
            assert actual == fingerprint[revision] == fingerprint["baseline"], name
    manifest_hash = sha(PROTECTED / "ORACLE_PREIMAGE.json")
    assert len(manifest["files"]) == 10
    for entry in manifest["files"]:
        for base in (ROOT, PROTECTED / "oracle-preserved"):
            path = base / entry["file"]
            assert path.stat().st_size == entry["bytes"] and sha(path) == entry["sha256"], str(path)
    entries = git("ls-tree", "-rz", saved["baseline"], "--", *SCOPE)
    assert entries == git("ls-tree", "-rz", head, "--", *SCOPE)
    counts = dict.fromkeys(SCOPE, 0)
    for entry in entries.rstrip(b"\0").split(b"\0"):
        meta, file = entry.split(b"\t")
        name = file.decode()
        data = (ROOT / name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        assert blob == meta.split()[2].decode(), name
        scope = next(k for k in SCOPE if name == k or name.startswith(k + "/"))
        counts[scope] += 1
    assert not git("ls-files", "--others", "--exclude-standard", "--", *SCOPE)
    assert counts["core/tests/fixtures/v3"] == 11
    return dict(head=head, branch=branch, baseline=saved["baseline"], fingerprints=saved["fingerprints"],
                rawFiles=counts, planSha256=plan_hash, fingerprintsFileSha256=source_hash,
                oracleManifestSha256=manifest_hash, oracleWorktreeAndCopies=10)


if __name__ == "__main__":
    print(json.dumps(check(), indent=2))
