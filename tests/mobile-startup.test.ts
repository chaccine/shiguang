import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AppSettings, MediaReport, SettingsResult, StoreStatus } from "../src/domain/types.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";
import { SEARCH_DEMO_STORAGE_KEY } from "../src/ui/search-demo.ts";
import { bootDom, until } from "./support/boot-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const disabled: AppSettings = { theme: "light", appLock: { enabled: false, failedAttempts: 0, retryAfterMs: 0 } };
const enabled: AppSettings = { theme: "dark", appLock: { enabled: true, failedAttempts: 0, retryAfterMs: 0 } };
const verified: SettingsResult = { settings: enabled, durability: "durable" };

function setup(t: TestContext, search = "") {
  const dom = bootDom(search);
  t.after(dom.restore);
  const shell = dom.id("app-shell"), gate = dom.byTest("app-lock-screen");
  const form = dom.byTest("unlock-form"), pass = dom.byTest("app-passcode");
  const retry = dom.byTest("startup-retry"), cancel = dom.byTest("unlock-cancel");
  const dataCalls = (["listDrafts", "timelinePage", "getRecord"] as const)
    .map(method => t.mock.method(MemoryAdapter.prototype, method));
  function assertPrivate() {
    assert.equal(gate.visible, true);
    assert.equal(shell.visible, false);
    assert.equal(shell.inert, true);
  }
  function assertNoReads() {
    for (const call of dataCalls) assert.equal(call.mock.callCount(), 0);
  }
  function assertNeutral() {
    assertPrivate();
    assert.equal(gate.visibleText(), "拾光");
    for (const control of [form, pass, retry, cancel, dom.byTest("app-unlock")]) assert.equal(control.visible, false);
  }
  function submit(value: string) { pass.value = value; form.fire("submit"); }
  async function load() { await import(new URL(`../src/ui/main.ts?test=${encodeURIComponent(t.name)}`, import.meta.url).href); }
  return { ...dom, shell, gate, form, pass, retry, cancel, load, submit, assertPrivate, assertNeutral, assertNoReads };
}

test("first document and slow store/settings checks are neutral; lock off enters the timeline before media returns", async t => {
  const ui = setup(t);
  const store = deferred<StoreStatus>(), settings = deferred<AppSettings>(), media = deferred<MediaReport>();
  t.mock.method(MemoryAdapter.prototype, "storeStatus", () => store.promise);
  const read = t.mock.method(MemoryAdapter.prototype, "getSettings", () => settings.promise);
  const verify = t.mock.method(MemoryAdapter.prototype, "verifyAppLock");
  const report = t.mock.method(MemoryAdapter.prototype, "mediaReport", () => media.promise);
  ui.assertNeutral(); // Shipped markup before any application JS.
  await ui.load();
  ui.assertNeutral();
  assert.equal(read.mock.callCount(), 0);
  store.resolve({ ok: true });
  await until(() => read.mock.callCount() === 1);
  ui.assertNeutral();
  ui.submit("0123"); // Even a synthetic submit cannot start verification while status is unknown.
  assert.equal(verify.mock.callCount(), 0);
  ui.assertNoReads();
  settings.resolve(disabled);
  await until(() => report.mock.callCount() === 1);
  assert.equal(ui.gate.visible, false);
  assert.equal(ui.shell.inert, false);
  assert.equal(ui.id("view-timeline").visible, true);
  ui.byTest("mine-tab").fire("click");
  await until(() => ui.id("view-mine").visible);
  media.resolve({ checkedAt: "2026-11-25", missing: [], corrupt: [], quarantined: [] });
  await until(() => ui.body.dataset.appReady === "1");
  assert.equal(ui.id("view-mine").visible, true);
});

test("store and settings errors each allow one retry; a double click cannot open the app", async t => {
  const ui = setup(t);
  const failed: StoreStatus = { ok: false, code: "STORE_LOCKED", message: "synthetic" };
  const store = t.mock.method(MemoryAdapter.prototype, "storeStatus");
  store.mock.mockImplementationOnce(async () => failed);
  const settings = t.mock.method(MemoryAdapter.prototype, "getSettings");
  settings.mock.mockImplementationOnce(async () => { throw new Error("synthetic settings failure"); });
  await ui.load();
  await until(() => ui.retry.visible);
  assert.match(ui.gate.visibleText(), /别处打开/);
  assert.equal(settings.mock.callCount(), 0);
  for (let step = 0; step < 2; step++) {
    ui.assertPrivate(); ui.assertNoReads();
    assert.equal(ui.form.visible, false);
    ui.retry.fire("click"); ui.retry.fire("click");
    if (step === 0) {
      await until(() => ui.retry.visible);
      assert.match(ui.gate.visibleText(), /无法读取/);
    }
  }
  await until(() => ui.body.dataset.appReady === "1");
  assert.equal(store.mock.callCount(), 2);
  assert.equal(settings.mock.callCount(), 2);
  assert.equal(ui.id("view-timeline").visible, true);
  assert.equal(ui.byTest("error-box").visible, false);
});

