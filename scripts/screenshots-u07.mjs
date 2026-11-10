// Unit-0.7 视觉证据：时光轴（年月日分组 / 分页 / 珍藏 / 标签筛选）、日历（当月 / 当天 / 那年今日）、标签管理与重名合并。
// 浏览器预览（MemoryAdapter + 合成数据），不联网、不读真实照片；截图里的内容全部为虚构。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.7");
await mkdir(out, { recursive: true });
const port = 15900 + Math.floor(Math.random() * 500);
const server = await startPreviewServer(port);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const results = [];
const errors = [];

try {
  const run = async (viewport, fn) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    const shot = async (name, full = false) => {
      await page.waitForTimeout(500);
      const path = join(out, name);
      await page.screenshot({ path, fullPage: full });
      results.push({ path, errors: errors.length });
    };
    await fn(page, shot);
    await context.close();
  };

  await run({ width: 1280, height: 860 }, async (page, shot) => {
    await page.goto(`${base}?demo=1`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("timeline-item").first().waitFor();
    await shot("01-timeline-desktop.png");

    await page.getByTestId("calendar-tab").click();
    await page.getByTestId("cal-day").first().waitFor();
    await shot("03-calendar-month.png");

    await page.locator('[data-testid="cal-day"][data-count="3"]').first().click();
    await page.getByTestId("day-panel").getByTestId("timeline-item").first().waitFor();
    const dayCount = await page.getByTestId("day-panel").getByTestId("timeline-item").count();
    if (dayCount !== 3) throw new Error(`当天列表应有 3 条，实际 ${dayCount} 条`);
    await shot("04-day-detail.png");

    await page.getByTestId("cal-today").click();
    await page.getByTestId("on-this-day").getByTestId("timeline-item").first().waitFor();
    await page.getByTestId("on-this-day").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await shot("05-on-this-day.png");

    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("favorite-filter").check();
    await page.waitForFunction(() => document.querySelector('[data-testid="timeline-summary"]')?.textContent?.includes("/ 共 2 条"), null, { timeout: 10000 });
    await shot("06-favourites-filter.png");

    await page.getByTestId("manage-tags").click();
    await page.getByTestId("tag-dialog").waitFor({ state: "visible" });
    await page.getByTestId("tag-row").first().waitFor();
    await shot("07-tag-manage.png");

    const travelRow = page.getByTestId("tag-row").filter({ hasText: "旅行" });
    await travelRow.getByTestId("tag-rename").click();
    await page.getByTestId("tag-rename-input").fill("家人");
    await page.getByTestId("tag-rename-confirm").click();
    await page.getByTestId("confirm-dialog").waitFor({ state: "visible" });
    await shot("08-tag-rename-conflict.png");

    await page.getByTestId("confirm-ok").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tag-dialog-status"]')?.textContent?.includes("已合并，影响"), null, { timeout: 10000 });
    await shot("09-tag-merged.png");

    await page.getByTestId("tag-close").click();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("timeline-item").first().waitFor();
    await page.getByTestId("favorite-filter").uncheck();
    await page.getByTestId("timeline-item").first().waitFor();
    await page.getByTestId("tag-filter-chip").filter({ hasText: "家人" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="timeline-summary"]')?.textContent?.includes("/ 共 4 条"), null, { timeout: 10000 });
    await shot("10-tag-filter.png");
  });

  await run({ width: 390, height: 844 }, async (page, shot) => {
    await page.goto(`${base}?demo=1`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("timeline-item").first().waitFor();
    await shot("02-timeline-mobile.png");

    await page.getByTestId("calendar-tab").click();
    await page.getByTestId("cal-day").first().waitFor();
    await page.locator('[data-testid="cal-day"][data-count="3"]').first().click();
    await page.getByTestId("day-panel").getByTestId("timeline-item").first().waitFor();
    await shot("11-calendar-mobile.png", true);
  });
} finally {
  const lines = [
    `page errors: ${errors.length}`,
    ...errors,
    ...results.map((result) => `saved ${result.path} (page errors: ${result.errors})`),
  ];
  await writeFile(join(out, "screenshots.log"), `${lines.join("\n")}\n`);
  await browser.close();
  server.close();
}
if (errors.length) throw new Error(`页面报错 ${errors.length} 个`);
