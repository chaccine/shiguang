// Unit-0.4 视觉证据：浏览器预览模式（MemoryAdapter，合成数据）下回收站 / 冲突二选一 / 启动阻断 / 原图缺失。
// 预览模拟，不是真机：桌面 Tauri 与 Android 上的实际表现需真机验证。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.4");
await mkdir(out, { recursive: true });
const port = 14800 + Math.floor(Math.random() * 500);
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
    const shot = async (name) => { await page.waitForTimeout(500); const p = join(out, name); await page.screenshot({ path: p }); results.push(p); };
    await fn(page, shot);
    await context.close();
  };
  const desktop = { width: 960, height: 720 };
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?demo=1`);
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("trash-button").first().waitFor();
    await shot("01-timeline-trash-button.png");
    await page.getByTestId("trash-button").first().click();
    await page.getByTestId("confirm-ok").waitFor();
    await shot("02-confirm-move-to-trash.png");
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("trash-tab").click();
    await page.getByTestId("trash-item").first().waitFor();
    await shot("03-trash-view.png");
    await page.getByTestId("purge-button").first().click();
    await page.getByTestId("confirm-ok").waitFor();
    await shot("04-confirm-purge.png");
    await page.getByTestId("confirm-cancel").click();
    await page.getByTestId("restore-button").first().click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="trash-item"]'), null, { timeout: 10000 });
    await shot("05-trash-empty-after-restore.png");
  });
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?demo=1&fail=conflict`);
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("timeline-tab").click();
    await page.getByRole("button", { name: "修改" }).first().click();
    await page.getByTestId("editor-body").waitFor();
    await page.getByTestId("editor-body").fill("这条合成草稿用来演示版本冲突：存入被拒绝后，由你选择保留哪一份。");
    await page.getByTestId("commit-button").click();
    await page.getByTestId("keep-mine").waitFor({ state: "visible" });
    await shot("06-conflict-choice.png");
    await page.getByTestId("keep-formal").click();
    await page.getByTestId("conflict-copy-item").first().waitFor();
    await shot("07-conflict-copy-saved.png");
  });
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?fail=locked`);
    await page.getByTestId("store-blocked").waitFor({ state: "visible" });
    await shot("08-store-locked.png");
    await page.goto(`${base}?fail=schema`);
    await page.getByTestId("store-blocked").waitFor({ state: "visible" });
    await shot("09-schema-too-new.png");
  });
  await run(desktop, async (page, shot) => {
    await page.goto(`${base}?demo=1&media=missing`);
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("photo-missing").first().waitFor();
    await shot("10-photo-missing.png");
  });
  await run({ width: 390, height: 844 }, async (page, shot) => {
    await page.goto(`${base}?demo=1`);
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("trash-button").first().click();
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("trash-tab").click();
    await page.getByTestId("trash-item").first().waitFor();
    await shot("11-mobile-trash.png");
  });
} finally {
  await writeFile(join(out, "screenshots.log"), [`page errors: ${errors.length}`, ...errors, ...results.map((r) => `saved ${r}`)].join("\n") + "\n");
  await browser.close();
  server.close();
}
if (errors.length) throw new Error(`页面报错 ${errors.length} 个：${errors.join("; ")}`);
console.log(results.join("\n"));
