# Core checkpoint verified by orchestrator (2026-11-25 UTC+8)

Astra core sandbox reported unavailable Rust/npm dependencies. On actual box, Rust 1.90 worked; project-only npm ci restored the missing node_modules (no global installs). The following supersedes historical sandbox BLOCKED entries for these commands only:

- cargo test --locked --workspace: 241 passed; historical v3 fixture generator remains ignored.
- cargo test --locked -p shiguang_core --features fault-injection: 291 passed; same historical generator ignored.
- npm test: 219 passed.
- npm run typecheck: PASS.
- npm run build: PASS (frontend assets only, no installers).
- git diff --check: PASS.

Synthetic benchmark, 5000 records, 6250 photo uses, 16.6–16.8 MB state, ~2.4 KB body per record, 1000 keyword matches / 250 combined matches, pages of 50:
- Rust debug cold open+first 1702.485 ms; warm first 739.969–745.449 ms; later pages 776.241–793.095 ms; combined first 657.617 ms.
- Node domain first 397.682 ms; adapter cold 371.209 ms; warm first 345.303–366.586 ms; later pages 340.504–369.568 ms; combined first 320.296 ms.
- Four pages 200 unique IDs, no duplicates.
- JSON evidence: search-benchmark-rust.json, search-benchmark-node.json.

The 10 second guard is only a gross-regression test, NOT an acceptable UI latency claim. Debug Rust and synchronous preview full-state hashing may need refinement after release/UI checks; do not call this native-phone responsiveness PASS. No browser, IPC, installer or real-device checks performed.
