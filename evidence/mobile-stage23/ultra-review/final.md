**The cause of the original 313.050 ms homeSummary timeout remains INCONCLUSIVE.** The default 150 ms gate remains **BLOCKED**. The later 132.048 ms observation spent 112.267 ms in JSON parsing. Same-path failed launches remain **1/3**.

**One migration defect was confirmed by source review.** If the final directory sync fails and the candidate cannot rename the receipt back before interruption, recovery can accept the unconfirmed install and release the writer fence. This affects the test-only candidate. The production writer remains outer 1 / schema 5.

**Two possible risks remain.** An interrupted first backup copy can block migration retries. The first summary also repeats a full parse of identical validated data. One-shot snapshot reuse, guarded by a fresh storage read and exact string equality, needs Cine confirmation and measurement.

The recommended next step is a paired recovery test covering interruption immediately before and after commit confirmation. **NOT_RUN** this round includes those fault cases, npm/cargo regressions, profiling, optimization trials, and schema 6 activation.

Final byte lengths and SHA-256 hashes matched for **9/9 candidate files** and **10/10 oracle originals**. [Full review](/workspace/sg-stage23/ultra-review/REVIEW.md) · [Machine-readable findings](/workspace/sg-stage23/ultra-review/FINDINGS.json)