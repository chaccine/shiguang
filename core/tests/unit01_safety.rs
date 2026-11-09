//! Unit-0.1 数据安全失败测试：断言修复后的正确行为。
//!
//! 当前代码上尚未修复的用例标注 `#[ignore = "U01: 修于提交NN"]`。
//! b/f 组（提交 03）与 e 组（提交 06）需要新增 API，将在对应提交补充。

use shiguang_core::json::{self, Json};
use shiguang_core::{preview, sha256, Store};
use std::fs;
use std::path::{Path, PathBuf};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(name: &str) -> Self {
        std::env::set_var("SHIGUANG_SEED", "20261109");
        std::env::set_var("SHIGUANG_CLOCK", "2026-11-09T10:00:00Z");
        let path = std::env::temp_dir().join(format!(
            "shiguang-u01-{}-{}",
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

/// Json 路径的一段：对象键或数组下标。
enum Step {
    Key(&'static str),
    Index(usize),
}

/// 按路径删除 Json 字段；成功返回 true。
fn remove_path(value: &mut Json, path: &[Step]) -> bool {
    match path.split_first() {
        None => false,
        Some((Step::Key(key), rest)) => match value {
            Json::Obj(entries) => {
                if rest.is_empty() {
                    let before = entries.len();
                    entries.retain(|(k, _)| k.as_str() != *key);
                    entries.len() != before
                } else {
                    match entries.iter_mut().find(|(k, _)| k.as_str() == *key) {
                        Some((_, child)) => remove_path(child, rest),
                        None => false,
                    }
                }
            }
            _ => false,
        },
        Some((Step::Index(index), rest)) => match value {
            Json::Arr(items) => {
                if rest.is_empty() {
                    if *index < items.len() {
                        items.remove(*index);
                        true
                    } else {
                        false
                    }
                } else if let Some(child) = items.get_mut(*index) {
                    remove_path(child, rest)
                } else {
                    false
                }
            }
            _ => false,
        },
    }
}

/// 按路径取可变节点，用于改值。
fn value_mut<'a>(value: &'a mut Json, path: &[Step]) -> Option<&'a mut Json> {
    match path.split_first() {
        None => Some(value),
        Some((Step::Key(key), rest)) => match value {
            Json::Obj(entries) => entries
                .iter_mut()
                .find(|(k, _)| k.as_str() == *key)
                .and_then(|(_, child)| value_mut(child, rest)),
            _ => None,
        },
        Some((Step::Index(index), rest)) => match value {
            Json::Arr(items) => items.get_mut(*index).and_then(|child| value_mut(child, rest)),
            _ => None,
        },
    }
}

#[test]
fn t_a1_invalid_date_does_not_mutate_title_body() {
    let tmp = TempRoot::new("a1");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "旧标题", "旧正文", "2026-11-09", None)
        .unwrap();
    let id = row.record_id.clone();
    let before = store.state_json().dump();

    let err = store
        .save_draft(
            &id,
            Some("新标题"),
            Some("新正文"),
            Some("2026-02-30"),
            None,
        )
        .unwrap_err();
    assert_eq!(err.code, "INVALID_EVENT_DATE");

    {
        let row = store.row(&id).unwrap();
        let draft = row.draft.as_ref().expect("草稿仍在");
        assert_eq!(draft.title, "旧标题");
        assert_eq!(draft.body, "旧正文");
    }
    assert_eq!(store.state_json().dump(), before, "失败不得改变状态");

    let reopened = Store::open(tmp.path()).unwrap();
    let row = reopened.row(&id).unwrap();
    let draft = row.draft.as_ref().expect("重开后草稿仍在");
    assert_eq!(draft.title, "旧标题");
    assert_eq!(draft.body, "旧正文");
}

#[test]
fn t_a2_failed_edit_draft_does_not_materialize_draft() {
    let tmp = TempRoot::new("a2");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "原标题", "正式正文", "2026-11-09", None)
        .unwrap();
    let id = row.record_id.clone();
    store.commit(&id).unwrap();

    let err = store
        .save_draft(&id, Some("x"), None, None, Some(Some("25:99")))
        .unwrap_err();
    assert_eq!(err.code, "INVALID_EVENT_TIME");

    let row = store.row(&id).unwrap();
    assert!(row.draft.is_none(), "失败的编辑不得物化草稿");
    let formal = row.formal.as_ref().expect("正式快照仍在");
    assert_eq!(formal.title, "原标题");
}

