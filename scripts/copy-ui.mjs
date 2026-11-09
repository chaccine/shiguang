import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const source = join(root, "src", "ui", "index.html");
const target = join(root, "dist", "index.html");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`copied ${source} -> ${target}`);
