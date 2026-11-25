/** 启动门禁：数据仍在打开（STORE_STARTING）或宿主尚未就绪时等待重试，而不是直接显示“数据暂时无法打开”。 */
import type { StoreStatus } from "./types.ts";

export type GateOutcome =
  | { ok: true; attempts: number }
  | { ok: false; code: string; error: unknown; attempts: number };

function isTransient(code: string, message: string): boolean {
  return code === "STORE_STARTING" || /state not managed/i.test(message);
}

function codeOf(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object") {
    return { code: "code" in error && typeof error.code === "string" ? error.code : "",
      message: "message" in error && typeof error.message === "string" ? error.message : String(error) };
  }
  return { code: "", message: String(error) };
}

export async function gateWithRetry(
  status: () => Promise<StoreStatus>,
  sleep: (ms: number) => Promise<void>,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<GateOutcome> {
  const maxAttempts = options.maxAttempts ?? 20;
  const delayMs = options.delayMs ?? 500;
  let last: { code: string; error: unknown } = { code: "", error: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const s = await status();
      if (s?.ok === true) return { ok: true, attempts: attempt };
      const failure = codeOf(s);
      last = { code: failure.code, error: failure };
      if (!isTransient(failure.code, failure.message)) return { ok: false, ...last, attempts: attempt };
    } catch (error) {
      const { code, message } = codeOf(error);
      last = { code, error };
      if (!isTransient(code, message)) return { ok: false, ...last, attempts: attempt };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { ok: false, ...last, attempts: maxAttempts };
}
