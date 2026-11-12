//! Historical fixtures. Run ONLY against the original v3 core (b882029).
mod unit05_support;

use shiguang_core::{backup, json, KdfParams, Store, CURRENT_SCHEMA_VERSION};
use std::{fs, path::Path};
use unit05_support::{draft, photo, Temp};

const PASSWORD: &str = "synthetic-fixture-pass";

#[test]
#[ignore = "writes historical fixtures; run explicitly with the unmodified v3 core"]
fn generate_v3_golden_fixtures() {
    assert_eq!(
        CURRENT_SCHEMA_VERSION, 3,
        "never regenerate v3 with v4 code"
    );
    std::env::set_var("SHIGUANG_CLOCK", "2026-11-09T12:00:00Z");
    std::env::set_var("SHIGUANG_SEED", "synthetic-v3-golden");
    let temp = Temp::new("golden-v3-generator");
    let mut s = Store::open_exclusive(temp.0.join("data")).unwrap();
    let tag = s.create_tag("合成·旅行").unwrap();
    let second_tag = s.create_tag("合成·家人").unwrap();

    let formal = draft(&mut s, "合成正式正文：三张照片。\n没有真实私人数据。");
    for name in ["synthetic-red", "synthetic-green", "synthetic-blue"] {
        photo(&mut s, &formal, name);
    }
    s.commit(&formal, 0).unwrap();
    s.set_favorite(&formal, true, Some(0)).unwrap();
    s.set_record_tags(&formal, &[tag.tag_id.clone(), second_tag.tag_id], Some(0))
        .unwrap();

    let edited = draft(&mut s, "合成旧正式内容，编辑草稿不能发布它。");
    photo(&mut s, &edited, "synthetic-shared");
    photo(&mut s, &edited, "synthetic-edit-original");
    s.commit(&edited, 0).unwrap();
    s.create_draft(Some(&edited), "", "", "", None).unwrap();
    s.save_draft(
        &edited,
        Some("合成编辑草稿"),
        Some("尚未发布的合成修改"),
        None,
        None,
    )
    .unwrap();
    photo(&mut s, &edited, "synthetic-edit-draft-only");

    let pure = draft(&mut s, "合成纯草稿，尚未存入时光。");
    photo(&mut s, &pure, "synthetic-shared");
    s.set_record_tags(&pure, &[tag.tag_id], Some(0)).unwrap();

    let trashed = draft(&mut s, "合成回收站记录");
    photo(&mut s, &trashed, "synthetic-trash");
    s.commit(&trashed, 0).unwrap();
    s.trash_record(&trashed).unwrap();

    let deleted = draft(&mut s, "合成永久删除记录，仅保留最小标记");
    s.commit(&deleted, 0).unwrap();
    s.trash_record(&deleted).unwrap();
    s.purge_record(&deleted).unwrap();

    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3");
    fs::create_dir_all(out.join("media")).unwrap();
    fs::copy(s.root().join("state.json"), out.join("state.json")).unwrap();
    for entry in fs::read_dir(s.root().join("media")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), out.join("media").join(entry.file_name())).unwrap();
    }
    s.export_backup(&out.join("plain.sgbak"), "0.1.9").unwrap();
    s.export_backup_encrypted(
        &out.join("encrypted.sgbak"),
        "0.1.9",
        PASSWORD,
        KdfParams::default(),
    )
    .unwrap();
}

#[test]
fn frozen_v3_fixtures_have_original_schema_and_complete_media() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3");
    let value = json::parse(&fs::read_to_string(dir.join("state.json")).unwrap()).unwrap();
    assert_eq!(value.get("schemaVersion").unwrap().as_i64(), Some(3));
    assert_eq!(value.get("records").unwrap().as_arr().unwrap().len(), 4);
    for path in ["plain.sgbak", "encrypted.sgbak"] {
        let info = if path == "plain.sgbak" {
            backup::verify_backup(&dir.join(path)).unwrap()
        } else {
            backup::verify_backup_with_password(&dir.join(path), PASSWORD).unwrap()
        };
        assert_eq!(info.schema_version, 3);
        assert!(info.missing_media.is_empty());
        assert_eq!(info.counts.formal, 2); // active formal only; trash counted separately
        assert_eq!(info.counts.drafts, 2);
        assert_eq!(info.counts.trashed, 1);
        assert_eq!(info.counts.tags, 2);
        assert_eq!(info.counts.favorites, 1);
    }
}