#[test]
fn t_a3_attach_missing_record_does_not_bump_seq() {
    let tmp = TempRoot::new("a3");
    let png = write_asset(&tmp.path().join("input"), "a3.png", "synthetic-u01-a3");
    let mut store = Store::open(tmp.path()).unwrap();
    let before = store
        .state_json()
        .get("seq")
        .and_then(Json::as_i64)
        .unwrap();

    let err = store
        .attach_photo("rec-999999", &png, "缺失记录", None)
        .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");

    let after = store
        .state_json()
        .get("seq")
        .and_then(Json::as_i64)
        .unwrap();
    assert_eq!(after, before, "失败的 attach 不得推进 seq");
}

#[test]
fn t_c1_truncated_state_rejected_and_file_untouched() {
    let tmp = TempRoot::new("c1");
    let mut store = Store::open(tmp.path()).unwrap();
    store
        .create_draft(None, "c1-title", "c1-body", "2026-11-09", None)
        .unwrap();
    let path = tmp.path().join("state.json");
    let bytes = fs::read(&path).unwrap();
    let digest = sha256::hex_digest(&bytes);

    let truncated = bytes[..bytes.len() / 2].to_vec();
    fs::write(&path, &truncated).unwrap();

    let err = Store::open(tmp.path())
        .err()
        .expect("截断的状态文件必须被拒绝");
    assert_eq!(err.code, "STATE_CORRUPT");

    let after = fs::read(&path).unwrap();
    assert_eq!(after, truncated, "打开失败不得改写状态文件");
    assert_eq!(sha256::hex_digest(&after), sha256::hex_digest(&truncated));
    assert_ne!(sha256::hex_digest(&after), digest, "内容确实被截断");
}

#[test]
fn t_c2_missing_fields_no_silent_default() {
    let tmp = TempRoot::new("c2");
    let png = write_asset(&tmp.path().join("input"), "c2.png", "synthetic-u01-c2");
    {
        let mut store = Store::open(tmp.path()).unwrap();
        let row = store
            .create_draft(None, "", "带照片的正式内容", "2026-11-09", None)
            .unwrap();
        store
            .attach_photo(&row.record_id, &png, "c2 caption", None)
            .unwrap();
        store.commit(&row.record_id).unwrap();
    }
    let path = tmp.path().join("state.json");
    let original = fs::read_to_string(&path).unwrap();

    let cases: Vec<(&str, Vec<Step>)> = vec![
        ("顶层 seq", vec![Step::Key("seq")]),
        ("顶层 records", vec![Step::Key("records")]),
        (
            "record contentRevision",
            vec![
                Step::Key("records"),
                Step::Index(0),
                Step::Key("contentRevision"),
            ],
        ),
        (
            "formal eventDate",
            vec![
                Step::Key("records"),
                Step::Index(0),
                Step::Key("formal"),
                Step::Key("eventDate"),
            ],
        ),
        (
            "photo caption",
            vec![
                Step::Key("records"),
                Step::Index(0),
                Step::Key("formal"),
                Step::Key("photos"),
                Step::Index(0),
                Step::Key("caption"),
            ],
        ),
        (
            "photo bytes",
            vec![
                Step::Key("records"),
                Step::Index(0),
                Step::Key("formal"),
                Step::Key("photos"),
                Step::Index(0),
                Step::Key("bytes"),
            ],
        ),
        (
            "photo mediaType",
            vec![
                Step::Key("records"),
                Step::Index(0),
                Step::Key("formal"),
                Step::Key("photos"),
                Step::Index(0),
                Step::Key("mediaType"),
            ],
        ),
    ];

    for (label, steps) in cases {
        let mut value = json::parse(&original).unwrap();
        assert!(remove_path(&mut value, &steps), "删除路径失败：{label}");
        fs::write(&path, value.dump().as_bytes()).unwrap();
        let err = Store::open(tmp.path())
            .err()
            .unwrap_or_else(|| panic!("缺失字段必须被拒绝：{label}"));
        assert_eq!(err.code, "STATE_CORRUPT", "缺失字段：{label}");
    }
    fs::write(&path, original.as_bytes()).unwrap();
}

