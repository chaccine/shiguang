// Unit-0.8 视觉证据：手机底部 5 个固定页签、启动默认时光轴、各页空态、标签·收藏、未完成草稿提示。
// 浏览器预览（MemoryAdapter），不联网、不读真实照片；空数据用全新的 localStorage。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.8");
await mkdir(out, { recursive: true });
const port = 16400 + Math.floor(Math.random() * 500);
const server = await startPreviewServer(port);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const results = [];
const errors = [];
let failure = null;

async function openPage(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  return { context, page };
}

/** 先清掉本浏览器的存储，再重新加载，确保是空数据。 */
async function freshEmpty(page, query = "") {
  await page.goto(`${base}${query}`);
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(`${base}${query}`);
  await page.waitForFunction(() => document.body.dataset.appReady === "1");
}

async function shot(page, name, full = false) {
  await page.waitForTimeout(400);
  const path = join(out, name);
  await page.screenshot({ path, fullPage: full });
  results.push({ path, errors: errors.length });
}

async function visibleCount(locator) {
  return locator.evaluateAll((els) => els.filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }).length);
}

/** 手机：底部固定 tab bar 必须贴底、可见、5 个按钮，且每个触控高度 >= 48px。 */
async function assertTabBar(page, label) {
  const tabs = page.locator(".tabs .tab");
  const count = await tabs.count();
  if (count !== 5) throw new Error(`${label}: 底部页签应有 5 个，实际 ${count} 个`);
  const visible = await visibleCount(tabs);
  if (visible !== 5) throw new Error(`${label}: 可见页签只有 ${visible} 个`);
  const bar = await page.locator(".tabs").boundingBox();
  const viewport = page.viewportSize();
  if (bar === null || viewport === null) throw new Error(`${label}: 找不到底部页签栏`);
  if (Math.round(bar.y + bar.height) < viewport.height - 1) {
    throw new Error(`${label}: 页签栏没有贴在屏幕底部 (y=${bar.y}, height=${bar.height}, viewport=${viewport.height})`);
  }
  if (bar.y < viewport.height * 0.55) throw new Error(`${label}: 页签栏看起来不在底部 (y=${bar.y})`);
  for (let index = 0; index < count; index += 1) {
    const tab = await tabs.nth(index).boundingBox();
    if (tab === null || tab.height < 47.5) {
      throw new Error(`${label}: 第 ${index + 1} 个页签触控高度不足 48px（${tab?.height ?? 0}）`);
    }
  }
}

/** 桌面：左侧 sidebar 保留 5 个竖排页签。 */
async function assertSidebar(page, label) {
  const tabs = page.locator(".sidebar .tab");
  const count = await tabs.count();
  if (count !== 5) throw new Error(`${label}: 左侧页签应有 5 个，实际 ${count} 个`);
  const visible = await visibleCount(tabs);
  if (visible !== 5) throw new Error(`${label}: 可见左侧页签只有 ${visible} 个`);
}