test("resume discards a stale disabled status and waits for the current enabled check and a verified passcode", async t => {
  const ui = setup(t);
  const first = deferred<AppSettings>(), second = deferred<AppSettings>();
  const read = t.mock.method(MemoryAdapter.prototype, "getSettings", () => second.promise);
  read.mock.mockImplementationOnce(() => first.promise);
  t.mock.method(MemoryAdapter.prototype, "verifyAppLock", async () => verified);
  await ui.load();
  await until(() => read.mock.callCount() === 1);
  ui.windowEvents.fire("blur"); ui.windowEvents.fire("focus"); ui.windowEvents.fire("focus");
  await until(() => read.mock.callCount() === 2);
  first.resolve(disabled);
  await new Promise(resolve => setImmediate(resolve));
  ui.assertNeutral(); ui.assertNoReads();
  second.resolve(enabled);
  await until(() => ui.pass.visible);
  ui.assertPrivate(); ui.assertNoReads();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.doesNotMatch(ui.gate.visibleText(), /正在检查/);
  ui.submit("01234567");
  await until(() => ui.body.dataset.appReady === "1");
  assert.equal(ui.id("view-timeline").visible, true);
});

test("malformed native status fails closed; an unavailable verifier can be retried without exposing its error", async t => {
  const ui = setup(t);
  const commands: string[] = [];
  let storeReply: unknown = { ok: "yes" };
  let reply: unknown = { appLock: {} };
  const invoke = async (command: string): Promise<unknown> => {
    commands.push(command);
    if (command === "store_status") return storeReply;
    if (command === "get_settings") return reply;
    if (command === "verify_app_lock") throw new Error("private synthetic diagnostic");
    throw new Error("unexpected data request");
  };
  Object.assign(window, { __TAURI__: { core: { invoke } } });
  await ui.load();
  await until(() => ui.retry.visible);
  ui.assertPrivate();
  assert.deepEqual(commands, ["store_status"]);
  storeReply = { ok: true };
  ui.retry.fire("click");
  await until(() => ui.retry.visible);
  ui.assertPrivate();
  assert.equal(ui.form.visible, false);
  reply = enabled;
  ui.retry.fire("click");
  await until(() => ui.pass.visible);
  ui.submit("1234");
  await until(() => ui.byTest("unlock-feedback").textContent.includes("暂时无法验证"));
  assert.doesNotMatch(ui.gate.visibleText(), /private synthetic/);
  ui.assertPrivate();
  assert.deepEqual(commands, ["store_status", "store_status", "get_settings", "get_settings", "verify_app_lock", "get_settings"]);
});

test("an unreadable preview store stays intact behind Retry and recovers only through the lock check", async t => {
  const ui = setup(t);
  const device = new MemoryAdapter({ storage: ui.storage, storageKey: PREVIEW_STORAGE_KEY });
  await device.setAppLock("0001");
  const validStore = ui.storage.getItem(PREVIEW_STORAGE_KEY);
  assert.ok(validStore);
  ui.storage.setItem(PREVIEW_STORAGE_KEY, "synthetic corrupt store");
  await ui.load(); await until(() => ui.retry.visible);
  ui.assertPrivate(); ui.assertNoReads();
  assert.equal(ui.form.visible, false);
  assert.equal(ui.storage.getItem(PREVIEW_STORAGE_KEY), "synthetic corrupt store");
  ui.storage.setItem(PREVIEW_STORAGE_KEY, validStore);
  ui.retry.fire("click");
  await until(() => ui.pass.visible);
  ui.assertPrivate();
  ui.submit("0001");
  await until(() => ui.body.dataset.appReady === "1");
});

