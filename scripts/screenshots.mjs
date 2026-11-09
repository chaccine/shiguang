// Unit-0.2 视觉证据：浏览器预览模式（MemoryAdapter，合成数据）下的流程截图。
// 依赖：工程内 devDependency playwright-core + 本机已有 Chrome（CHROME_PATH，默认 /usr/bin/google-chrome）。
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startPreviewServer } from "./preview-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "evidence", "unit-0.2");
await mkdir(out, { recursive: true });
const port = 14200 + Math.floor(Math.random() * 500);
const server = await startPreviewServer(port);
const base = `http://127.0.0.1:${port}/`;

// 合成 PNG：暖色渐变 + 斜纹，纯代码生成。
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function syntheticPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; const s = ((x + y) >> 4) % 2 ? 0 : 24; raw[o] = Math.min(255, r + s + (y >> 2)); raw[o + 1] = Math.min(255, g + s); raw[o + 2] = Math.max(0, b - (x >> 3)); } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const shot = async (name) => { await page.waitForTimeout(600); const p = join(out, name); await page.screenshot({ path: p, fullPage: false }); results.push(p); };

  // 1 草稿列表（合成示例数据）
  await page.goto(`${base}?demo=1`);
  await page.getByTestId("draft-item").first().waitFor();
  await shot("01-drafts.png");

  // 2 编辑草稿：输入正文 + 附加合成照片 → 自动保存
  await page.getByTestId("draft-item").first().click();
  await page.getByTestId("editor-title").fill("周日下午的旧书店");
  await page.getByTestId("editor-body").fill("在巷子口的旧书店翻到一本 1987 年的诗集，扉页上有铅笔写的日期。老板说这本书在架子上待了十年，今天终于等到人。");
  await page.getByTestId("photo-input").setInputFiles([
    { name: "bookshop.png", mimeType: "image/png", buffer: syntheticPng(160, 120, [196, 140, 92]) },
    { name: "window.png", mimeType: "image/png", buffer: syntheticPng(160, 120, [120, 150, 170]) },
  ]);
  await page.getByTestId("photo-thumb").nth(1).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent?.includes("已自动保存"), null, { timeout: 10000 });
  await shot("02-editor-autosaved.png");

  // 3 模拟重启：重新加载（不带 demo），应恢复上次草稿
  await page.goto(base);
  await page.waitForFunction(() => document.body.innerText.includes("恢复"), null, { timeout: 10000 });
  await shot("03-restart-recovered.png");

  // 4 存入时光 → 时光列表
  await page.getByTestId("commit-button").click();
  await page.getByTestId("timeline-item").first().waitFor();
  await page.waitForTimeout(300);
  await shot("04-timeline.png");

  // 5 冲突：注入 REVISION_CONFLICT，确认中文提示且草稿保留
  await page.goto(`${base}?demo=1&fail=conflict`);
  await page.getByTestId("draft-item").first().click();
  await page.getByTestId("editor-body").fill("这条草稿用来演示版本冲突：存入时被拒绝，本地内容仍在。");
  await page.getByTestId("commit-button").click();
  await page.waitForFunction(() => /冲突|别处/.test(document.body.innerText), null, { timeout: 10000 });
  await shot("05-conflict.png");

  // 6 落盘未确认：durability uncertain
  await page.goto(`${base}?demo=1&fail=uncertain`);
  await page.getByTestId("draft-item").first().click();
  await page.getByTestId("editor-body").fill("这条草稿演示：系统没有确认写入磁盘时，界面会如实提示。");
  await page.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent?.includes("未确认"), null, { timeout: 10000 });
  await shot("06-durability-uncertain.png");

  await writeFile(join(out, "screenshots.log"), [`page errors: ${errors.length}`, ...errors, ...results.map((r) => `saved ${r}`)].join("\n") + "\n");
  if (errors.length) throw new Error(`页面报错 ${errors.length} 个：${errors.join("; ")}`);
} finally {
  await browser.close();
  server.close();
}
console.log(results.join("\n"));
