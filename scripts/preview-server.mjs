// 浏览器预览：只托管 dist/（npm run build 产物），绑定 127.0.0.1，无第三方依赖。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const port = Number(process.env.PORT ?? 1420);

export function startPreviewServer(listenPort = port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
    if (rel.startsWith("..")) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startPreviewServer();
  console.log(`拾光浏览器预览：http://127.0.0.1:${port}/?demo=1`);
}
