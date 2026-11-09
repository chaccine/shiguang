#!/usr/bin/env node
// 机器校验 Unit-0 验收产物；只用合成数据，失败即非零退出。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidence = join(root, "evidence");
const acc = join(evidence, "acceptance");
const data = join(acc, "data");
const media = join(data, "media");

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL  ${message}`);
  }
}

function read(name) {
  return JSON.parse(readFileSync(join(acc, name), "utf8"));
}
function readRaw(name) {
  return readFileSync(join(acc, name), "utf8");
}
function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function errCode(name) {
  return read(`${name}.err`).code;
}
function byId(list, id) {
  return list.records.find((record) => record.recordId === id);
}

// AC-U0-02：仅标题 / 缺日期均被拒绝
ok(errCode("commit-title-rejected.json") === "EMPTY_CONTENT", "仅标题提交应返回 EMPTY_CONTENT");
ok(
  readRaw("commit-title-rejected.json.err").includes("缺少正文或照片"),
  "仅标题拒绝文案应提示缺正文或照片",
);
ok(errCode("commit-no-date-rejected.json") === "MISSING_EVENT_DATE", "缺日期提交应返回 MISSING_EVENT_DATE");
ok(read("title-draft.json").record.formal === null, "被拒绝的标题草稿不得变成正式记录");

// AC-U0-03：重启前后一致
const before = read("draft-before-restart.json");
const after = read("draft-after-restart.json");
ok(before.draftContentHash === after.draftContentHash, "重启前后草稿内容 hash 必须一致");
ok(before.record.draft.body === after.record.draft.body, "重启前后草稿正文必须一致");
ok(after.record.formal === null && after.record.contentRevision === 0, "草稿状态不得为已正式");

const killLog = JSON.parse(readRaw("draft-kill.log"));
const afterKill = read("draft-after-kill.json");
ok(killLog.draftContentHash === afterKill.draftContentHash, "SIGKILL 后草稿 hash 必须与落盘时一致");
ok(afterKill.record.draft.body === "强杀前的正文（已落盘）", "SIGKILL 后草稿正文必须完整");

// AC-U0-04：正式提交
const commitFirst = read("commit-first.json");
const formalAfter = read("formal-after-commit.json");
ok(commitFirst.contentRevision === 1, "首次提交 contentRevision 应为 1");
ok(formalAfter.record.formal !== null, "提交后应有正式快照");
ok(formalAfter.record.draft === null, "提交后草稿应被清理");
ok(formalAfter.record.contentRevision === 1, "提交后 revision 应持久化");
ok(
  formalAfter.record.formal.body === "强杀前的正文（已落盘）",
  "正式快照必须与提交前草稿一致",
);

// AC-U0-05：正式列表排除草稿
const pureDraft = read("pure-draft.json");
const listAfterDraft = read("list-after-pure-draft.json");
ok(listAfterDraft.records.length === 1, "正式列表应只有 1 条正式记录");
ok(!byId(listAfterDraft, pureDraft.record.recordId), "纯草稿不得出现在正式列表");
ok(!byId(listAfterDraft, read("title-draft.json").record.recordId), "被拒绝草稿不得出现在正式列表");
ok(
  listAfterDraft.records.every((record) => typeof record.body === "string" && record.body.length > 0),
  "正式列表条目应来自正式快照",
);

// AC-U0-06：两张合成图、独立 caption、可核对 SHA
const photoA = read("photo-a.json").photo;
const photoB = read("photo-b.json").photo;
const fixtureA = read("fixture-a.json");
const fixtureB = read("fixture-b.json");
ok(photoA.photoUseId !== photoB.photoUseId, "两个 photoUseId 必须独立");
ok(photoA.assetId !== photoB.assetId, "不同原图应生成不同 assetId");
ok(photoA.caption === "第一张：窗外的光" && photoB.caption === "第二张：桌上的茶", "caption 必须独立保存");
ok(photoA.sha256 === fixtureA.sha256, "photoUse 记录的 SHA 应等于合成图 SHA");
ok(photoB.sha256 === fixtureB.sha256, "第二张合成图 SHA 应一致");
ok(sha(join(media, `${photoA.assetId}.png`)) === photoA.sha256, "落盘原图 SHA 必须可核对");
const photoCommit = read("photo-commit.json");
ok(photoCommit.contentRevision === 1, "带图提交 revision 应为 1");
const listWithPhotos = read("list-with-photos.json");
const photoItem = byId(listWithPhotos, photoCommit.recordId);
ok(photoItem.photos.length === 2, "正式记录应保留 2 个 photoUse");
ok(photoItem.photos[0].caption !== photoItem.photos[1].caption, "正式记录中的 caption 仍应独立");

// AC-U0-07：清预览不删原图，可重建
const previewBefore = readRaw("previews-before-clear.sha");
const previewAfter = readRaw("previews-after-rebuild.sha");
ok(previewBefore.split("\n").filter(Boolean).length === 2, "应生成 2 个派生预览");
ok(previewBefore === previewAfter, "删除预览后重建结果必须一致");
const assetsBefore = read("assets-before-clear.json").assets;
const assetsLost = read("assets-after-preview-loss.json").assets;
const assetsRebuilt = read("assets-after-rebuild.json").assets;
const assetKey = (assets) => assets.map((a) => `${a.assetId}:${a.sha256}`).sort().join(",");
ok(assetKey(assetsBefore) === assetKey(assetsLost), "清预览后原图清单必须不变");
ok(assetKey(assetsBefore) === assetKey(assetsRebuilt), "重建预览后原图清单必须不变");
ok(read("photo-after-preview-loss.json").record.formal !== null, "清预览后正式记录仍可读");

// AC-U0-08：修改草稿不覆盖正式阅读
const editId = read("edit-draft.json").record.recordId;
const pendingList = read("list-with-pending-edit.json");
const pendingItem = byId(pendingList, editId);
ok(pendingItem.body === "编辑前的正式正文", "有待提交草稿时列表应显示旧正式正文");
ok(pendingItem.hasPendingDraft === true, "列表应标记存在未提交草稿");
const pendingGet = read("edit-pending-get.json");
ok(pendingGet.record.formal.body === "编辑前的正式正文", "阅读正式版不得被草稿覆盖");
ok(pendingGet.record.draft.body === "尚未提交的修改", "修改草稿应独立保存");
ok(pendingGet.record.contentRevision === 1, "未提交前 revision 不得变化");

// AC-U0-09：再次提交后单一条目、ID 稳定
const editSecond = read("edit-second-commit.json");
ok(editSecond.recordId === editId, "编辑提交后 recordId 必须稳定");
ok(editSecond.contentRevision === 2, "编辑提交后 revision 应递增为 2");
const afterEdit = read("list-after-edit-commit.json");
const edited = byId(afterEdit, editId);
ok(edited.body === "尚未提交的修改", "提交后正式内容应更新");
ok(edited.contentRevision === 2, "列表 revision 应为 2");
ok(afterEdit.records.filter((r) => r.recordId === editId).length === 1, "时间轴不得出现重复条目");
ok(afterEdit.records.length === 3, "此阶段正式列表应为 3 条（不含任何草稿）");

// AC-U0-10：未来日期且无时刻
const future = read("future-get.json").record.formal;
ok(future.eventDate === "2099-12-31", "eventDate 必须保存为 YYYY-MM-DD");
ok(future.eventTime === null, "缺失 eventTime 必须保持 null");
ok(!JSON.stringify(future).includes("00:00"), "不得为缺失时刻伪造 00:00");

// 持久化完整性
const dump = read("dump.json").state;
const formalRows = dump.records.filter((row) => row.formal !== null);
ok(formalRows.length === 4, "state.json 中正式记录应为 4 条");
ok(dump.records.every((row) => !(row.formal === null && row.draft === null)), "不得存在空记录");
const pureRow = dump.records.find((row) => row.recordId === pureDraft.record.recordId);
ok(pureRow.formal === null, "state.json 中纯草稿仍不得有正式快照");
const leftovers = readdirSync(data).filter((name) => name.startsWith(".tmp-"));
ok(leftovers.length === 0, "数据目录不得残留临时文件");
ok(existsSync(join(data, "state.json")), "state.json 必须存在");

// AC-U0-11：manifest
const manifest = JSON.parse(readFileSync(join(evidence, "manifest.json"), "utf8"));
ok(manifest.records.length === 4, "manifest 应包含全部 4 条正式记录");
ok(manifest.platform.seed === "20261109", "manifest 应记录固定 seed");
ok(manifest.platform.rustc.length > 0 && manifest.platform.node.length > 0, "manifest 应包含平台版本");
ok(manifest.assets.length === 2, "manifest 应记录 2 个原图 asset");
ok(
  manifest.records.every((record) =>
    record.photos.every((photo) => manifest.assets.some((asset) => asset.assetId === photo.assetId && asset.sha256 === photo.sha256)),
  ),
  "manifest 中 photoUse 的 asset SHA 必须与 asset 清单一致",
);
for (const asset of manifest.assets) {
  ok(sha(join(data, asset.file)) === asset.sha256, `manifest asset 文件 SHA 必须可核对：${asset.file}`);
}

console.log(`verify-evidence: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