for (const [query, key] of [["?demo=1", PREVIEW_STORAGE_KEY], ["?searchDemo=mixed", SEARCH_DEMO_STORAGE_KEY]] as const) {
  test(`explicit fixture ${query} preserves the saved lock, backoff and records on launch`, async t => {
    const ui = setup(t, query);
    const device = new MemoryAdapter({ storage: ui.storage, storageKey: key });
    const { row } = await device.createDraft({ body: "合成已有记录", eventDate: "2026-11-11" });
    await device.commitRecord(row.recordId, 0);
    await device.setAppLock("00001234");
    await assert.rejects(device.verifyAppLock("1111"));
    const before = ui.storage.getItem(key);
    await ui.load(); await until(() => ui.pass.visible);
    ui.assertPrivate();
    assert.equal(ui.storage.getItem(key), before);
    ui.submit("00001234");
    await until(() => ui.body.dataset.appReady === "1");
    assert.equal((await device.getSettings()).appLock.enabled, true);
    assert.equal((await device.getRecord(row.recordId)).formal?.body, "合成已有记录");
    assert.equal((await device.timelinePage({}, null, 10)).total, 1);
  });
}

test("an explicitly selected empty fixture still resets an unlocked preview and keeps its theme", async t => {
  const ui = setup(t, "?searchDemo=empty");
  const device = new MemoryAdapter({ storage: ui.storage, storageKey: SEARCH_DEMO_STORAGE_KEY });
  await device.createDraft({ body: "旧合成样例", eventDate: "2026-11-11" });
  await device.setTheme("dark");
  await ui.load(); await until(() => ui.body.dataset.appReady === "1");
  assert.deepEqual(await device.listDrafts(), []);
  assert.equal((await device.getSettings()).theme, "dark");
  assert.equal(ui.gate.visible, false);
});

