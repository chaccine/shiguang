# U011 reunionPage adapter acceptance change

On 2026-11-25 at 23:51 Asia/Shanghai (t87u/t88u), Cine approved a `< 200 ms`
limit solely for `adapter.reunionPage` in the 5,000-record stress case. Every
domain query and every other adapter path, including both photo-next sort
orders, has a `< 150 ms` limit.

The historical default npm run measured 172.558 ms for `adapter.reunionPage`
and failed the old `< 150 ms` limit. [Original blocked gate](BLOCKED_TEST_GATE.md)

The bounded investigation concluded **INCONCLUSIVE** and is archived unchanged.
[Investigation report](perf-investigation/REPORT.md)

## First independent regression under the new contract

2026-11-25 23:54–23:56 Asia/Shanghai: exactly one default `npm test`, uninstrumented and without affinity/concurrency changes, passed285/285; adapter.reunionPage46.701ms. This is one observation under the new200ms contract, not a fix or reversal of the historical150ms failure.

Rust1.90 workspace254 passed/1 historical generator ignored; fault-injection304 passed/1 ignored; typecheck/build passed. Counts include the protected, pending native oracle block, which is staged separately. Initial Rust commands hit the system Cargo proxy mismatch and ran no tests; both exit101 logs retained. Corrected PATH used the already installed rustup proxy and executed each Rust suite once. No npm rerun. [All commands/exits and compressed exact logs](acceptance-200/manifest.json). CI and native-device verification are separate; no new native-device PASS.
