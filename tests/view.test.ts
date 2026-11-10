import test from "node:test";
import assert from "node:assert/strict";
import { formatEventWhen } from "../src/domain/format.ts";
import { applyCommit, formalItems, nextRevision, readFormal } from "../src/domain/view.ts";
import type { RecordRow, Snapshot } from "../src/domain/types.ts";

function snap(partial: Partial<Snapshot> = {}): Snapshot {
  return { title: "", body: "", eventDate: "2026-11-09", eventTime: null, photos: [], ...partial };
}

function row(partial: Partial<RecordRow> = {}): RecordRow {
  return {
    status: "active",
    trashedAt: null,
    recordId: "rec-000001",
    contentRevision: 0,
    createdAt: "2026-11-09T10:00:00Z",
    updatedAt: "2026-11-09T10:00:00Z",
    committedAt: null,
    baseRevision: 0,
    formal: null,
    draft: null,
    favorite: false, favoriteRevision: 0, tagIds: [], tagRevision: 0, // Unit-0.7 新字段（仅构造方式调整）
    ...partial,
  };
}

test("AC-U0-05 正式列表排除纯草稿", () => {
  const rows = [
    row({ recordId: "rec-000001", formal: snap({ body: "正式" }), contentRevision: 1, committedAt: "2026-11-09T10:00:00Z" }),
    row({ recordId: "rec-000002", draft: snap({ body: "草稿" }) }),
  ];
  const items = formalItems(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.recordId, "rec-000001");
  assert.equal(items[0]?.body, "正式");
});

test("AC-U0-08 修改草稿不覆盖正式阅读视图", () => {
  const rows = [
    row({
      recordId: "rec-000001",
      contentRevision: 1,
      committedAt: "2026-11-09T10:00:00Z",
      formal: snap({ body: "原始正式正文" }),
      draft: snap({ body: "尚未提交的新正文" }),
    }),
  ];
  const items = formalItems(rows);
  assert.equal(items[0]?.body, "原始正式正文");
  assert.equal(items[0]?.hasPendingDraft, true);
  assert.equal(readFormal(rows[0]!)?.body, "原始正式正文");
});

test("AC-U0-09 提交编辑后单一条目、ID 稳定、revision 递增", () => {
  const base = row({
    recordId: "rec-000001",
    contentRevision: 1,
    committedAt: "2026-11-09T10:00:00Z",
    formal: snap({ body: "第一版" }),
    draft: snap({ body: "第二版" }),
  });
  assert.equal(nextRevision(base), 2);
  const updated = applyCommit(base, {
    recordId: "rec-000001",
    contentRevision: 2,
    committedAt: "2026-11-09T11:00:00Z",
    durability: "durable",
  });
  const items = formalItems([updated]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.recordId, "rec-000001");
  assert.equal(items[0]?.contentRevision, 2);
  assert.equal(items[0]?.body, "第二版");
  assert.equal(items[0]?.hasPendingDraft, false);
});

test("AC-U0-10 缺时刻只显示日期，不伪造 00:00", () => {
  assert.equal(formatEventWhen({ eventDate: "2099-12-31", eventTime: null }), "2099-12-31");
  assert.equal(formatEventWhen({ eventDate: "2099-12-31", eventTime: "   " }), "2099-12-31");
  assert.equal(formatEventWhen({ eventDate: "2099-12-31", eventTime: "08:05" }), "2099-12-31 08:05");
  assert.ok(!formatEventWhen({ eventDate: "2099-12-31", eventTime: null }).includes("00:00"));
});

test("正式列表按事件日期倒序排列", () => {
  const rows = [
    row({ recordId: "rec-000001", formal: snap({ eventDate: "2026-11-01" }), committedAt: "2026-11-09T10:00:00Z" }),
    row({ recordId: "rec-000002", formal: snap({ eventDate: "2026-11-08" }), committedAt: "2026-11-09T09:00:00Z" }),
    row({ recordId: "rec-000003", formal: snap({ eventDate: "2026-11-08" }), committedAt: "2026-11-09T11:00:00Z" }),
  ];
  assert.deepEqual(
    formalItems(rows).map((item) => item.recordId),
    ["rec-000003", "rec-000002", "rec-000001"],
  );
});
