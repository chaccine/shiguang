// Unit-0.10 browser evidence. MemoryAdapter and generated PNG fixtures only.
// Run outside the restricted sandbox: npm run screenshots:u10
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence/unit-0.10");
const scenes = ["nav-default", "timeline-light", "timeline-dark", "reading-light", "reading-dark",
  "editor-fields", "editor-photos", "mine", "storage", "theme-settings", "app-lock-settings", "lock-screen",
  "museum-light", "museum-dark", "large-font-light", "large-font-dark"];
const expected = ["mobile", "desktop"].flatMap(layout => scenes.map(scene => `${layout}-${scene}.png`));
const saved = [], errors = [];
let server, browser, failure;
await mkdir(out, { recursive: true });
try {
  const port = 17500 + Math.floor(Math.random() * 500);
  server = await startPreviewServer(port);
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
  for (const [layout, viewport] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 960 }]]) {
    const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai",
      colorScheme: "light", reducedMotion: "reduce", serviceWorkers: "block" });
    try {
      // Fail closed on any external request; no third-party services or remote media.
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          errors.push(`Unexpected external request: ${url.origin}`);
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(String(error)));
      page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
      const ready = () => page.waitForFunction(() => document.body.dataset.appReady === "1");
      await page.goto(origin);
      await ready();
      // Seed through the real preview API, never by editing raw persisted state.
      const recordId = await page.evaluate(async () => {
        const { MemoryAdapter } = await import("/platform/memory-adapter.js");
        const { PREVIEW_STORAGE_KEY } = await import("/ui/demo.js");
        const api = new MemoryAdapter({ storage: localStorage, storageKey: PREVIEW_STORAGE_KEY,
          now: () => "2026-11-11T10:00:00Z" });
        await api.setTheme("light");
        const { row } = await api.createDraft({ title: "合成：窗边的午后", eventDate: "2026-11-11",
          eventTime: null, body: "合成记录，仅用于界面验收。\n午后的光落在桌边，留下安静的一刻。",
          location: "合成地点 · 窗边", mood: "平静" });
        for (const [index, color] of ["#b2c8a6", "#e8b975"].entries()) {
          const canvas = document.createElement("canvas"); canvas.width = 720; canvas.height = 480;
          const c = canvas.getContext("2d"); if (!c) throw new Error("Canvas unavailable");
          c.fillStyle = "#f5edde"; c.fillRect(0, 0, 720, 480);
          c.fillStyle = color; c.fillRect(100 + index * 90, 80, 320, 300);
          c.fillStyle = "#516452"; c.beginPath(); c.arc(360, 230, 85, 0, Math.PI * 2); c.fill();
          const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0));
          await api.attachPhotoBytes({ recordId: row.recordId, fileName: `synthetic-${index}.png`,
            bytes, mediaType: "image/png", caption: `合成照片 ${index + 1}\n代码生成的色块，无真实私人数据。` });
        }
        await api.commitRecord(row.recordId, row.baseRevision);
        return row.recordId;
      });
      await page.reload(); await ready();
      const visible = id => page.getByTestId(id).waitFor({ state: "visible" });
      const shot = async scene => {
        // Lazy photos below the fold must also be decoded before a full-page capture.
        await page.waitForFunction(() => [...document.images]
          .filter(img => img.getClientRects().length > 0).every(img => img.getAttribute("src")));
        await page.evaluate(async () => {
          await document.fonts.ready;
          const images = [...document.images].filter(img => img.getClientRects().length > 0);
          await Promise.all(images.map(async img => { img.loading = "eager"; await img.decode(); }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        assert.deepEqual(errors, [], `browser errors before ${scene}`);
        const name = `${layout}-${scene}.png`;
        const path = join(out, name);
        await page.screenshot({ path, fullPage: true, animations: "disabled" });
        saved.push(name); console.log(`saved ${path}`);
      };
      const theme = async value => {
        await page.getByTestId("mine-tab").click(); await page.getByTestId("appearance-link").click();
        await page.getByTestId("theme-select").selectOption(value);
        await page.waitForFunction(value => document.documentElement.dataset.theme === value
          && document.documentElement.dataset.themePreference === value
          && !document.querySelector('[data-testid="theme-select"]').disabled, value);
      };
      await visible("timeline-item");
      assert.equal(await page.getByTestId("timeline-tab").getAttribute("aria-current"), "page");
      assert.equal(await page.locator("nav button").count(), 5);
      await shot("nav-default"); await shot("timeline-light");
      await page.getByTestId("edit-button").first().click(); await visible("reading-cover");
      assert.equal(await page.getByTestId("reading-photo").count(), 2);
      await shot("reading-light");
      await theme("dark");
      await page.getByTestId("timeline-tab").click(); await visible("timeline-item"); await shot("timeline-dark");
      await page.getByTestId("edit-button").first().click(); await visible("reading-cover"); await shot("reading-dark");
      await page.getByTestId("museum-tab").click(); await visible("museum-placeholder");
      assert.match(await page.getByTestId("museum-placeholder").innerText(), /建设中/); await shot("museum-dark");
      await theme("light");
      await page.getByTestId("museum-tab").click(); await visible("museum-placeholder"); await shot("museum-light");
      await page.getByTestId("mine-tab").click(); await visible("storage-link"); await shot("mine");
      await page.getByTestId("storage-link").click(); await visible("storage-preview");
      await page.waitForFunction(() => document.querySelector('[data-testid="storage-stats"]').children.length > 0);
      await shot("storage");
      await theme("light"); await shot("theme-settings");
      await page.getByTestId("font-scale").selectOption("1.3");
      assert.equal(await page.locator("html").evaluate(el => el.style.fontSize), "130%");
      await page.getByTestId("timeline-tab").click(); await visible("timeline-item"); await shot("large-font-light");
      await theme("dark"); await page.getByTestId("timeline-tab").click(); await shot("large-font-dark");
      await theme("light"); await page.getByTestId("font-scale").selectOption("1");
      await page.getByTestId("timeline-tab").click(); await page.getByTestId("edit-button").first().click();
      await page.getByTestId("reading-edit").click(); await visible("editor-body");
      await page.getByTestId("photo-caption").nth(1).fill("合成：选为封面后上移，说明随照片移动。");
      await page.getByTestId("photo-cover").nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="photo-cover"]')[1]?.getAttribute("aria-pressed") === "true");
      await page.getByTestId("photo-up").nth(1).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="photo-cover"]')?.getAttribute("aria-pressed") === "true");
      await page.getByTestId("editor-location").fill("合成地点 · 编辑后的窗边");
      await page.getByTestId("editor-mood").selectOption("开心");
      // Verify successful autosave and formal isolation before capturing the editor.
      await page.waitForFunction(async id => {
        const { MemoryAdapter } = await import("/platform/memory-adapter.js");
        const { PREVIEW_STORAGE_KEY } = await import("/ui/demo.js");
        const row = await new MemoryAdapter({ storage: localStorage, storageKey: PREVIEW_STORAGE_KEY }).getRecord(id);
        return row.draft?.location === "合成地点 · 编辑后的窗边" && row.draft?.mood === "开心"
          && row.draft.photos[0].caption === "合成：选为封面后上移，说明随照片移动。"
          && row.draft.coverPhotoUseId === row.draft.photos[0].photoUseId
          && row.formal.location === "合成地点 · 窗边" && row.formal.mood === "平静"
          && row.formal.photos[0].photoUseId !== row.draft.photos[0].photoUseId;
      }, recordId);
      await page.getByTestId("editor-title").scrollIntoViewIfNeeded(); await shot("editor-fields");
      // Desktop .main scrolls independently; capture the photo controls explicitly too.
      await page.getByTestId("photo-caption").first().scrollIntoViewIfNeeded(); await shot("editor-photos");
      await page.getByTestId("mine-tab").click(); await page.getByTestId("privacy-link").click();
      await visible("lock-enable"); await shot("app-lock-settings");
      // Disposable synthetic preview code, never a real credential or keystore.
      await page.getByTestId("lock-new").fill("482615"); await page.getByTestId("lock-confirm").fill("482615");
      await page.getByTestId("lock-enable").click(); await visible("lock-now");
      await page.getByTestId("lock-now").click();
      await page.getByRole("dialog", { name: "应用锁", exact: true }).waitFor(); await shot("lock-screen");
    } finally { await context.close(); }
  }
  assert.deepEqual([...saved].sort(), [...expected].sort(), "incomplete screenshot matrix");
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
finally {
  try { if (browser) await browser.close(); } catch (error) { failure ??= error; }
  try { if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (error) { failure ??= error; }
  // A failed rerun cannot validate stale PNGs: only this run's saved list counts.
  await writeFile(join(out, "screenshots-result.json"), JSON.stringify({ status: failure ? "FAILED" : "PASS",
    source: "MemoryAdapter / synthetic fixtures / browser preview, not native devices",
    expected, saved, errors, error: failure ? String(failure) : null }, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`PASS: ${saved.length} synthetic screenshots, page errors: ${errors.length}`);
