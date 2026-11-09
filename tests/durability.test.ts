import test from "node:test";
import assert from "node:assert/strict";
import { durabilityLabel } from "../src/domain/format.ts";
import type { CommitResult } from "../src/domain/types.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";

test("uncertain 提交结果保留目录同步未确认提示", async () => {
  const result: CommitResult = {
    recordId: "rec-000001",
    contentRevision: 1,
    committedAt: "2026-11-09T10:00:00Z",
    durability: "uncertain",
  };
  const api = createTauriApi(async <T>(command: string): Promise<T> => {
    assert.equal(command, "commit_record");
    return result as T;
  });
  const committed = await api.commitRecord(result.recordId, 0);
  const status = durabilityLabel(committed.durability);
  assert.equal(status, "已保存，但系统未确认写入磁盘");
  assert.notEqual(status, "已安全保存");
});

test("durability 文案区分系统目录同步支持情况", () => {
  assert.equal(durabilityLabel("durable"), "已保存");
  assert.equal(durabilityLabel("parentSyncUnsupported"), "已保存（系统未提供目录同步确认）");
});
