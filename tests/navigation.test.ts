import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAV_TABS, initialTab, tabOf, rememberableTab, visibleTabs, timelineEmptyKind, type View,
} from "../src/domain/navigation.ts";

test("默认打开时光轴（无参数、无上次页签）", () => {
  assert.equal(initialTab(), "timeline");
  assert.equal(initialTab({ param: null, lastTab: null }), "timeline");
});

test("显式预览参数优先；每次正常启动默认时光轴", () => {
  assert.equal(initialTab({ param: "calendar", lastTab: "drafts" }), "calendar");
  assert.equal(initialTab({ lastTab: "collect" }), "timeline");
  assert.equal(initialTab({ param: "editor", lastTab: "trash" }), "timeline");
  assert.equal(initialTab({ param: "garbage" }), "timeline");
  assert.equal(initialTab({ param: "data" }), "settings");
});

test("五个一级页签：时光轴 / 日历 / ＋记录 / 博物馆 / 我的", () => {
  assert.deepEqual(NAV_TABS.map((t) => t.label), ["时光轴", "日历", "＋记录", "博物馆", "我的"]);
  assert.equal(new Set(NAV_TABS.map((t) => t.testId)).size, 5);
});

test("零记录零草稿时，每个视图都显示全部五个页签（无死路）", () => {
  const views: View[] = ["timeline", "calendar", "drafts", "collect", "settings", "editor", "trash"];
  for (const data of [{ formalCount: 0, draftCount: 0 }, { formalCount: 3, draftCount: 0 }, { formalCount: 0, draftCount: 2 }]) {
    for (const v of views) assert.equal(visibleTabs(v, data).length, 5, `${v} ${JSON.stringify(data)}`);
  }
});

test("二级视图高亮所属页签，且不记为上次页签", () => {
  assert.equal(tabOf("editor"), "create");
  assert.equal(tabOf("trash"), "mine");
  assert.equal(rememberableTab("editor"), null);
  assert.equal(rememberableTab("trash"), null);
  assert.equal(rememberableTab("calendar"), "calendar");
});

test("时光轴空态区分：一条没有 vs 筛选为空", () => {
  assert.equal(timelineEmptyKind(0, 0), "no-entries");
  assert.equal(timelineEmptyKind(0, 4), "filtered-empty");
  assert.equal(timelineEmptyKind(2, 4), "none");
});