test("an old failure-counter read cannot overwrite a newer verification after cancellation", async t => {
  const ui = setup(t);
  const late = deferred<AppSettings>();
  const settings = t.mock.method(MemoryAdapter.prototype, "getSettings", async () => enabled);
  settings.mock.mockImplementationOnce(() => late.promise, 1);
  const verify = t.mock.method(MemoryAdapter.prototype, "verifyAppLock", async () => verified);
  verify.mock.mockImplementationOnce(async () => { throw { code: "APP_LOCK_WRONG" }; });
  await ui.load(); await until(() => ui.pass.visible);
  ui.submit("1234");
  await until(() => settings.mock.callCount() === 2);
  ui.cancel.fire("click");
  ui.submit("01234567");
  await until(() => ui.body.dataset.appReady === "1");
  late.resolve({ ...enabled, appLock: { enabled: true, failedAttempts: 3, retryAfterMs: 1000 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.gate.visible, false);
  ui.byTest("lock-now").fire("click");
  assert.equal(ui.byTest("app-unlock").disabled, false);
  assert.equal(ui.byTest("unlock-feedback").textContent, "");
});

test("a pending adapter attempt still counts towards backoff after cancellation", async t => {
  const ui = setup(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const device = new MemoryAdapter({ storage: ui.storage, storageKey: PREVIEW_STORAGE_KEY });
  await device.setAppLock("00123");
  for (let i = 0; i < 2; i++) await assert.rejects(device.verifyAppLock("1111"));
  const release = deferred<void>();
  const verify = MemoryAdapter.prototype.verifyAppLock;
  const calls = t.mock.method(MemoryAdapter.prototype, "verifyAppLock");
  calls.mock.mockImplementationOnce(async (code: string) => {
    await release.promise;
    return verify.call(device, code);
  });
  await ui.load(); await until(() => ui.pass.visible);
  ui.submit("1111"); ui.cancel.fire("click");
  release.resolve();
  const pending = calls.mock.calls[0].result;
  assert.ok(pending);
  await assert.rejects(pending);
  ui.assertPrivate();
  ui.submit("00123");
  await until(() => ui.byTest("unlock-feedback").textContent.includes("秒后重试"));
  assert.equal(ui.byTest("app-unlock").disabled, true);
  ui.submit("00123");
  assert.equal(calls.mock.callCount(), 2);
  ui.assertNoReads();
  now += 1000;
  ui.submit("00123");
  await until(() => ui.body.dataset.appReady === "1");
});

test("a stale privacy-settings read and a delayed passcode change cannot undo a later lock", async t => {
  const ui = setup(t);
  await ui.load(); await until(() => ui.body.dataset.appReady === "1");
  const stale = deferred<AppSettings>();
  const settings = t.mock.method(MemoryAdapter.prototype, "getSettings");
  settings.mock.mockImplementationOnce(() => stale.promise);
  ui.byTest("privacy-link").fire("click");
  await until(() => settings.mock.callCount() === 1);
  ui.byTest("lock-new").value = ui.byTest("lock-confirm").value = "00123";
  ui.byTest("lock-settings-form").fire("submit");
  await until(() => ui.byTest("lock-status").textContent.includes("已启用"));
  stale.resolve(disabled);
  await new Promise(resolve => setImmediate(resolve));
  const changed = deferred<SettingsResult>();
  t.mock.method(MemoryAdapter.prototype, "changeAppLock", () => changed.promise);
  ui.byTest("lock-current").value = "00123";
  ui.byTest("lock-new").value = ui.byTest("lock-confirm").value = "01234567";
  ui.byTest("lock-settings-form").fire("submit");
  ui.byTest("lock-now").fire("click");
  ui.assertPrivate();
  changed.resolve(verified);
  await new Promise(resolve => setImmediate(resolve));
  ui.setHidden(true); ui.windowEvents.fire("focus"); ui.assertNeutral();
  ui.setHidden(false); ui.assertPrivate();
  assert.equal(ui.pass.visible, true);
});

for (const late of ["success", "error"] as const) {
  test(`cancelled verification's late ${late} cannot open the shell, clear new input or replace newer feedback`, async t => {
    const ui = setup(t);
    const old = deferred<SettingsResult>();
    const device = new MemoryAdapter({ storage: ui.storage, storageKey: PREVIEW_STORAGE_KEY });
    await device.setAppLock("00123");
    const verify = t.mock.method(MemoryAdapter.prototype, "verifyAppLock");
    verify.mock.mockImplementationOnce(() => old.promise);
    await ui.load();
    await until(() => ui.pass.visible);
    ui.submit("00123"); ui.form.fire("submit");
    assert.equal(verify.mock.callCount(), 1);
    assert.match(ui.gate.visibleText(), /正在验证/);
    assert.equal(ui.pass.disabled, true);
    assert.equal(ui.pass.value, "");
    assert.equal(ui.byTest("app-unlock").disabled, true);
    assert.equal(ui.cancel.visible, true);
    ui.cancel.fire("click");
    assert.equal(ui.cancel.visible, false);
    assert.equal(ui.pass.disabled, false);
    ui.assertPrivate();
    ui.submit("1111");
    await until(() => ui.byTest("unlock-feedback").textContent.includes("不正确"));
    ui.pass.value = "00123";
    if (late === "success") old.resolve(verified); else old.reject(new Error("synthetic late failure"));
    await new Promise(resolve => setImmediate(resolve));
    ui.assertPrivate(); ui.assertNoReads();
    assert.match(ui.byTest("unlock-feedback").textContent, /不正确/);
    assert.equal(ui.pass.value, "00123");
    assert.equal((await device.getSettings()).appLock.failedAttempts, 1);
    ui.form.fire("submit");
    await until(() => ui.body.dataset.appReady === "1");
    assert.equal((await device.getSettings()).appLock.enabled, true);
    assert.equal((await device.getSettings()).appLock.failedAttempts, 0);
  });
}

test("blur during verification cancels admission; repeated background signals keep the exact 60-second deadline", async t => {
  const ui = setup(t);
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const pending = deferred<SettingsResult>();
  t.mock.method(MemoryAdapter.prototype, "getSettings", async () => enabled);
  const verify = t.mock.method(MemoryAdapter.prototype, "verifyAppLock", async () => verified);
  verify.mock.mockImplementationOnce(() => pending.promise);
  await ui.load(); await until(() => ui.pass.visible);
  ui.submit("1234567"); ui.windowEvents.fire("blur");
  pending.resolve(verified);
  await new Promise(resolve => setImmediate(resolve));
  ui.assertNeutral(); ui.assertNoReads();
  ui.windowEvents.fire("focus");
  assert.equal(ui.pass.visible, true);
  ui.assertPrivate(); ui.assertNoReads();
  ui.submit("1234567");
  await until(() => ui.body.dataset.appReady === "1");
  ui.windowEvents.fire("blur"); ui.assertNeutral(); now += 59_999; ui.windowEvents.fire("focus");
  assert.equal(ui.shell.visible, true);
  ui.windowEvents.fire("blur"); now += 59_999; ui.windowEvents.fire("blur"); now++; ui.windowEvents.fire("focus");
  ui.assertPrivate();
  assert.equal(ui.pass.visible, true);
});
