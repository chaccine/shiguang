// Browser/device follow-up for Task C. Synthetic data only; every request is fulfilled
// from dist in-process. No HTTP listener, network fetch, new dependency or cloud service.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const output = resolve(process.env.SHIGUANG_A11Y_OUT ?? "/tmp/shiguang-task-c-browser");
const origin = "http://127.0.0.1:1420";
const mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"};
const errors = [], captures = [], checks = [];
let browser, failure, launched = false;
await mkdir(output, {recursive: true});
try {
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crashpad-for-testing"]});
  launched = true;
  for (const [layout, viewport] of [["mobile", {width: 320, height: 844}], ["desktop", {width: 1280, height: 960}]]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({viewport, colorScheme: theme, reducedMotion: "reduce", locale: "zh-CN"});
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin, "unexpected external request");
        const path = resolve(dist, `.${decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
        assert.ok(path.startsWith(`${dist}/`));
        try { await route.fulfill({body: await readFile(path), contentType: mime[extname(path)] ?? "application/octet-stream"}); }
        catch { await route.fulfill({status: 404, body: "not found"}); }
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(`${origin}/?demo=1`);
      await page.waitForFunction(() => document.body.dataset.appReady === "1");
      await page.getByTestId("mine-tab").click(); await page.getByTestId("appearance-link").click();
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await page.waitForFunction(t => document.documentElement.dataset.themePreference === t, theme);
      await page.evaluate(() => history.replaceState(null, "", "/"));
      await page.reload(); await page.waitForFunction(() => document.body.dataset.appReady === "1");
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      checks.push(`${layout}/${theme}: preference survives reload`);

      const audit = async name => {
        const result = await page.evaluate(() => {
          const visible = element => {const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden";};
          const controls = [...document.querySelectorAll("button, input, select, textarea, a")].filter(e => visible(e) && !e.closest("[inert]"));
          const small = controls.filter(e => {const r = e.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9;}).map(e => [e.getAttribute("data-testid") ?? e.className, e.getBoundingClientRect().toJSON()]);
          const unnamed = controls.filter(e => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.textContent.trim() && !e.labels?.length).map(e => e.outerHTML);
          const alteredPhotos = [...document.querySelectorAll("img")].filter(visible).filter(e => getComputedStyle(e).filter !== "none" || getComputedStyle(e).opacity !== "1").map(e => e.outerHTML);
          return {small, unnamed, alteredPhotos, overflow: document.documentElement.scrollWidth > innerWidth + 1,
            nav: document.querySelectorAll('nav button[aria-current="page"]').length,
            moving: document.getAnimations().filter(a => a.playState === "running").length};
        });
        assert.deepEqual(result.small, [], `${name}: undersized targets`);
        assert.deepEqual(result.unnamed, [], `${name}: unnamed controls`);
        assert.deepEqual(result.alteredPhotos, [], `${name}: photo colors`);
        assert.equal(result.overflow, false, `${name}: page overflow`);
        assert.equal(result.nav, 1); assert.equal(result.moving, 0);
        checks.push(name);
        await page.screenshot({path: join(output, `${name}.png`), fullPage: true}); captures.push(`${name}.png`);
      };
      for (const scale of [100, 200]) {
        await page.evaluate(s => {document.documentElement.style.fontSize = `${s}%`;}, scale);
        const prefix = `${layout}-${theme}-${scale}`;
        await page.getByTestId("timeline-tab").click(); await audit(`${prefix}-timeline`);
        await page.getByTestId("favorite-toggle").first().focus();
        await page.keyboard.press("Tab");
        assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 3), "keyboard focus ring");
        await page.getByTestId("manage-tags").click();
        assert.equal(await page.getByRole("dialog", {name: "管理标签", exact: true}).count(), 1);
        await audit(`${prefix}-dialog`); await page.keyboard.press("Escape");
        await page.getByTestId("edit-button").first().click(); await audit(`${prefix}-reading`);
        await page.getByTestId("calendar-tab").click(); await audit(`${prefix}-calendar`);
        const day = page.getByTestId("cal-day").first(); await day.focus(); await page.keyboard.press("Enter");
        assert.equal(await day.getAttribute("aria-pressed"), "true");
        await page.getByTestId("museum-tab").click(); await audit(`${prefix}-museum`);
        await page.getByTestId("mine-tab").click(); await page.getByTestId("appearance-link").click(); await audit(`${prefix}-appearance`);
        await page.getByTestId("create-tab").click(); await audit(`${prefix}-editor`);
      }
      await page.getByTestId("mine-tab").click(); await page.getByTestId("appearance-link").click();
      await page.getByTestId("theme-select").selectOption("system");
      await page.waitForFunction(() => document.documentElement.dataset.themePreference === "system");
      await page.emulateMedia({colorScheme: "dark"}); await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
      await page.emulateMedia({colorScheme: "light"}); await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
      checks.push(`${layout}/${theme}: live system preference`);
      await page.getByTestId("theme-select").selectOption(theme);
      await page.waitForFunction(t => document.documentElement.dataset.themePreference === t, theme);
      await page.getByTestId("mine-tab").click(); await page.getByTestId("privacy-link").click();
      await page.getByTestId("lock-new").fill("482615"); await page.getByTestId("lock-confirm").fill("482615");
      await page.getByTestId("lock-enable").click(); await page.getByTestId("lock-now").waitFor({state: "visible"});
      await page.getByTestId("lock-now").click();
      assert.equal(await page.getByRole("dialog", {name: "应用锁", exact: true}).count(), 1);
      await page.getByTestId("app-unlock").focus(); await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "app-passcode");
      await audit(`${layout}-${theme}-200-lock`);
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
finally {
  if (browser) await browser.close();
  await writeFile(join(output, "result.json"), JSON.stringify({status: failure ? (launched ? "FAILED" : "BLOCKED") : "PASS", checks, captures, errors, error: failure ? String(failure) : null}, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`PASS ${checks.length} browser checks; ${captures.length} synthetic captures in ${output}`);
