// Unit-0.3 视觉证据（浏览器预览模拟，非真机）：手机竖屏 390×844，模拟 Android 状态栏 36px / 手势条 20px。
// before：网页铺满整屏、状态栏盖在上面（edge-to-edge 未处理时的样子）。
// after ：按 MainActivity 的做法，网页区域让出系统栏高度（原生根视图 padding），系统栏背后为 #EAD9C6。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.3");
await mkdir(out, { recursive: true });
const port = 14800 + Math.floor(Math.random() * 500);
const server = await startPreviewServer(port);
const app = `http://127.0.0.1:${port}/?demo=1`;
const W = 390, H = 844, TOP = 36, BOTTOM = 20;
const statusBar = (bg) => `<div style="position:absolute;left:0;top:0;width:${W}px;height:${TOP}px;background:${bg};display:flex;align-items:center;justify-content:space-between;padding:0 18px;box-sizing:border-box;font:600 14px sans-serif;color:#222;z-index:2">
  <span>16:48</span><span>▮▮▮ 5G ◧ 82%</span></div>`;
const gesture = (bg) => `<div style="position:absolute;left:0;bottom:0;width:${W}px;height:${BOTTOM}px;background:${bg};z-index:2"><div style="width:120px;height:4px;border-radius:2px;background:#333;margin:8px auto"></div></div>`;
const frame = (top, h) => `<iframe src="${app}" style="position:absolute;left:0;top:${top}px;width:${W}px;height:${h}px;border:0"></iframe>`;
const pages = {
  "01-before-statusbar-overlap.png": `${frame(0, H)}${statusBar("rgba(255,255,255,0)")}${gesture("rgba(255,255,255,0)")}`,
  "02-after-insets-padding.png": `${frame(TOP, H - TOP - BOTTOM)}${statusBar("#EAD9C6")}${gesture("#EAD9C6")}`,
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const log = ["预览模拟（Chrome headless + MemoryAdapter 合成数据），不是真机截图。"];
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, locale: "zh-CN" });
  for (const [name, body] of Object.entries(pages)) {
    const page = await context.newPage();
    page.on("pageerror", (e) => log.push(`page error: ${e}`));
    // 包装页与应用同源（避免 about:blank 父页导致 iframe 存储受限）。
    const wrap = `http://127.0.0.1:${port}/__mobile-wrap.html`;
    await page.route(wrap, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body style="margin:0;position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000">${body}</body></html>` }));
    await page.goto(wrap);
    await page.frameLocator("iframe").locator('[data-testid="draft-item"]').first().waitFor();
    await page.waitForTimeout(600);
    const p = join(out, name);
    await page.screenshot({ path: p });
    log.push(`saved ${p}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(join(out, "screenshots.log"), log.join("\n") + "\n");
console.log(log.join("\n"));
