import test from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/domain/errors.ts";

test("冲突中文提示保留草稿并要求核对，不自动选赢家", () => {
  const result = describeError({ code: "REVISION_CONFLICT", stage: "commit", message: "合成版本差异" });
  assert.equal(result.kind, "conflict"); assert.match(result.detail, /本地草稿已保留/); assert.match(result.detail, /未覆盖正式版/);
  assert.match(result.detail, /核对/); assert.match(result.detail, /REVISION_CONFLICT \/ commit/);
});

test("durability uncertain 与系统不支持同步分开提示", () => {
  for (const error of ["uncertain", { durability: "uncertain" }]) {
    const result = describeError(error); assert.equal(result.kind, "durability");
    assert.match(result.detail, /已写入/); assert.match(result.detail, /没有确认落盘/); assert.match(result.detail, /不要断电/);
  }
  assert.equal(describeError("parentSyncUnsupported").title, "已保存");
  assert.equal(describeError({ durability: "parentSyncUnsupported" }).kind, "durability");
});

test("校验错误提供可操作中文和原始错误码", () => {
  for (const code of ["EMPTY_CONTENT", "MISSING_EVENT_DATE", "INVALID_EVENT_DATE", "INVALID_EVENT_TIME",
    "EMPTY_ASSET", "ASSET_TOO_LARGE", "INVALID_ASSET_NAME", "PREVIEW_TOO_LARGE", "PHOTO_USE_NOT_FOUND", "NOT_FOUND", "NO_DRAFT", "BASE_NOT_FORMAL"]) {
    const result = describeError({ code, message: "synthetic" });
    assert.equal(result.kind, "validation", code); assert.ok(result.detail.includes(code)); assert.match(result.detail, /[\u4e00-\u9fff]/);
  }
});

test("损坏状态明确原文件未覆盖，写入失败提供重试信息与阶段", () => {
  assert.match(describeError({ code: "STATE_CORRUPT" }).detail, /原文件没有被覆盖/);
  assert.equal(describeError({ code: "STATE_VERSION_UNSUPPORTED" }).kind, "io");
  for (const code of ["PERSIST_TEMP_CREATE_FAILED", "PERSIST_TEMP_WRITE_FAILED", "PERSIST_TEMP_SYNC_FAILED", "PERSIST_REPLACE_FAILED", "STATE_SERIALIZE_FAILED"]) {
    const result = describeError({ code, stage: "synthetic", message: "disk" });
    assert.equal(result.kind, "io"); assert.match(result.detail, /编辑内容仍保留/); assert.match(result.detail, /重试/);
    assert.match(result.detail, /synthetic/); assert.ok(result.detail.includes(code));
  }
});

test("原图安全校验与 IO 错误不吞掉细节", () => {
  for (const code of ["ASSET_MISSING", "ASSET_HASH_MISMATCH", "ASSET_SIZE_MISMATCH", "ASSET_READ_FAILED", "ASSET_CONFLICT", "IO_ERROR", "STORE_LOCK_FAILED"]) {
    const result = describeError({ code, message: "合成诊断细节" });
    assert.equal(result.kind, "io"); assert.ok(result.detail.includes(code)); assert.match(result.detail, /合成诊断细节/);
  }
});

test("未知及非结构化错误也给出失败说明和诊断", () => {
  for (const error of [null, undefined, "合成错误", new Error("合成异常"), { code: "FUTURE_ERROR", message: "合成信息" }]) {
    const result = describeError(error); assert.equal(result.kind, "unknown"); assert.equal(result.title, "操作未完成"); assert.ok(result.detail.length > 0);
  }
  assert.match(describeError(new Error("合成异常")).detail, /合成异常/);
  assert.match(describeError({ code: "FUTURE_ERROR", message: "合成信息" }).detail, /FUTURE_ERROR/);
});
