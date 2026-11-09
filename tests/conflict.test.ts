import test from "node:test";
import assert from "node:assert/strict";
import { conflictMessage } from "../src/domain/format.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";

test("提交传递草稿基线，结构化冲突显示保留草稿提示", async () => {
  const conflict = {
    code: "REVISION_CONFLICT",
    stage: "commit",
    message: "期望正式版本 1，实际正式版本 2",
  };
  const api = createTauriApi(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    assert.equal(command, "commit_record");
    assert.deepEqual(args, { recordId: "rec-000001", expectedBaseRevision: 1 });
    throw conflict;
  });
  await assert.rejects(api.commitRecord("rec-000001", 1), (error: unknown) => {
    assert.equal(error, conflict);
    assert.equal(conflictMessage(error), "正文已在别处更新，本地草稿已保留，未覆盖正式版");
    return true;
  });
});

test("其它错误不显示版本冲突提示", () => {
  for (const error of [null, undefined, "REVISION_CONFLICT", new Error("读取失败"), { code: "ASSET_MISSING" }]) {
    assert.equal(conflictMessage(error), null);
  }
});
