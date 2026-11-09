import test from "node:test";
import assert from "node:assert/strict";
import { isValidDate, isValidTime, validateForCommit } from "../src/domain/rules.ts";
import type { Snapshot } from "../src/domain/types.ts";

function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    title: "",
    body: "",
    eventDate: "2026-11-09",
    eventTime: null,
    photos: [],
    ...partial,
  };
}

test("AC-U0-02 仅标题草稿被拒绝，提示缺正文或照片", () => {
  const issue = validateForCommit(snapshot({ title: "只有标题" }));
  assert.equal(issue?.code, "EMPTY_CONTENT");
  assert.match(issue?.message ?? "", /缺少正文或照片/);
});

test("非空正文可提交", () => {
  assert.equal(validateForCommit(snapshot({ body: "一段正文" })), null);
});

test("仅照片（正文为空）可提交", () => {
  const issue = validateForCommit(
    snapshot({
      photos: [
        {
          photoUseId: "pu-000001",
          assetId: "ast-0123456789abcdef",
          caption: "",
          sha256: "a".repeat(64),
          bytes: 10,
          mediaType: "image/png",
        },
      ],
    }),
  );
  assert.equal(issue, null);
});

test("缺少或非法事件日期被拒绝", () => {
  assert.equal(validateForCommit(snapshot({ eventDate: "", body: "x" }))?.code, "MISSING_EVENT_DATE");
  assert.equal(
    validateForCommit(snapshot({ eventDate: "2026-02-30", body: "x" }))?.code,
    "INVALID_EVENT_DATE",
  );
});

test("空白 eventTime 合法且不被视为已填", () => {
  assert.equal(validateForCommit(snapshot({ body: "x", eventTime: "   " })), null);
});

test("非法 eventTime 被拒绝", () => {
  assert.equal(validateForCommit(snapshot({ body: "x", eventTime: "24:00" }))?.code, "INVALID_EVENT_TIME");
});

test("日期/时刻校验与 Rust 规则一致", () => {
  assert.equal(isValidDate("2024-02-29"), true);
  assert.equal(isValidDate("2026-02-29"), false);
  assert.equal(isValidDate("2026-11-09"), true);
  assert.equal(isValidTime("23:59"), true);
  assert.equal(isValidTime("9:30"), false);
});
