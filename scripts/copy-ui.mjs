import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath：Windows 上 URL.pathname 会得到 /D:/... 导致路径错误
const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "src", "ui", "index.html");
const target = join(root, "dist", "index.html");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`copied ${source} -> ${target}`);