#[test]
fn t_c3_out_of_range_or_duplicate_rejected() {
    let tmp = TempRoot::new("c3");
    {
        let mut store = Store::open(tmp.path()).unwrap();
        let row = store
            .create_draft(None, "", "c3 正式内容", "2026-11-09", None)
            .unwrap();
        store.commit(&row.record_id).unwrap();
    }
    let path = tmp.path().join("state.json");
    let original = fs::read_to_string(&path).unwrap();

    // contentRevision = -1
    let mut value = json::parse(&original).unwrap();
    let rev = value_mut(
        &mut value,
        &[
            Step::Key("records"),
            Step::Index(0),
            Step::Key("contentRevision"),
        ],
    )
    .expect("找到 contentRevision");
    *rev = Json::Num(-1);
    fs::write(&path, value.dump().as_bytes()).unwrap();
    let err = Store::open(tmp.path())
        .err()
        .expect("负数 revision 必须被拒绝");
    assert_eq!(err.code, "STATE_CORRUPT");

    // contentRevision = 4294967296
    let mut value = json::parse(&original).unwrap();
    let rev = value_mut(
        &mut value,
        &[
            Step::Key("records"),
            Step::Index(0),
            Step::Key("contentRevision"),
        ],
    )
    .expect("找到 contentRevision");
    *rev = Json::Num(4_294_967_296);
    fs::write(&path, value.dump().as_bytes()).unwrap();
    let err = Store::open(tmp.path())
        .err()
        .expect("超出 u32 的 revision 必须被拒绝");
    assert_eq!(err.code, "STATE_CORRUPT");

    // 顶层对象插入重复的 seq 键
    let brace = original.find('{').expect("顶层对象");
    let mut duplicated = String::new();
    duplicated.push_str(&original[..=brace]);
    duplicated.push_str("\"seq\":0,");
    duplicated.push_str(&original[brace + 1..]);
    fs::write(&path, duplicated.as_bytes()).unwrap();
    let err = Store::open(tmp.path())
        .err()
        .expect("重复键 seq 必须被拒绝");
    assert_eq!(err.code, "STATE_CORRUPT");

    fs::write(&path, original.as_bytes()).unwrap();
}

#[test]
fn t_c4_future_version_refused() {
    let tmp = TempRoot::new("c4");
    {
        let mut store = Store::open(tmp.path()).unwrap();
        store
            .create_draft(None, "c4", "c4", "2026-11-09", None)
            .unwrap();
    }
    let path = tmp.path().join("state.json");
    let original = fs::read_to_string(&path).unwrap();
    let mut value = json::parse(&original).unwrap();
    let version = value_mut(&mut value, &[Step::Key("version")]).unwrap();
    *version = Json::Num(2);
    let modified = value.dump();
    fs::write(&path, modified.as_bytes()).unwrap();

    let before = fs::read(&path).unwrap();
    let err = Store::open(tmp.path())
        .err()
        .expect("未来版本必须被拒绝");
    assert_eq!(err.code, "STATE_VERSION_UNSUPPORTED");

    let after = fs::read(&path).unwrap();
    assert_eq!(after, before, "拒绝版本不得改写文件");
    assert_eq!(after, modified.as_bytes());
}

#[test]
#[ignore = "U01: 修于提交05"]
fn t_d1_tampered_asset_blocks_commit() {
    let tmp = TempRoot::new("d1");
    let png = write_asset(&tmp.path().join("input"), "d1.png", "synthetic-u01-d1");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "待提交正文", "2026-11-09", None)
        .unwrap();
    let id = row.record_id.clone();
    let photo = store
        .attach_photo(&id, &png, "d1 caption", None)
        .unwrap();

    let media = store.asset_path(&photo.asset_id).expect("原图已落盘");
    let mut bytes = fs::read(&media).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    fs::write(&media, &bytes).unwrap();

    let err = store.commit(&id).unwrap_err();
    assert_eq!(err.code, "ASSET_HASH_MISMATCH");

    let row = store.row(&id).unwrap();
    assert!(row.formal.is_none(), "校验失败不得产生正式记录");
    assert!(row.draft.is_some(), "草稿必须保留");
}

#[test]
#[ignore = "U01: 修于提交05"]
fn t_d2_truncated_asset_blocks_commit() {
    let tmp = TempRoot::new("d2");
    let png = write_asset(&tmp.path().join("input"), "d2.png", "synthetic-u01-d2");
    let mut store = Store::open(tmp.path()).unwrap();
    let row = store
        .create_draft(None, "", "待提交正文", "2026-11-09", None)
        .unwrap();
    let id = row.record_id.clone();
    let photo = store
        .attach_photo(&id, &png, "d2 caption", None)
        .unwrap();

    let media = store.asset_path(&photo.asset_id).expect("原图已落盘");
    let bytes = fs::read(&media).unwrap();
    let truncated = bytes[..bytes.len() / 2].to_vec();
    fs::write(&media, &truncated).unwrap();

    let err = store.commit(&id).unwrap_err();
    assert_eq!(err.code, "ASSET_SIZE_MISMATCH");

    let row = store.row(&id).unwrap();
    assert!(row.formal.is_none(), "校验失败不得产生正式记录");
    assert!(row.draft.is_some(), "草稿必须保留");
}
