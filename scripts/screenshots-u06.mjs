// Unit-0.6 视觉证据：浏览器预览模式（MemoryAdapter，合成数据）下的加密导出 / 口令解锁 / 错口令拒绝 / 合并导入计划（含防复活）/ 覆盖与合并的二次确认。
// 预览模拟，不是真机；预览里的“加密”只是交互演示，真实加密在 Rust core。截图里口令框只显示圆点，口令不写入日志。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.6");
await mkdir(out, { recursive: true });
const port = 15900 + Math.floor(Math.random() * 500);
let server;
let browser;
let failure;
const base = `http://127.0.0.1:${port}/`;

const results = [];
const errors = [];
// 合成口令只在本进程内存里，不打印。
const pw = ["synthetic", "u06", String(port)].join("-");
try {
  server = await startPreviewServer(port);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
  const run = async (viewport, fn) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    const shot = async (name, full = false) => { await page.waitForTimeout(500); const p = join(out, name); await page.screenshot({ path: p, fullPage: full }); results.push(p); };
    await fn(page, shot);
    await context.close();
  };
  const flow = async (page, shot, prefix, full) => {
    await page.goto(`${base}?demo=1`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.getByTestId("mine-tab").click();
    await page.getByTestId("data-tab").click();
    await page.getByTestId("encrypt-toggle").check();
    await page.getByTestId("backup-password").fill(pw);
    await page.getByTestId("backup-password2").fill(pw);
    await shot(`${prefix}01-encrypt-option.png`, full);
    await page.getByTestId("export-backup").click();
    await page.getByTestId("export-result").waitFor({ state: "visible" });
    await shot(`${prefix}02-encrypted-export.png`, full);
    // 导出后：把一条正式记录移到回收站再永久删除，用来演示合并时“不复活”。
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("trash-button").first().click();
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("mine-tab").click();
    await page.getByTestId("data-tab").click();
    await page.getByTestId("open-trash").click();
    await page.getByTestId("purge-button").first().click();
    await page.getByTestId("confirm-ok").click();
    await page.waitForTimeout(600);
    await page.getByTestId("mine-tab").click();
    await page.getByTestId("data-tab").click();
    await page.getByTestId("pick-backup").click();
    await page.getByTestId("unlock-password").waitFor({ state: "visible" });
    await page.getByTestId("unlock-backup").scrollIntoViewIfNeeded();
    await shot(`${prefix}03-unlock-prompt.png`);
    await page.getByTestId("unlock-password").fill(pw + "-wrong");
    await page.getByTestId("unlock-backup").click();
    await page.getByTestId("error-box").waitFor({ state: "visible" });
    await page.getByTestId("error-box").scrollIntoViewIfNeeded();
    await shot(`${prefix}04-wrong-password-rejected.png`);
    await page.getByTestId("unlock-password").fill(pw);
    await page.getByTestId("unlock-backup").click();
    await page.getByTestId("merge-backup").waitFor({ state: "visible" });
    await page.getByTestId("discard-picked").scrollIntoViewIfNeeded();
    await shot(`${prefix}05-unlocked-merge-or-overwrite.png`);
    await page.getByTestId("restore-backup").click();
    await page.getByTestId("confirm-ok").waitFor();
    await shot(`${prefix}06-confirm-overwrite.png`);
    await page.getByTestId("confirm-cancel").click();
    await page.getByTestId("merge-backup").click();
    await page.getByTestId("confirm-ok").waitFor();
    await shot(`${prefix}07-confirm-merge-plan.png`);
    await page.getByTestId("confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("app-notice")?.textContent?.includes("合并完成"), null, { timeout: 10000 });
    await shot(`${prefix}08-merge-success.png`, full);
  };
  await run({ width: 960, height: 900 }, (page, shot) => flow(page, shot, "", true));
  await run({ width: 390, height: 844 }, async (page, shot) => {
    await page.goto(`${base}?demo=1&view=data`);
    await page.getByTestId("encrypt-toggle").check();
    await shot("09-mobile-encrypt-option.png", true);
  });
} catch (error) {
  failure = error;
} finally {
  const log = [`status: ${failure ? "BLOCKED/FAILED" : "PASS"}`, ...(failure ? [`failure: ${String(failure)}`] : []), `page errors: ${errors.length} (only loaded pages)`, ...errors, ...results.map((r) => `saved ${r}`)].join("\n") + "\n";
  await writeFile(join(out, "screenshots.log"), log.split(pw).join("[redacted]"));
  if (browser) await browser.close();
  if (server) server.close();
}
if (failure) throw failure;
if (errors.length) throw new Error(`页面报错 ${errors.length} 个`);
