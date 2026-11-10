import { test } from "node:test";
import assert from "node:assert/strict";
import { gateWithRetry } from "../src/domain/startup.ts";
import type { StoreStatus } from "../src/domain/types.ts";

const noSleep = async () => {};

test("startup gate retries 'state not managed' and STORE_STARTING until ready", async () => {
  const seq: Array<() => Promise<StoreStatus>> = [
    () => Promise.reject("state not managed for field `state` on command `store_status`. You must call `.manage()` before using this command"),
    () => Promise.resolve({ ok: false, code: "STORE_STARTING", message: "还在打开" }),
    () => Promise.resolve({ ok: true }),
  ];
  let i = 0;
  const out = await gateWithRetry(() => seq[i++]!(), noSleep);
  assert.deepEqual(out, { ok: true, attempts: 3 });
});

test("startup gate stops immediately on a real error (STORE_LOCKED)", async () => {
  let calls = 0;
  const out = await gateWithRetry(async () => { calls += 1; return { ok: false, code: "STORE_LOCKED", message: "x" }; }, noSleep);
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
  if (!out.ok) assert.equal(out.code, "STORE_LOCKED");
});

test("startup gate gives up after maxAttempts with the transient code", async () => {
  const out = await gateWithRetry(async () => ({ ok: false, code: "STORE_STARTING", message: "x" }), noSleep, { maxAttempts: 4 });
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 4);
});
