mod unit05_support;

use shiguang_core::{
    backup::{verify_backup, verify_backup_with_password},
    json::{self, Json},
    model::EditorMode,
    story::{Story, StoryBlock, TextRun},
    DraftPatch, KdfParams, Store,
};
use std::{fs, path::Path};
use unit05_support::{draft, photo, seeded, Temp};

fn disk(root: &Path) -> Json {
    json::parse(&fs::read_to_string(root.join("state.json")).unwrap()).unwrap()
}

fn save(s: &mut Store, id: &str, expected: &Story, story: &Story) {
    s.save_draft_patch(
        id,
        &DraftPatch {
            story: Some(story.clone()),
            expected_story: Some(expected.clone()),
            editor_mode: Some(EditorMode::Story),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn ordered_draft_publishes_reopens_restores_merges_twice_and_reexports() {
    let temp = Temp::new("schema6-ordered");
    let root = temp.0.join("source");
    let mut s = Store::open_exclusive(&root).unwrap();
    let id = draft(&mut s, "old");
    let first = photo(&mut s, &id, "shared");
    let mut second = photo(&mut s, &id, "shared");
    assert_eq!(first.asset_id, second.asset_id);
    assert_ne!(first.photo_use_id, second.photo_use_id);
    second.caption = " second\r\n ".into();
    let mark = TextRun {
        text: " heading ".into(),
        bold: true,
        italic: true,
    };
    let story = Story::new(
        vec![
            StoryBlock::SmallHeading(vec![mark]),
            StoryBlock::Paragraph(vec![TextRun::plain(" p1\r\n")]),
            StoryBlock::Photo(first.clone()),
            StoryBlock::Quote(vec![TextRun::plain("<quote>")]),
            StoryBlock::Divider,
            StoryBlock::Photo(second.clone()),
            StoryBlock::Paragraph(vec![TextRun::plain("after photo")]),
        ],
        Some(second.photo_use_id.clone()),
    )
    .unwrap();
    let old = s.row(&id).unwrap().draft.as_ref().unwrap().story.clone();
    save(&mut s, &id, &old, &story);
    let state = disk(&root);
    assert_eq!(state.get("version"), Some(&Json::Num(2)));
    assert_eq!(state.get("schemaVersion"), Some(&Json::Num(6)));
    let snap = state.get("records").unwrap().as_arr().unwrap()[0]
        .get("draft")
        .unwrap();
    assert_eq!(Story::from_json(snap.get("story").unwrap()).unwrap(), story);
    for key in ["body", "photos", "coverPhotoUseId"] {
        assert!(snap.get(key).is_none());
    }
    drop(s);
    let mut s = Store::open(&root).unwrap();
    let row = s.row(&id).unwrap();
    assert!(row.formal.is_none());
    assert_eq!(row.draft_mode, Some(EditorMode::Story));
    assert_eq!(row.draft.as_ref().unwrap().story, story);
    assert_eq!(story.body, " heading \n p1\r\n\n<quote>\nafter photo");
    assert_eq!(s.commit(&id, 0).unwrap().content_revision, 1);
    let before = fs::read(root.join("state.json")).unwrap();
    for (code, patch) in [
        (
            "STORY_COMPLEX",
            DraftPatch {
                body: Some("flatten".into()),
                ..Default::default()
            },
        ),
        (
            "STORY_CHANGED",
            DraftPatch {
                story: Some(old.clone()),
                expected_story: Some(old),
                ..Default::default()
            },
        ),
        (
            "PHOTO_ORDER_INVALID",
            DraftPatch {
                story: Some(Story::default()),
                ..Default::default()
            },
        ),
    ] {
        assert_eq!(s.save_draft_patch(&id, &patch).unwrap_err().code, code);
        assert_eq!(fs::read(root.join("state.json")).unwrap(), before);
    }
    let plain = temp.0.join("source.sgbak");
    let encrypted = temp.0.join("encrypted.sgbak");
    s.export_backup(&plain, "synthetic").unwrap();
    s.export_backup_encrypted(&encrypted, "synthetic", "synthetic", KdfParams::fast())
        .unwrap();
    assert_eq!(verify_backup(&plain).unwrap().schema_version, 6);
    assert_eq!(
        verify_backup_with_password(&encrypted, "synthetic")
            .unwrap()
            .schema_version,
        6
    );
    assert_eq!(&fs::read(&plain).unwrap()[..8], b"SGBAK\0\0\x01");
    assert_eq!(&fs::read(&encrypted).unwrap()[..10], b"SGBAKENC\0\x01");

    for (name, package) in [("plain", &plain), ("encrypted", &encrypted)] {
        let dest = temp.0.join(name);
        let mut target = seeded(&dest, "replace this library");
        target
            .restore_backup_overwrite_with_password(package, "synthetic")
            .unwrap();
        assert_eq!(
            target.row(&id).unwrap().formal.as_ref().unwrap().story,
            story
        );
        target
            .merge_backup_with_password(package, "synthetic")
            .unwrap();
        let once = fs::read(dest.join("state.json")).unwrap();
        let again = target
            .merge_backup_with_password(package, "synthetic")
            .unwrap();
        assert_eq!(again.plan.conflict_copies_added, 0);
        assert_eq!(fs::read(dest.join("state.json")).unwrap(), once);
        let reexport = temp.0.join(format!("{name}-again.sgbak"));
        target.export_backup(&reexport, "synthetic").unwrap();
        assert_eq!(verify_backup(&reexport).unwrap().schema_version, 6);
        drop(target);
        let mut reopened = Store::open_exclusive(&dest).unwrap();
        reopened.restore_backup_overwrite(&reexport).unwrap();
        let row = reopened.row(&id).unwrap();
        assert!(row.draft.is_none() && row.draft_mode.is_none());
        assert_eq!(row.formal.as_ref().unwrap().story, story);
        let assets = reopened.assets_on_disk().unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(
            (&assets[0].sha256, assets[0].bytes),
            (&second.sha256, second.bytes)
        );
    }
}

#[test]
fn equal_plain_text_with_different_structure_creates_one_durable_conflict() {
    let temp = Temp::new("schema6-structure");
    let mut local = Store::open_exclusive(temp.0.join("local")).unwrap();
    let id = draft(&mut local, "same words");
    let initial = local
        .row(&id)
        .unwrap()
        .draft
        .as_ref()
        .unwrap()
        .story
        .clone();
    local.commit(&id, 0).unwrap();
    let base = temp.0.join("base.sgbak");
    local.export_backup(&base, "synthetic").unwrap();
    let mut remote = Store::open_exclusive(temp.0.join("remote")).unwrap();
    remote.restore_backup_overwrite(&base).unwrap();
    let heading = Story::new(
        vec![StoryBlock::SmallHeading(vec![TextRun::plain("same words")])],
        None,
    )
    .unwrap();
    let quote = Story::new(
        vec![StoryBlock::Quote(vec![TextRun::plain("same words")])],
        None,
    )
    .unwrap();
    assert_eq!(heading.body, quote.body);
    save(&mut local, &id, &initial, &heading);
    save(&mut remote, &id, &initial, &quote);
    local.commit(&id, 1).unwrap();
    remote.commit(&id, 1).unwrap();
    let incoming = temp.0.join("remote.sgbak");
    remote.export_backup(&incoming, "synthetic").unwrap();
    assert_eq!(
        local
            .merge_backup(&incoming)
            .unwrap()
            .plan
            .conflict_copies_added,
        1
    );
    let once = fs::read(local.root().join("state.json")).unwrap();
    assert_eq!(
        local
            .merge_backup(&incoming)
            .unwrap()
            .plan
            .conflict_copies_added,
        0
    );
    assert_eq!(fs::read(local.root().join("state.json")).unwrap(), once);
    drop(local);
    let local = Store::open_exclusive(temp.0.join("local")).unwrap();
    assert_eq!(
        local.row(&id).unwrap().formal.as_ref().unwrap().story,
        heading
    );
    assert_eq!(
        local.list_conflict_copies().unwrap()[0].snapshot.story,
        quote
    );
}
