//! Unit-0 验收测试（合成数据，固定 SHIGUANG_SEED=20261109）。
//!
//! 每个验收项对应一条或一组测试；脚本层再补充跨进程/强杀证据。

use shiguang_core::json::Json;
use shiguang_core::{preview, sha256, Store};
use std::fs;
use std::path::{Path, PathBuf};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(name: &str) -> Self {
        std::env::set_var("SHIGUANG_SEED", "20261109");
        std::env::set_var("SHIGUANG_CLOCK", "2026-11-09T10:00:00Z");
        let path = std::env::temp_dir().join(format!(
            "shiguang-acceptance-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&path);
        TempRoot(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_asset(dir: &Path, name: &str, seed: &str) -> PathBuf {
    let path = dir.join(name);
    fs::create_dir_all(dir).unwrap();
    fs::write(&path, preview::preview_bytes(seed)).unwrap();
    path
}

fn formal_ids(store: &Store) -> Vec<String> {
    store
        .list_formal()
        .iter()
        .map(|r| r.record_id.clone())
        .collect()
}

#[test]
fn ac_u0_02_title_only_draft_cannot_be_committed() {
    let tmp = TempRoot::new("title-only");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "只有标题", "", "2026-11-09", None)
        .unwrap();
    let err = store.commit(&row.record_id, 0).unwrap_err();
    assert_eq!(err.code, "EMPTY_CONTENT");
    assert!(err.message.contains("缺少正文或照片"));
    assert!(formal_ids(&store).is_empty());
    // 草稿仍在，且未被误标为正式
    let reloaded = Store::open(tmp.path()).unwrap();
    let row = reloaded.row(&row.record_id).unwrap();
    assert!(row.formal.is_none());
    assert!(row.committed_at.is_none());
    assert_eq!(row.content_revision, 0);
}

#[test]
fn ac_u0_02b_missing_or_invalid_date_is_rejected() {
    let tmp = TempRoot::new("bad-date");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store.create_draft(None, "", "正文", "", None).unwrap();
    assert_eq!(
        store.commit(&row.record_id, 0).unwrap_err().code,
        "MISSING_EVENT_DATE"
    );

    let row2 = store
        .create_draft(None, "", "正文", "2026-02-30", None)
        .unwrap();
    assert_eq!(
        store.commit(&row2.record_id, 0).unwrap_err().code,
        "INVALID_EVENT_DATE"
    );

    let row3 = store
        .create_draft(None, "", "正文", "2026-11-09", Some("25:00"))
        .unwrap();
    assert_eq!(
        store.commit(&row3.record_id, 0).unwrap_err().code,
        "INVALID_EVENT_TIME"
    );
    assert!(formal_ids(&store).is_empty());
}

#[test]
fn ac_u0_03_draft_survives_reopen_with_identical_hash() {
    let tmp = TempRoot::new("draft-restart");
    let (id, before_hash, before_body) = {
        let mut store = Store::open(tmp.path()).unwrap();
        let row = store
            .create_draft(None, "草稿标题", "重启前写入的正文", "2026-11-09", None)
            .unwrap();
        let draft = row.draft.unwrap();
        (row.record_id, draft.content_hash(), draft.body)
    }; // 模拟进程退出

    let store = Store::open(tmp.path()).unwrap();
    let row = store.row(&id).unwrap();
    let draft = row.draft.as_ref().expect("草稿必须仍在");
    assert_eq!(draft.body, before_body);
    assert_eq!(draft.content_hash(), before_hash);
    assert!(!row.is_formal());
    assert_eq!(row.content_revision, 0);
    assert!(formal_ids(&store).is_empty());
}

#[test]
fn ac_u0_04_commit_creates_formal_record_and_increments_revision() {
    let tmp = TempRoot::new("commit");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "第一次正式内容", "2026-11-08", None)
        .unwrap();
    assert_eq!(row.content_revision, 0);
    let outcome = store.commit(&row.record_id, 0).unwrap();
    assert_eq!(outcome.record_id, row.record_id);
    assert_eq!(outcome.content_revision, 1);

    let reloaded = Store::open(tmp.path()).unwrap();
    let row = reloaded.row(&outcome.record_id).unwrap();
    assert_eq!(row.content_revision, 1);
    assert!(row.draft.is_none(), "提交后草稿应被清理");
    assert!(row.committed_at.is_some());
    assert_eq!(row.formal.as_ref().unwrap().body, "第一次正式内容");
}

#[test]
fn ac_u0_05_formal_list_excludes_drafts() {
    let tmp = TempRoot::new("list");
    let mut store = Store::open(tmp.path()).unwrap();
    let formal = store
        .create_draft(None, "", "正式一", "2026-11-07", None)
        .unwrap();
    store.commit(&formal.record_id, 0).unwrap();
    let draft = store
        .create_draft(None, "", "纯草稿二", "2026-11-09", None)
        .unwrap();

    let ids = formal_ids(&store);
    assert_eq!(ids, vec![formal.record_id.clone()]);
    assert!(!ids.contains(&draft.record_id));

    // 重启后仍不出现
    let reloaded = Store::open(tmp.path()).unwrap();
    assert_eq!(formal_ids(&reloaded), vec![formal.record_id.clone()]);
    let listed = reloaded.list_formal();
    assert_eq!(listed[0].formal.as_ref().unwrap().body, "正式一");
}

#[test]
fn ac_u0_06_two_photos_independent_captions_and_sha_verifiable() {
    let tmp = TempRoot::new("photos");
    let assets_dir = tmp.path().join("input");
    let png_a = write_asset(&assets_dir, "a.png", "synthetic-a");
    let png_b = write_asset(&assets_dir, "b.png", "synthetic-b");

    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "两张合成图", "2026-11-06", None)
        .unwrap();
    let use_a = store
        .attach_photo(&row.record_id, &png_a, "第一张：窗外的光", None)
        .unwrap();
    let use_b = store
        .attach_photo(&row.record_id, &png_b, "第二张：桌上的茶", None)
        .unwrap();

    assert_ne!(use_a.photo_use_id, use_b.photo_use_id);
    assert_ne!(use_a.asset_id, use_b.asset_id);
    assert_eq!(use_a.caption, "第一张：窗外的光");
    assert_eq!(use_b.caption, "第二张：桌上的茶");

    // 原图 SHA 可核对
    for (use_ref, src) in [(&use_a, &png_a), (&use_b, &png_b)] {
        let stored = store.asset_path(&use_ref.asset_id).expect("原图已落盘");
        let bytes = fs::read(&stored).unwrap();
        assert_eq!(sha256::hex_digest(&bytes), use_ref.sha256);
        assert_eq!(
            sha256::hex_digest(&bytes),
            sha256::hex_digest(&fs::read(src).unwrap())
        );
        assert_eq!(bytes.len() as u64, use_ref.bytes);
    }

    let outcome = store.commit(&row.record_id, 0).unwrap();
    assert_eq!(outcome.content_revision, 1);
    let formal = store.formal(&row.record_id).unwrap();
    assert_eq!(formal.photos.len(), 2);
    assert_eq!(formal.photos[0].caption, "第一张：窗外的光");
    assert_eq!(formal.photos[1].caption, "第二张：桌上的茶");

    // 预览由原图派生，可生成
    let created = store
        .ensure_previews_with(|source, target| {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::copy(source, target)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(created.len(), 2);
    assert!(store.preview_path(&use_a.asset_id).exists());
    assert!(store.preview_path(&use_b.asset_id).exists());
}

#[test]
fn ac_u0_07_clearing_previews_keeps_assets_and_rebuilds_identically() {
    let tmp = TempRoot::new("preview");
    let png = write_asset(&tmp.path().join("input"), "p.png", "synthetic-preview");

    let (id, asset_id, before_assets) = {
        let mut store = Store::open(tmp.path()).unwrap();
        let row = store
            .create_draft(None, "", "预览缓存演练", "2026-11-05", None)
            .unwrap();
        let use_ref = store
            .attach_photo(&row.record_id, &png, "独立 caption", None)
            .unwrap();
        store.commit(&row.record_id, 0).unwrap();
        store
            .ensure_previews_with(|source, target| {
                fs::create_dir_all(target.parent().unwrap())?;
                fs::copy(source, target)?;
                Ok(())
            })
            .unwrap();
        (
            row.record_id,
            use_ref.asset_id,
            store.assets_on_disk().unwrap(),
        )
    };

    // 模拟“清缓存”：删除整个预览目录
    let preview_dir = tmp.path().join("previews");
    fs::remove_dir_all(&preview_dir).unwrap();

    let store = Store::open(tmp.path()).unwrap();
    assert!(!store.preview_path(&asset_id).exists());
    // 原图仍在、记录仍可读
    let after_assets = store.assets_on_disk().unwrap();
    assert_eq!(after_assets.len(), before_assets.len());
    assert_eq!(after_assets[0].sha256, before_assets[0].sha256);
    let formal = store.formal(&id).expect("记录仍可读");
    assert_eq!(formal.photos[0].caption, "独立 caption");

    // 重建预览，且内容确定
    let first = fs::read(store.asset_path(&asset_id).unwrap()).unwrap();
    let created = store
        .ensure_previews_with(|source, target| {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::copy(source, target)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(created, vec![asset_id.clone()]);
    let rebuilt = fs::read(store.preview_path(&asset_id)).unwrap();
    assert_eq!(rebuilt, first);
    // 再次清理重建结果一致
    store.clear_previews().unwrap();
    store
        .ensure_previews_with(|source, target| {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::copy(source, target)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(fs::read(store.preview_path(&asset_id)).unwrap(), first);
    // 原图没有被预览流程改写
    assert_eq!(
        store.assets_on_disk().unwrap()[0].sha256,
        before_assets[0].sha256
    );
}

#[test]
fn ac_u0_07b_missing_original_blocks_commit() {
    let tmp = TempRoot::new("missing-asset");
    let png = write_asset(&tmp.path().join("input"), "m.png", "synthetic-missing");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "", "2026-11-04", None)
        .unwrap();
    let use_ref = store
        .attach_photo(&row.record_id, &png, "会被删除的原图", None)
        .unwrap();
    let stored = store.asset_path(&use_ref.asset_id).unwrap();
    fs::remove_file(stored).unwrap();
    let err = store.commit(&row.record_id, 0).unwrap_err();
    assert_eq!(err.code, "ASSET_MISSING");
    assert!(store.formal(&row.record_id).is_none());
}

#[test]
fn ac_u0_08_pending_edit_draft_does_not_overwrite_formal_view() {
    let tmp = TempRoot::new("edit-draft");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "原标题", "原始正式正文", "2026-11-03", Some("09:30"))
        .unwrap();
    store.commit(&row.record_id, 0).unwrap();

    // 基于正式记录生成修改草稿，但不提交
    store
        .create_draft(Some(&row.record_id), "", "", "", None)
        .unwrap();
    store
        .save_draft(&row.record_id, None, Some("尚未提交的新正文"), None, None)
        .unwrap();

    let reloaded = Store::open(tmp.path()).unwrap();
    let listed = reloaded.list_formal();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].formal.as_ref().unwrap().body, "原始正式正文");
    assert_eq!(listed[0].draft.as_ref().unwrap().body, "尚未提交的新正文");
    assert_eq!(reloaded.row(&row.record_id).unwrap().content_revision, 1);
}

#[test]
fn ac_u0_09_edit_commit_updates_single_entry_with_stable_id() {
    let tmp = TempRoot::new("edit-commit");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "第一版", "2026-11-02", None)
        .unwrap();
    let id = row.record_id.clone();
    store.commit(&id, 0).unwrap();

    store.create_draft(Some(&id), "", "", "", None).unwrap();
    store
        .save_draft(&id, None, Some("第二版正文"), None, None)
        .unwrap();
    let outcome = store.commit(&id, 1).unwrap();
    assert_eq!(outcome.record_id, id);
    assert_eq!(outcome.content_revision, 2);

    let reloaded = Store::open(tmp.path()).unwrap();
    let listed = reloaded.list_formal();
    assert_eq!(listed.len(), 1, "时间轴不得因编辑产生重复条目");
    assert_eq!(listed[0].record_id, id);
    assert_eq!(listed[0].formal.as_ref().unwrap().body, "第二版正文");
    assert_eq!(listed[0].content_revision, 2);
    assert!(listed[0].draft.is_none());
}

#[test]
fn ac_u0_10_future_date_without_time_keeps_null_time() {
    let tmp = TempRoot::new("future-date");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "未来的日期，不伪造时刻", "2099-12-31", None)
        .unwrap();
    store.commit(&row.record_id, 0).unwrap();
    // 空白时刻也应保持 None
    store
        .create_draft(Some(&row.record_id), "", "", "", None)
        .unwrap();
    store
        .save_draft(
            &row.record_id,
            None,
            Some("补一句"),
            None,
            Some(Some("   ")),
        )
        .unwrap();
    store.commit(&row.record_id, 1).unwrap();

    let reloaded = Store::open(tmp.path()).unwrap();
    let formal = reloaded.formal(&row.record_id).unwrap();
    assert_eq!(formal.event_date, "2099-12-31");
    assert_eq!(formal.event_time, None);

    let dump = reloaded.state_json();
    let records = dump.get("records").and_then(Json::as_arr).unwrap();
    let record = records
        .iter()
        .find(|r| r.get("recordId").and_then(Json::as_str) == Some(row.record_id.as_str()))
        .unwrap();
    let formal_json = record.get("formal").unwrap();
    assert_eq!(
        formal_json.get("eventDate").and_then(Json::as_str),
        Some("2099-12-31")
    );
    assert_eq!(
        formal_json.get("eventTime").unwrap(),
        &Json::Null,
        "缺失时刻必须保持 null，不得伪填"
    );
}

#[test]
fn ac_u0_11_manifest_lists_formal_records_and_media_sha() {
    let tmp = TempRoot::new("manifest");
    let png = write_asset(&tmp.path().join("input"), "x.png", "synthetic-manifest");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "manifest 记录", "2026-11-01", None)
        .unwrap();
    let use_ref = store
        .attach_photo(&row.record_id, &png, "manifest caption", None)
        .unwrap();
    store.commit(&row.record_id, 0).unwrap();
    // 纯草稿不得进入 manifest
    store
        .create_draft(None, "", "不应出现", "2026-11-09", None)
        .unwrap();

    let manifest = store
        .manifest_json(&[("rustc".to_string(), "test-rustc".to_string())])
        .unwrap();
    let records = manifest.get("records").and_then(Json::as_arr).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].get("recordId").and_then(Json::as_str),
        Some(row.record_id.as_str())
    );
    assert_eq!(
        records[0].get("contentRevision").and_then(Json::as_i64),
        Some(1)
    );
    let photos = records[0].get("photos").and_then(Json::as_arr).unwrap();
    assert_eq!(
        photos[0].get("sha256").and_then(Json::as_str),
        Some(use_ref.sha256.as_str())
    );
    let assets = manifest.get("assets").and_then(Json::as_arr).unwrap();
    assert_eq!(
        assets[0].get("assetId").and_then(Json::as_str),
        Some(use_ref.asset_id.as_str())
    );
    let platform = manifest.get("platform").unwrap();
    assert_eq!(
        platform.get("seed").and_then(Json::as_str),
        Some("20261109")
    );
    assert_eq!(
        platform.get("rustc").and_then(Json::as_str),
        Some("test-rustc")
    );

    let out = tmp.path().join("manifest.json");
    fs::write(&out, manifest.pretty()).unwrap();
    let parsed = shiguang_core::json::parse(&fs::read_to_string(out).unwrap()).unwrap();
    assert_eq!(parsed, manifest);
}

#[test]
fn s0_guard_formal_state_never_references_missing_asset() {
    // 提交时必须校验原图存在，避免“显示已保存但媒体丢失”。
    let tmp = TempRoot::new("s0-guard");
    let png = write_asset(&tmp.path().join("input"), "g.png", "synthetic-guard");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "", "2026-11-09", None)
        .unwrap();
    let use_ref = store
        .attach_photo(&row.record_id, &png, "guard", None)
        .unwrap();
    store
        .ensure_previews_with(|source, target| {
            fs::create_dir_all(target.parent().unwrap())?;
            fs::copy(source, target)?;
            Ok(())
        })
        .unwrap();
    // 清预览不影响提交
    store.clear_previews().unwrap();
    store.commit(&row.record_id, 0).unwrap();
    assert!(store.asset_path(&use_ref.asset_id).is_some());
    assert!(formal_ids(&store).contains(&row.record_id));
}
