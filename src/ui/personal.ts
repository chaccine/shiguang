import type { ShiguangApi } from "../platform/api.ts";
import type { AppSettings } from "../domain/types.ts";
import { describeError } from "../domain/errors.ts";
import { LockLifecycle, storageRows } from "../domain/personal.ts";
import { AppearanceUi } from "./appearance.ts";
const node = <T extends HTMLElement = HTMLElement>(id: string): T => document.querySelector<T>(`[data-testid="${id}"]`)!;

type LockScreen =
  | { kind: "starting" | "checking" | "open" | "unlock" | "submitting" }
  | { kind: "covered"; resume: "check" | "session" }
  | { kind: "check-error"; message: string; retry: () => void }
  | { kind: "unlock-error"; message: string };

/** UI credentials live only in input nodes and the current asynchronous call. */
export class PersonalUi {
  private settings: AppSettings | null = null;
  private gate = node("app-lock-screen");
  private shell = document.querySelector<HTMLElement>(".app-shell")!;
  private lifecycle = new LockLifecycle();
  // Each IPC completion belongs to its screen object. Cancel or blur replaces that object synchronously.
  private screen: LockScreen = { kind: "starting" };
  private settingsGeneration = 0;
  private unlocked: (() => void) | null = null;
  private busy = false;
  private away = false;
  private returnFocus: Element | null = null;
  private retryUntil = 0;
  private appearance: AppearanceUi;
  private api: ShiguangApi;
  private preview: boolean;
  private flush: () => Promise<boolean>;
  constructor(api: ShiguangApi, preview: boolean, flush: () => Promise<boolean>) {
    this.api = api; this.preview = preview; this.flush = flush;
    this.appearance = new AppearanceUi(api, ({ theme }) => {
      if (this.settings) {
        this.settingsGeneration++;
        this.settings = { ...this.settings, theme };
      }
    });
    this.shell.inert = true;
    this.gate.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = [...this.gate.querySelectorAll<HTMLElement>(":is(input, button):enabled:not([hidden], [hidden] *)")];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    node("unlock-form").addEventListener("submit", e => { e.preventDefault(); void this.unlock(); });
    node("unlock-cancel").addEventListener("click", () => {
      if (this.screen.kind === "submitting") this.show({ kind: "unlock" });
    });
    node("startup-retry").addEventListener("click", () => {
      if (this.screen.kind !== "check-error") return;
      const { retry } = this.screen;
      this.show({ kind: "starting" });
      retry();
    });
    node("lock-settings-form").addEventListener("submit", e => { e.preventDefault(); void this.change(false); });
    node("lock-disable").addEventListener("click", () => { void this.change(true); });
    node("lock-now").addEventListener("click", () => {
      if (this.screen.kind !== "open" || !this.settings?.appLock.enabled) return;
      this.lifecycle.lock(); this.show({ kind: "unlock" });
    });
    node("storage-refresh").addEventListener("click", () => { void this.renderStorage().catch(e => { node("storage-space").textContent = describeError(e).detail; }); });
    node("museum-hidden-reset").addEventListener("click", () => { void this.resetMuseumHidden(); });
    const tauriWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    if (tauriWindow) void tauriWindow.onFocusChanged(({payload}) => {
      if (payload) this.foreground(); else this.background();
    }).catch(() => { node("lock-status").textContent = "原生窗口焦点监听未连接；仍使用页面焦点和可见性保护。"; });
    window.addEventListener("blur", () => this.background());
    window.addEventListener("focus", () => this.foreground());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.background(); else this.foreground(); });
    window.setInterval(() => this.paintRetry(), 250);
  }
  async refresh(): Promise<void> {
    const read = ++this.settingsGeneration;
    const settings = await this.api.getSettings();
    if (this.settingsGeneration === read) this.applySettings(settings);
  }
  waitForStoreRetry(message: string): Promise<void> {
    return new Promise(resolve => this.show({ kind: "check-error", message, retry: resolve }));
  }
  start(): Promise<void> {
    return new Promise(resolve => {
      this.unlocked = resolve;
      if (this.away || document.hidden) this.show({ kind: "covered", resume: "check" });
      else void this.checkLock();
    });
  }
  private async checkLock(): Promise<void> {
    const checking: LockScreen = { kind: "checking" };
    this.show(checking);
    try {
      const settings = await this.api.getSettings();
      if (this.screen !== checking) return;
      if (typeof settings?.appLock?.enabled !== "boolean") { this.checkError(); return; }
      this.applySettings(settings);
      if (!settings.appLock.enabled) { this.open(); return; }
      this.lifecycle.lock();
      if (this.away || document.hidden) this.show({ kind: "covered", resume: "session" });
      else this.show({ kind: "unlock" });
    } catch {
      if (this.screen === checking) this.checkError();
    }
  }
  private checkError(): void {
    this.show({ kind: "check-error", message: "无法读取本机应用锁设置，请重试。", retry: () => { void this.checkLock(); } });
  }
  private open(): void {
    this.lifecycle.unlock();
    this.show({ kind: "open" });
    this.unlocked?.(); this.unlocked = null;
  }
  private show(screen: LockScreen): void {
    const wasCovered = this.shell.inert;
    const covered = screen.kind !== "open";
    const prompt = screen.kind === "unlock" || screen.kind === "unlock-error";
    const submitting = screen.kind === "submitting";
    if (covered && !wasCovered) this.returnFocus = document.activeElement;
    this.screen = screen;
    this.shell.inert = covered; this.shell.hidden = covered;
    this.gate.hidden = !covered;
    node("startup-cover").hidden = screen.kind !== "starting" && screen.kind !== "checking" && screen.kind !== "covered";
    node("startup-error").hidden = screen.kind !== "check-error";
    node("startup-message").textContent = screen.kind === "check-error" ? screen.message : "";
    node("unlock-form").hidden = !prompt && !submitting;
    node<HTMLInputElement>("app-passcode").disabled = !prompt;
    node("unlock-cancel").hidden = !submitting;
    node("unlock-hint").textContent = submitting ? "正在验证口令…" : prompt ? "输入口令，打开你的时光。" : "";
    node("unlock-feedback").textContent = screen.kind === "unlock-error" ? screen.message : "";
    this.paintRetry();
    if (covered) {
      for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
      if (this.away || document.hidden) return;
      if (prompt) node("app-passcode").focus();
      else if (submitting) node("unlock-cancel").focus();
      else if (screen.kind === "check-error") node("startup-retry").focus();
      else this.gate.focus();
    } else if (wasCovered) {
      const target = this.returnFocus;
      if (target?.isConnected && "focus" in target && typeof target.focus === "function") target.focus();
      else node("timeline-tab")?.focus();
      this.returnFocus = null;
    }
  }
  private background(): void {
    this.away = true;
    if (this.screen.kind === "checking") { this.show({ kind: "covered", resume: "check" }); return; }
    if (this.screen.kind === "covered" || this.screen.kind === "check-error") return;
    if (!this.settings?.appLock.enabled) return;
    this.lifecycle.background(Date.now());
    this.clearCodes(); this.show({ kind: "covered", resume: "session" });
    void this.flush();
  }
  private foreground(): void {
    if (document.hidden) return;
    this.away = false;
    if (this.screen.kind !== "covered") return;
    if (this.screen.resume === "check") { void this.checkLock(); return; }
    if (this.lifecycle.resume(Date.now())) this.show({ kind: "unlock" });
    else this.open();
  }
  private clearCodes(): void {
    for (const id of ["app-passcode", "lock-current", "lock-new", "lock-confirm"]) node<HTMLInputElement>(id).value = "";
  }
  private applySettings(settings: AppSettings): void {
    this.settingsGeneration++;
    this.settings = settings;
    const {theme, appLock} = settings;
    this.appearance.sync(theme);
    node("lock-status").textContent = appLock.enabled ? "应用锁已启用" : "应用锁未启用";
    node("lock-current-label").hidden = !appLock.enabled;
    node("lock-enable").textContent = appLock.enabled ? "更改口令" : "启用应用锁";
    node("lock-disable").hidden = !appLock.enabled; node("lock-now").hidden = !appLock.enabled;
    this.retryUntil = Date.now() + appLock.retryAfterMs;
    this.paintRetry();
  }
  private paintRetry(): void {
    const seconds = Math.ceil(Math.max(0, this.retryUntil - Date.now()) / 1000);
    node<HTMLButtonElement>("app-unlock").disabled = this.screen.kind === "submitting" || this.busy || seconds > 0;
    node<HTMLButtonElement>("lock-enable").disabled = this.busy || seconds > 0;
    node<HTMLButtonElement>("lock-disable").disabled = this.busy || seconds > 0;
    if (seconds) {
      const message = `尝试过多，请 ${seconds} 秒后重试。`;
      node("unlock-feedback").textContent = message; node("lock-feedback").textContent = message;
    } else {
      for (const id of ["unlock-feedback", "lock-feedback"]) {
        if (node(id).textContent?.startsWith("尝试过多")) node(id).textContent = "现在可以重新输入口令。";
      }
    }
  }
  private async unlock(): Promise<void> {
    if (this.screen.kind !== "unlock" && this.screen.kind !== "unlock-error") return;
    if (this.busy || this.away || document.hidden || Date.now() < this.retryUntil) return;
    const attempt: LockScreen = { kind: "submitting" };
    let code = node<HTMLInputElement>("app-passcode").value; this.clearCodes();
    this.show(attempt);
    try {
      const result = await this.api.verifyAppLock(code);
      if (this.screen !== attempt) return;
      if (result.settings?.appLock?.enabled !== true) { this.checkError(); return; }
      if (this.away || document.hidden) { this.background(); return; }
      this.applySettings(result.settings); this.open();
    } catch (error) {
      if (this.screen !== attempt) return;
      try {
        const settings = await this.api.getSettings();
        if (this.screen !== attempt) return;
        if (settings?.appLock?.enabled !== true) { this.checkError(); return; }
        this.applySettings(settings);
        const wrong = error && typeof error === "object" && "code" in error && error.code === "APP_LOCK_WRONG";
        this.show({ kind: "unlock-error", message: wrong ? "口令不正确，请重试。" : "暂时无法验证口令，请重试。" });
      } catch {
        if (this.screen === attempt) this.checkError();
      }
    } finally { code = ""; }
  }
  private async change(disable: boolean): Promise<void> {
    if (this.screen.kind !== "open" || this.busy || Date.now() < this.retryUntil) return;
    let current = node<HTMLInputElement>("lock-current").value;
    let next = node<HTMLInputElement>("lock-new").value;
    let confirmation = node<HTMLInputElement>("lock-confirm").value;
    this.clearCodes();
    this.busy = true; this.paintRetry();
    try {
      if (!disable && (!/^[0-9]{4,8}$/.test(next) || next !== confirmation)) {
        node("lock-feedback").textContent = "请输入并确认相同的 4–8 位数字新口令。"; return;
      }
      const result = disable ? await this.api.disableAppLock(current) : this.settings?.appLock.enabled
        ? await this.api.changeAppLock(current, next) : await this.api.setAppLock(next);
      this.applySettings(result.settings);
      if (disable) this.open();
      else if (document.hidden || this.away) this.background();
      node("lock-feedback").textContent = result.durability === "uncertain" ? "设置已生效，但系统未确认写入磁盘，请保持应用打开并重试检查。" : disable ? "已关闭应用锁。" : "口令已设置。";
    } catch {
      node("lock-feedback").textContent = "操作未完成，请检查当前口令后重试。";
      await this.refresh().catch(() => {});
    } finally { current = next = confirmation = ""; this.clearCodes(); this.busy = false; this.paintRetry(); }
  }
  async renderStorage(): Promise<void> {
    node("storage-preview").hidden = !this.preview;
    node("storage-space").textContent = "正在统计…";
    const stats = await this.api.storageStats();
    node("storage-stats").replaceChildren(...storageRows(stats).flatMap(([label, value]) => {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value; return [dt, dd];
    }));
    node("storage-space").textContent = stats.available === null ? "设备可用空间未知，请在系统设置中检查剩余空间。"
      : stats.available < 512 * 1024 * 1024 ? "设备空间不足 512 MB，请及时备份并在系统设置中释放空间。" : "设备剩余空间充足。";
  }
  private async resetMuseumHidden(): Promise<void> {
    const button=node<HTMLButtonElement>("museum-hidden-reset"), feedback=node("museum-hidden-feedback");
    if(button.disabled)return;
    button.disabled=true;
    try {
      const result=await this.api.resetMuseumHidden();
      feedback.textContent=result.durability==="uncertain"
        ? "偏好已恢复，但系统未确认写入磁盘，请保持应用打开并重试检查。"
        : `已恢复 ${result.affectedRecords} 条记录的推荐偏好。`;
    } catch(error) {feedback.textContent=describeError(error).detail;}
    finally {button.disabled=false;}
  }
}
