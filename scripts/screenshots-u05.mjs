// Unit-0.5 视觉证据：浏览器预览模式（MemoryAdapter，合成数据）下的备份导出 / 校验 / 覆盖恢复 / 坏包拒绝 / 未实现提示。
// 预览模拟，不是真机：桌面原生对话框与 Android 系统文件选择器（SAF）的实际表现需真机验证。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.5");
await mkdir(out, { recursive: true });
const port = 15300 + Math.floor(Math.random() * 500);
const server = await startPreviewServer(port);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const results = [];
const errors = [];
try {
  const run = async (viewport, fn) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    const shot = async (name, full = false) => { await page.waitForTimeout(500); const p = join(out, name); await page.screenshot({ path: p, fullPage: full }); results.push(p); };
    await fn(page, shot);
    await context.close();
  };
  const desktop = { width: 960, height: 900 };
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?demo=1`);
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("data-tab").click();
    await page.getByTestId("export-backup").waitFor();
    await shot("01-data-page-not-implemented.png", true);
    await page.getByTestId("export-backup").click();
    await page.getByTestId("export-result").waitFor({ state: "visible" });
    await shot("02-export-success.png", true);
    // 导出后新建一条草稿，恢复后应消失。
    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("new-draft").click();
    await page.getByTestId("editor-body").fill("这条合成草稿写在备份之后，覆盖恢复后会被替换。");
    await page.getByTestId("editor-date").fill("2026-11-10");
    await page.waitForTimeout(1200);
    await page.getByTestId("data-tab").click();
    await page.getByTestId("pick-backup").click();
    await page.getByTestId("picked-backup").waitFor({ state: "visible" });
    await shot("03-backup-verified.png", true);
    await page.getByTestId("restore-backup").click();
    await page.getByTestId("confirm-ok").waitFor();
    await shot("04-confirm-overwrite-restore.png");
    await page.getByTestId("confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("app-notice")?.textContent?.includes("恢复完成"), null, { timeout: 10000 });
    await shot("05-restore-success.png", true);
  });
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?demo=1&backup=corrupt&view=data`);
    await page.getByTestId("pick-backup").waitFor();
    await page.getByTestId("pick-backup").click();
    await page.getByTestId("error-box").waitFor({ state: "visible" });
    await shot("06-corrupt-backup-rejected.png");
    await page.goto(`${base}?demo=1&backup=truncated&view=data`);
    await page.getByTestId("pick-backup").click();
    await page.getByTestId("error-box").waitFor({ state: "visible" });
    await shot("07-truncated-backup-rejected.png");
    await page.goto(`${base}?demo=1&backup=schemaTooNew&view=data`);
    await page.getByTestId("pick-backup").click();
    await page.getByTestId("error-box").waitFor({ state: "visible" });
    await shot("08-schema-too-new-rejected.png");
  });
  await run({ width: 390, height: 844 }, async (page, shot) => {
    await page.goto(`${base}?demo=1&view=data`);
    await page.getByTestId("export-backup").click();
    await page.getByTestId("export-result").waitFor({ state: "visible" });
    await shot("09-mobile-export.png", true);
  });
} finally {
  await writeFile(join(out, "screenshots.log"), [`page errors: ${errors.length}`, ...errors, ...results.map((r) => `saved ${r}`)].join("\n") + "\n");
  await browser.close();
  server.close();
}
if (errors.length) throw new Error(`页面报错 ${errors.length} 个：${errors.join("; ")}`);
console.log(results.join("\n"));
