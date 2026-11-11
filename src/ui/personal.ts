import { durabilityLabel } from "../domain/format.ts";
import type { ShiguangApi } from "../platform/api.ts";
import type { AppSettings, ThemePreference } from "../domain/types.ts";
import { describeError } from "../domain/errors.ts";
import { LockLifecycle, storageRows } from "../domain/personal.ts";
const node = <T extends HTMLElement = HTMLElement>(id: string): T => document.querySelector<T>(`[data-testid="${id}"]`)!;

/** UI credentials live only in input nodes and the current asynchronous call. */
export class PersonalUi {
  private settings: AppSettings | null = null;
  private gate = node("app-lock-screen");
  private shell = document.querySelector<HTMLElement>(".app-shell")!;
  private lifecycle = new LockLifecycle();
  private unlocked: (() => void) | null = null;
  private busy = false;
  private away = false;
  private retryUntil = 0;
  private media = window.matchMedia("(prefers-color-scheme: dark)");
  private api: ShiguangApi;
  private preview: boolean;
  private flush: () => Promise<boolean>;
  constructor(api: ShiguangApi, preview: boolean, flush: () => Promise<boolean>) {
    this.api = api; this.preview = preview; this.flush = flush;
    this.shell.inert = true;
    node("unlock-form").addEventListener("submit", e => { e.preventDefault(); void this.unlock(); });
    node("lock-settings-form").addEventListener("submit", e => { e.preventDefault(); void this.change(false); });
    node("lock-disable").addEventListener("click", () => { void this.change(true); });
    node("lock-now").addEventListener("click", () => { this.lifecycle.lock(); this.mask(true); });
    node("storage-refresh").addEventListener("click", () => { void this.renderStorage().catch(e => { node("storage-space").textContent = describeError(e).detail; }); });
    node<HTMLSelectElement>("theme-select").addEventListener("change", () => {
      const selector = node<HTMLSelectElement>("theme-select"); selector.disabled = true;
      void this.api.setTheme(selector.value as ThemePreference).then(r => {
        this.settings = r.settings; this.paint(); node("appearance-feedback").textContent = durabilityLabel(r.durability);
      }).catch(e => {
        node("appearance-feedback").textContent = describeError(e).detail;
        if (this.settings) selector.value = this.settings.theme;
      }).finally(() => { selector.disabled = false; });
    });
    const font = node<HTMLSelectElement>("font-scale");
    font.value = window.localStorage.getItem("shiguang.fontScale") ?? "1";
    if (!["1", "1.15", "1.3"].includes(font.value)) font.value = "1";
    const applyFont = () => { document.documentElement.style.fontSize = `${Number(font.value) * 100}%`; };
    applyFont(); font.addEventListener("change", () => { window.localStorage.setItem("shiguang.fontScale", font.value); applyFont(); });
    this.media.addEventListener("change", () => this.paint());
    const tauriWindow = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => {
      onFocusChanged: (handler: (event: {payload: boolean}) => void) => Promise<() => void>;
    } } } }).__TAURI__?.window?.getCurrentWindow?.();
    if (tauriWindow) void tauriWindow.onFocusChanged(({payload}) => {
      if (payload) this.foreground(); else this.background();
    }).catch(() => { node("lock-status").textContent = "原生窗口焦点监听未连接；仍使用页面焦点和可见性保护。"; });
    window.addEventListener("blur", () => this.background());
    window.addEventListener("focus", () => this.foreground());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.background(); else this.foreground(); });
    window.setInterval(() => this.paintRetry(), 250);
  }
  async refresh(): Promise<void> { this.settings = await this.api.getSettings(); this.paint(); }
  async start(): Promise<void> {
    await this.refresh();
    if (!this.settings!.appLock.enabled) { this.lifecycle.unlock(); this.mask(false); return; }
    this.lifecycle.lock(); this.mask(true);
    await new Promise<void>(resolve => { this.unlocked = resolve; });
  }
  private mask(locked: boolean): void {
    this.gate.hidden = !locked; this.shell.inert = locked;
    if (locked) {
      for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
      node("unlock-hint").textContent = this.lifecycle.locked ? "输入口令，打开你的时光。" : "界面已遮挡，回到窗口后继续。";
      node<HTMLInputElement>("app-passcode").hidden = !this.lifecycle.locked;
      node("app-unlock").hidden = !this.lifecycle.locked;
      if (this.lifecycle.locked) node<HTMLInputElement>("app-passcode").focus();
    }
  }
  private background(): void {
    if (!this.settings?.appLock.enabled) return;
    this.away = true;
    this.lifecycle.background(Date.now());
    this.clearCodes(); this.mask(true);
    void this.flush();
  }
  private foreground(): void {
    if (!this.settings?.appLock.enabled) return;
    if (document.hidden) return;
    this.away = false;
    this.mask(this.lifecycle.resume(Date.now()));
  }
  private clearCodes(): void {
    for (const id of ["app-passcode", "lock-current", "lock-new", "lock-confirm"]) node<HTMLInputElement>(id).value = "";
  }
  private paint(): void {
    if (!this.settings) return;
    const {theme, appLock} = this.settings;
    document.documentElement.dataset.theme = theme === "system" ? (this.media.matches ? "dark" : "light") : theme;
    node<HTMLSelectElement>("theme-select").value = theme;
    node("lock-status").textContent = appLock.enabled ? "应用锁已启用" : "应用锁未启用";
    node("lock-current-label").hidden = !appLock.enabled;
    node("lock-enable").textContent = appLock.enabled ? "更改口令" : "启用应用锁";
    node("lock-disable").hidden = !appLock.enabled; node("lock-now").hidden = !appLock.enabled;
    this.retryUntil = Date.now() + appLock.retryAfterMs;
    this.paintRetry();
  }
  private paintRetry(): void {
    const seconds = Math.ceil(Math.max(0, this.retryUntil - Date.now()) / 1000);
    node<HTMLButtonElement>("app-unlock").disabled = this.busy || seconds > 0;
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
    if (this.busy || Date.now() < this.retryUntil) return;
    this.busy = true; this.paintRetry();
    let code = node<HTMLInputElement>("app-passcode").value; this.clearCodes();
    try {
      const result = await this.api.verifyAppLock(code); this.settings = result.settings;
      this.lifecycle.unlock();
      if (this.away || document.hidden) { this.lifecycle.background(Date.now()); this.mask(true); } else this.mask(false);
      node("unlock-feedback").textContent = "";
      this.unlocked?.(); this.unlocked = null;
    } catch {
      node("unlock-feedback").textContent = "口令不正确或暂时无法验证，请重试。";
      await this.refresh().catch(() => {});
    } finally { code = ""; this.clearCodes(); this.busy = false; this.paintRetry(); }
  }
  private async change(disable: boolean): Promise<void> {
    if (this.busy || Date.now() < this.retryUntil) return;
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
      this.settings = result.settings; this.lifecycle.unlock(); this.paint();
      if (!disable && (document.hidden || this.away)) this.background();
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
}