try {
  // 01-05：手机空数据，依次点底部页签切换。
  {
    const { context, page } = await openPage({ width: 390, height: 844 });
    await freshEmpty(page);
    await page.getByTestId("timeline-empty").waitFor();
    await page.getByTestId("write-first").waitFor();
    await assertTabBar(page, "01-mobile-empty-timeline");
    await shot(page, "01-mobile-empty-timeline.png");

    await page.getByTestId("mine-tab").click();

    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("drafts-empty").waitFor();
    await page.getByTestId("empty-new-draft").waitFor();
    await assertTabBar(page, "02-mobile-empty-drafts");
    await shot(page, "02-mobile-empty-drafts.png");

    await page.getByTestId("calendar-tab").click();
    await page.getByTestId("cal-empty").waitFor({ state: "visible" });
    await assertTabBar(page, "03-mobile-empty-calendar");
    await shot(page, "03-mobile-empty-calendar.png");

    await page.getByTestId("mine-tab").click();

    await page.getByTestId("collect-tab").click();
    await page.getByTestId("collect-favorites-empty").waitFor();
    await page.getByTestId("collect-tags-empty").waitFor();
    await assertTabBar(page, "04-mobile-empty-collect");
    await shot(page, "04-mobile-empty-collect.png");

    await page.getByTestId("mine-tab").click();

    await page.getByTestId("data-tab").click();
    await page.locator("#view-data").waitFor({ state: "visible" });
    await page.getByTestId("open-trash").waitFor();
    await assertTabBar(page, "05-mobile-empty-settings");
    await shot(page, "05-mobile-empty-settings.png");
    await context.close();
  }

  // 06-07：手机 demo，默认时光轴；从草稿页新建进入编辑器，底部页签仍在。
  {
    const { context, page } = await openPage({ width: 390, height: 844 });
    await page.goto(`${base}?demo=1`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.getByTestId("timeline-item").first().waitFor();
    await page.locator("#view-timeline").waitFor({ state: "visible" });
    await assertTabBar(page, "06-mobile-demo-timeline");
    await shot(page, "06-mobile-demo-timeline.png");

    await page.getByTestId("mine-tab").click();

    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("draft-item").first().waitFor();
    await page.getByTestId("new-draft").click();
    await page.getByTestId("editor-body").waitFor({ state: "visible" });
    await assertTabBar(page, "07-mobile-editor-with-tabbar");
    await shot(page, "07-mobile-editor-with-tabbar.png");
    await context.close();
  }

  // 08：桌面空数据，仍是左侧竖排页签 + 时光轴空态。
  {
    const { context, page } = await openPage({ width: 1024, height: 688 });
    await freshEmpty(page);
    await page.getByTestId("timeline-empty").waitFor();
    await assertSidebar(page, "08-desktop-empty-timeline");
    await shot(page, "08-desktop-empty-timeline.png");
    await context.close();
  }

  // 09：桌面 demo 的标签·收藏页。
  {
    const { context, page } = await openPage({ width: 1024, height: 688 });
    await page.goto(`${base}?demo=1`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.getByTestId("mine-tab").click();
    await page.getByTestId("collect-tab").click();
    await page.locator("#view-collect").waitFor({ state: "visible" });
    await page.getByTestId("collect-favorites").getByTestId("timeline-item").first().waitFor();
    await page.getByTestId("collect-tag-item").first().waitFor();
    await assertSidebar(page, "09-desktop-demo-collect");
    await shot(page, "09-desktop-demo-collect.png");
    await context.close();
  }

  // 10：手机空数据里写一篇草稿后重新打开，停在时光轴并显示“继续写”。
  {
    const { context, page } = await openPage({ width: 390, height: 844 });
    await freshEmpty(page);
    await page.getByTestId("write-first").click();
    await page.getByTestId("editor-body").waitFor({ state: "visible" });
    await page.getByTestId("editor-body").fill("明天记得给阳台的薄荷浇水，顺便把窗台擦一擦。");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="save-status"]')?.classList.contains("is-saved"),
      null,
      { timeout: 10000 },
    );
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    await page.locator("#view-timeline").waitFor({ state: "visible" });
    await page.getByTestId("resume-draft").waitFor({ state: "visible" });
    await page.getByTestId("resume-draft-button").waitFor();
    await assertTabBar(page, "10-mobile-unfinished-draft-notice");
    await shot(page, "10-mobile-unfinished-draft-notice.png");
    await context.close();
  }
} catch (error) {
  failure = error;
} finally {
  const lines = [
    `page errors: ${errors.length}`,
    ...errors,
    ...(failure === null ? [] : [`failure: ${String(failure)}`]),
    ...results.map((result) => `saved ${result.path} (page errors: ${result.errors})`),
  ];
  await writeFile(join(out, "screenshots.log"), `${lines.join("\n")}\n`);
  await browser.close();
  server.close();
}
if (failure !== null) {
  console.error(String(failure));
  process.exit(1);
}
if (errors.length) {
  console.error(`页面报错 ${errors.length} 个`);
  process.exit(1);
}
