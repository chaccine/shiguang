import type { ShiguangApi } from "../platform/api.ts";

/** Observe successful authority writes, never autosaves or attempted/failed writes.
 * No cache, second dictionary or alternate mutation path is introduced. */
const sourceWrites = new Set<keyof ShiguangApi>([
  "commitRecord", "setFavorite", "setRecordTags", "createTag", "renameTag", "mergeTags", "deleteTag",
  "trashRecord", "restoreRecord", "purgeRecord", "emptyTrash", "restoreBackup", "mergeBackup",
]);

export function searchAwareApi(api: ShiguangApi, changed: () => void): ShiguangApi {
  return new Proxy(api, {
    get(target, property: keyof ShiguangApi) {
      const method = target[property];
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(method, target, args);
        if (sourceWrites.has(property)) changed();
        return result;
      };
    },
  });
}
