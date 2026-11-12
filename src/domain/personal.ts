import type { StorageStats } from "./types.ts";
/** A UI gate only. The operating system's task switcher is outside this gate. */
export class LockLifecycle {
  locked = true;
  private leftAt: number | null = null;
  lock(): void { this.locked = true; }
  unlock(): void { this.locked = false; this.leftAt = null; }
  background(now: number): void { this.leftAt ??= now; }
  resume(now: number): boolean {
    if (this.leftAt !== null && now - this.leftAt >= 60_000) this.lock();
    this.leftAt = null; return this.locked;
  }
}
export function storageRows(stats: StorageStats): Array<[string, string]> {
  const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  return [["原图 / 媒体", size(stats.media)], ["预览缓存 / 缩略图", size(stats.previews)],
    ["本机备份文件", size(stats.backups)], ["数据文件 state.json", size(stats.data)],
    ["其他本机文件", size(stats.other)], ["合计", size(stats.total)]];
}
