// Unit-0.8 / 0.1.9 browser evidence; all images and text are synthetic.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence/unit-0.9");
await mkdir(out, {recursive:true});
const errors = [], saved = [];
let server, browser, failure;
try {
  const port = 17000 + Math.floor(Math.random() * 500);
  server = await startPreviewServer(port);
  browser = await chromium.launch({executablePath:process.env.CHROME_PATH ?? "/usr/bin/google-chrome",headless:true});
  for (const [layout, viewport] of [["desktop",{width:1100,height:900}], ["mobile",{width:390,height:844}]]) {
    const context = await browser.newContext({viewport, locale:"zh-CN"});
    const page = await context.newPage();
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.body.dataset.appReady === "1");
    // Instrument the adapter prototype: a list must never ask for photoDataUrl.
    await page.evaluate(async () => {
      const {MemoryAdapter} = await import("/platform/memory-adapter.js");
      MemoryAdapter.prototype.photoDataUrl = async () => { throw new Error("Unexpected original request in list"); };
    });
    await page.getByTestId("write-first").click();
    await page.getByTestId("editor-body").fill("合成时光：写作时创建和设置标签。");
    await page.getByTestId("editor-date").fill("2026-11-11");
    const shot = async name => { await page.screenshot({path:join(out,name),fullPage:true}); saved.push(name); };
    await page.getByTestId("editor-tag-add").click();
    await page.getByTestId("tag-picker-new").fill("合成·写作中");
    await page.getByTestId("tag-picker-create").click();
    await page.getByTestId("tag-picker-status").filter({hasText:"已新建"}).waitFor();
    await shot(`${layout}-create-tag.png`);
    await page.getByTestId("tag-picker-save").click();
    await page.getByTestId("editor-tag-chip").filter({hasText:"合成·写作中"}).waitFor();
    await page.getByTestId("editor-tag-add").scrollIntoViewIfNeeded();
    if (layout === "mobile") {
      const button = await page.getByTestId("editor-tag-add").boundingBox();
      const tabs = await page.locator(".tabs").boundingBox();
      assert(button && tabs && button.y + button.height <= tabs.y, "editor tags must clear tab bar");
    }
    await shot(`${layout}-editor-tags.png`);
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width=1600; canvas.height=1200;
      const c=canvas.getContext("2d"); c.fillStyle="#e8ca8e"; c.fillRect(0,0,1600,1200);
      c.fillStyle="#718d63"; c.fillRect(300,200,800,700);
      return Array.from(Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c=>c.charCodeAt(0)));
    });
    await page.getByTestId("photo-input").setInputFiles({name:"synthetic.png",mimeType:"image/png",buffer:Buffer.from(png)});
    await page.getByTestId("photo-thumb").waitFor();
    await page.getByTestId("commit-button").click();
    await page.getByTestId("timeline-tab").click();
    await page.getByTestId("timeline-cover").first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="timeline-cover"]')].some(img => img.naturalWidth > 0 && img.naturalWidth <= 320));
    await shot(`${layout}-timeline-thumbnails.png`);
    // Create an intentionally undecodable HEIC through the same browser import path.
    await page.getByTestId("drafts-tab").click();
    await page.getByTestId("new-draft").click();
    await page.getByTestId("editor-body").fill("合成 HEIC，测试无法解码占位。");
    await page.getByTestId("editor-date").fill("2026-11-11");
    await page.getByTestId("photo-input").setInputFiles({name:"synthetic.heic",mimeType:"image/heic",buffer:Buffer.from([0,0,0,20,...Buffer.from("ftypheic"),0,0,0,0,0,0,0,0])});
    await page.getByText("无法预览 HEIC 图片",{exact:true}).waitFor();
    await shot(`${layout}-heic-placeholder.png`);
    await context.close();
  }
  assert.equal(errors.length,0);
} catch(e) { failure=e; }
finally {
  await writeFile(join(out,"screenshots.log"),`${failure ? "BLOCKED/FAILED" : "PASS"}\npage errors: ${errors.length}\n${errors.join("\n")}\n${saved.map(s=>`saved ${s}`).join("\n")}\n${failure ?? ""}\n`);
  if(browser) await browser.close();
  if(server) server.close();
}
if(failure) throw failure;
