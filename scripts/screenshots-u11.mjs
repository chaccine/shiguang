// Unit-0.11 M04 evidence. Synthetic MemoryAdapter data; run by orchestrator outside sandbox.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence/unit-0.11");
const scenes = ["museum-home", "reunion", "favorites", "photo-wall", "photo-viewer", "year-list", "year-room", "empty-museum", "nav-single-plus"];
const expected = ["mobile", "desktop"].flatMap(layout => ["light", "dark"].flatMap(theme => scenes.map(scene => `${layout}-${scene}-${theme}.png`)));
const saved = [], errors = [];
let server, browser, failure;
await mkdir(out, { recursive: true });
try {
  const port = 18000 + Math.floor(Math.random() * 500);
  server = await startPreviewServer(port);
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
  for (const [layout, viewport] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 960 }]]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
      try {
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin === origin && url.pathname === "/favicon.ico") { await route.fulfill({ status: 204 }); return; }
          if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) {
            errors.push(`Unexpected external request: ${url.origin}`); await route.abort();
          } else await route.continue();
        });
        // Fix local today to Nov 12 so reunion content is independent of execution day.
        await context.addInitScript(() => {
          const NativeDate = Date;
          window.Date = class extends NativeDate {
            constructor(...args) { if (args.length) super(...args); else super("2026-11-12T04:00:00Z"); }
            static now() { return new NativeDate("2026-11-12T04:00:00Z").getTime(); }
          };
        });
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on("pageerror", error => errors.push(String(error)));
        page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
        const ready = () => page.waitForFunction(() => document.body.dataset.appReady === "1");
        await page.goto(origin); await ready();
        await page.evaluate(async theme => {
          const { MemoryAdapter } = await import("/platform/memory-adapter.js");
          const { PREVIEW_STORAGE_KEY } = await import("/ui/demo.js");
          const api = new MemoryAdapter({ storage: localStorage, storageKey: PREVIEW_STORAGE_KEY, search: "", now: () => "2026-11-12T04:00:00Z" });
          await api.setTheme(theme);
          // Canvas illustrations are visibly synthetic, no photographs or private data.
          const png = index => {
            const canvas = document.createElement("canvas"); canvas.width = 720; canvas.height = 540;
            const c = canvas.getContext("2d"); if (!c) throw Error("Canvas unavailable");
            c.fillStyle = ["#e6dfcc", "#d0d7cf", "#e2c8ae"][index % 3]; c.fillRect(0, 0, 720, 540);
            c.fillStyle = "#fbf3df"; c.fillRect(70, 55, 580, 360);
            c.fillStyle = ["#779486", "#ab7758", "#607a89"][index % 3];
            c.beginPath(); c.arc(370, 255, 145, 0, 2 * Math.PI); c.fill();
            c.fillStyle = "#d2ac72"; c.fillRect(160, 320, 400, 30);
            c.fillStyle = "#4c5d50"; c.font = "22px sans-serif"; c.fillText(`SHIGUANG / SYNTHETIC ${index + 1}`, 140, 475);
            return Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0));
          };
          const stories = [
            ["2024-11-12", "窗边的一束光", "把桌边的光留在这一页。\n合成故事，用于界面验收。", 2, true],
            ["2023-11-12", "慢慢走过的小路", "午后散步，记下一件平常的小事。\n合成故事，用于界面验收。", 1, true],
            ["2021-11-12", "一封写给从前的信", "那天的文字没有配图，也值得单独展出。\n合成故事，用于界面验收。", 0, true],
            ["2024-01-08", "冬天的第一杯热茶", "杯沿升起薄薄的热气。\n合成故事，用于界面验收。", 1, false],
            ["2024-04-16", "纸上的春天", "给日常留下一点颜色。\n合成故事，用于界面验收。", 1, true],
            ["2024-07-21", "", "没有标题的一段夏日文字。\n合成故事，用于界面验收。", 1, false],
            ["2024-09-02", "一张明信片", "收藏一段平静的午后。\n合成故事，用于界面验收。", 2, true],
            ["2022-06-18", "雨停以后", "合成文字记录，保留原来的日期。", 0, false],
            ["2027-01-01", "写给明年的一天", "合成未来记录，不能冒充历史回忆。", 1, false],
          ];
          for (const [index, [eventDate, title, body, count, favorite]] of stories.entries()) {
            const { row } = await api.createDraft({ eventDate, title, body });
            for (let p = 0; p < count; p++) await api.attachPhotoBytes({ recordId: row.recordId, fileName: `synthetic-${index}-${p}.png`, bytes: png(index + p),
              caption: `合成照片 ${index + 1} · ${p + 1}\n代码绘制的图形，与这一段故事相连。` });
            await api.commitRecord(row.recordId, 0); if (favorite) await api.setFavorite(row.recordId, true);
          }
          await api.createDraft({ title: "未提交草稿，不得出展", body: "这是合成草稿。", eventDate: "2024-11-12" });
          localStorage.setItem("shiguang.theme", theme);
        }, theme);
        await page.reload(); await ready();
        const visible = id => page.getByTestId(id).waitFor({ state: "visible" });
        const home = async () => { await page.getByTestId("museum-tab").click(); await visible("museum-home"); };
        const area = async name => { await home(); await page.getByTestId(`museum-enter-${name}`).click(); await visible(`museum-${name}`); };
        const shot = async (scene, fullPage = false) => {
          await page.evaluate(async () => {
            await document.fonts.ready;
            const images = [...document.images].filter(img => img.getClientRects().length > 0);
            await Promise.all(images.map(async img => {
              img.loading = "eager";
              if (!img.getAttribute("src")) await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error("Thumbnail URL timeout")), 10000);
                const observer = new MutationObserver(() => { if (img.getAttribute("src")) { clearTimeout(timer); observer.disconnect(); resolve(); } });
                observer.observe(img, { attributes: true, attributeFilter: ["src"] });
              });
              await img.decode();
            }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
          assert.deepEqual(errors, [], `browser errors before ${scene}`);
          const path = join(out, `${layout}-${scene}-${theme}.png`);
          // Unfold the independently scrolling desktop main for long-page evidence.
          // Anchor the mobile nav at the end of that capture, avoiding a fixed bar
          // painted through its middle. nav-single-plus/viewer retain real viewport geometry.
          const captureStyle = fullPage ? await page.addStyleTag({ content: `
            .app-shell { position: relative; height: auto; min-height: 100vh; overflow: visible; }
            .main { overflow: visible; }
            @media (max-width: 760px) { .tabs { position: absolute; bottom: 0; } }
          ` }) : null;
          try { await page.screenshot({ path, fullPage }); }
          finally { if (captureStyle) await captureStyle.evaluate(node => node.remove()); }
          saved.push(path.split(/[\\/]/).at(-1)); console.log(path);
        };
        await home(); assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.doesNotMatch(await page.getByTestId("museum-home").innerText(), /未提交草稿，不得出展|手工主题展|建设中/);
        await shot("museum-home", true);
        await area("reunion"); assert.match(await page.getByTestId("museum-reunion").innerText(), /2 年前的今天|3 年前的今天/); await shot("reunion", true);
        await area("favorites"); assert.ok(await page.getByTestId("museum-list").locator("article").count() >= 3); await shot("favorites", true);
        await area("photos"); assert.equal(await page.getByTestId("museum-list").locator("button").count(), 9); await shot("photo-wall", true);
        const tile = page.getByTestId("museum-list").locator("button").first(); await tile.click(); await visible("museum-viewer");
        assert.match(await page.getByTestId("museum-viewer").innerText(), /合成照片|进入完整故事/); await shot("photo-viewer");
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
        await page.getByTestId("museum-viewer").waitFor({ state: "hidden" }); assert.equal(await tile.evaluate(n => n === document.activeElement), true);
        await area("years"); await shot("year-list", true);
        await page.getByTestId("museum-year-2024").click(); await visible("museum-year"); await shot("year-room", true);
        await home();
        const create = page.getByTestId("create-tab");
        assert.equal(await create.getAttribute("aria-label"), "＋记录"); assert.equal(((await create.innerText()).match(/[＋+]/g) ?? []).length, 1);
        await shot("nav-single-plus");
        // Fresh preview key, keep the theme but no records (not even drafts).
        await page.evaluate(async theme => {
          const { PREVIEW_STORAGE_KEY } = await import("/ui/demo.js"); localStorage.removeItem(PREVIEW_STORAGE_KEY);
          const { MemoryAdapter } = await import("/platform/memory-adapter.js");
          const api = new MemoryAdapter({ storage: localStorage, storageKey: PREVIEW_STORAGE_KEY, search: "" }); await api.setTheme(theme);
        }, theme);
        await page.reload(); await ready(); await home(); await visible("museum-empty");
        assert.equal(await page.getByTestId("museum-reshuffle").isDisabled(), true); await shot("empty-museum", true);
      } finally { await context.close(); }
    }
  }
  assert.deepEqual([...saved].sort(), [...expected].sort(), "incomplete screenshot matrix"); assert.deepEqual(errors, []);
} catch (error) { failure = error; }
finally {
  try { if (browser) await browser.close(); } catch (error) { failure ??= error; }
  try { if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { failure ??= error; }
  await writeFile(join(out, "screenshots-result.json"), JSON.stringify({ status: failure ? "FAILED" : "PASS", today: "2026-11-12 (Asia/Shanghai)",
    source: "MemoryAdapter / synthetic canvas fixtures / browser preview, not native devices", expected, saved, errors, error: failure ? String(failure) : null }, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`PASS: ${saved.length} synthetic screenshots, page errors: ${errors.length}`);
