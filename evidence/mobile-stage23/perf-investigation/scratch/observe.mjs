import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { installRegistry } from "./lifecycle.mjs";

const dir = process.env.MUSEUM_PERF_RUN;
if (installRegistry(dir)) {
  const profile = process.execArgv.some(arg => arg.endsWith("/profile.mjs"));
  const { install } = await import("./target.mjs");
  const { testFile, profileFiles, instrumentTest, instrumentProfile } = await import("./hooks.mjs");
  install(dir, profile);
  const urls = new Map((profile ? [testFile, ...profileFiles] : [testFile])
    .map(file => [pathToFileURL(resolve(file)).href, file]));
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    const file = urls.get(url);
    if (!file) return loaded;
    const source = Buffer.from(loaded.source).toString("utf8");
    return { ...loaded, source: file === testFile ? instrumentTest(source) : instrumentProfile(file, source) };
  } });
}
