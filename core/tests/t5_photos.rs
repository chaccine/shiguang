mod unit05_support;

use shiguang_core::{
    sha256,
    store::ReplacementSource,
    story::{Story, StoryBlock, TextRun},
    DraftPatch, PhotoUse, Store,
};
use std::fs;
use unit05_support::{draft, tree, Temp};

const MINT: &[u8] = include_bytes!("fixtures/v5/media/ast-336cf1dd4efe5ef1.png");
const OTHER: &[u8] = include_bytes!("fixtures/v5/media/ast-5be0e93dd09a92cb.png");
const SESSION: &str = "synthetic-editor";

fn image(bytes: &[u8]) -> ReplacementSource<'_> {
    ReplacementSource::File {
        file_name: "sample.png",
        bytes,
        media_type: None,
    }
}
fn history(photo: &PhotoUse) -> ReplacementSource<'_> {
    ReplacementSource::History {
        asset_id: &photo.asset_id,
        sha256: &photo.sha256,
        media_type: &photo.media_type,
    }
}
fn attach(store: &mut Store, record: &str, caption: &str) -> PhotoUse {
    store
        .attach_photo_bytes(record, "sample.png", MINT, caption, None)
        .unwrap()
}

#[test]
fn replacement_order_and_both_snapshots_round_trip_in_backups() {
    let tmp = Temp::new("t5-backup");
    let root = tmp.0.join("source");
    let mut s = Store::open_exclusive(&root).unwrap();
    let id = draft(&mut s, "");
    let a = attach(&mut s, &id, "first");
    let b = attach(&mut s, &id, "second\r\n independent");
    let shared = draft(&mut s, "");
    let shared_photo = attach(&mut s, &shared, "another book");
    s.commit(&shared, 0).unwrap();
    let formal = Story::new(
        vec![
            StoryBlock::Photo(a.clone()),
            StoryBlock::Quote(vec![TextRun {
                text: "between".into(),
                bold: false,
                italic: true,
            }]),
            StoryBlock::Photo(b.clone()),
        ],
        Some(b.photo_use_id.clone()),
    )
    .unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            story: Some(formal.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    s.commit(&id, 0).unwrap();
    let row = s
        .replace_draft_photo(
            &id,
            &b.photo_use_id,
            image(OTHER),
            None,
            Some(SESSION),
            Some(&formal),
        )
        .unwrap();
    let replaced = row.draft.unwrap().story;
    let new = replaced.photos.last().unwrap();
    assert_eq!(
        (&new.photo_use_id, &new.caption),
        (&b.photo_use_id, &b.caption)
    );
    assert_eq!(replaced.cover_photo_use_id, formal.cover_photo_use_id);
    assert_eq!(replaced.blocks()[..2], formal.blocks()[..2]);
    assert_eq!(new.sha256, sha256::hex_digest(OTHER));
    assert_eq!(new.bytes, OTHER.len() as u64);
    assert_ne!(new.asset_id, b.asset_id);
    assert_eq!(
        fs::read(s.asset_path(&new.asset_id).unwrap()).unwrap(),
        OTHER
    );
    assert_eq!(fs::read(s.asset_path(&b.asset_id).unwrap()).unwrap(), MINT);
    let undo = s
        .replace_draft_photo(
            &id,
            &b.photo_use_id,
            history(&b),
            None,
            Some(SESSION),
            Some(&replaced),
        )
        .unwrap();
    assert_eq!(undo.draft.unwrap().story, formal);
    s.replace_draft_photo(
        &id,
        &b.photo_use_id,
        history(new),
        None,
        Some(SESSION),
        Some(&formal),
    )
    .unwrap();
    let reordered = s
        .reorder_draft_photos(&id, &[b.photo_use_id.clone(), a.photo_use_id.clone()])
        .unwrap()
        .draft
        .unwrap()
        .story;
    assert_eq!(
        reordered.blocks(),
        &[
            StoryBlock::Photo(new.clone()),
            formal.blocks()[1].clone(),
            StoryBlock::Photo(a.clone())
        ]
    );
    drop(s);
    let mut s = Store::open_exclusive(&root).unwrap();
    let row = s.row(&id).unwrap();
    assert_eq!(row.draft.as_ref().unwrap().story, reordered);
    assert_eq!(row.formal.as_ref().unwrap().story, formal);
    for (name, published) in [("split", false), ("published", true)] {
        if published {
            s.commit(&id, 1).unwrap();
        }
        let package = tmp.0.join(format!("{name}.sgbak"));
        s.export_backup(&package, "synthetic").unwrap();
        let mut dest = Store::open_exclusive(tmp.0.join(name)).unwrap();
        dest.restore_backup_overwrite(&package).unwrap();
        let mut empty = Store::open_exclusive(tmp.0.join(format!("{name}-merge"))).unwrap();
        for target in [&mut dest, &mut empty] {
            target.merge_backup(&package).unwrap();
            let once = fs::read(target.root().join("state.json")).unwrap();
            assert_eq!(
                target
                    .merge_backup(&package)
                    .unwrap()
                    .plan
                    .conflict_copies_added,
                0
            );
            assert_eq!(fs::read(target.root().join("state.json")).unwrap(), once);
            let row = target.row(&id).unwrap();
            assert_eq!(
                row.draft.as_ref().map(|d| &d.story),
                (!published).then_some(&reordered)
            );
            assert_eq!(
                &row.formal.as_ref().unwrap().story,
                if published { &reordered } else { &formal }
            );
            assert_eq!(
                target.row(&shared).unwrap().formal.as_ref().unwrap().photos,
                [shared_photo.clone()]
            );
            assert_eq!(
                fs::read(target.asset_path(&new.asset_id).unwrap()).unwrap(),
                OTHER
            );
        }
    }
}

#[test]
fn history_pins_original_until_release_and_last_unlink_preserves_shared_media() {
    let tmp = Temp::new("t5-history");
    let mut s = Store::open_exclusive(&tmp.0).unwrap();
    let id = draft(&mut s, "");
    let p = attach(&mut s, &id, "one");
    let replaced = s
        .replace_draft_photo(
            &id,
            &p.photo_use_id,
            image(OTHER),
            None,
            Some(SESSION),
            None,
        )
        .unwrap()
        .draft
        .unwrap()
        .photos[0]
        .clone();
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    assert!(s
        .replace_draft_photo(
            &id,
            &p.photo_use_id,
            history(&p),
            None,
            Some("different-session"),
            None
        )
        .is_err());
    s.replace_draft_photo(&id, &p.photo_use_id, history(&p), None, Some(SESSION), None)
        .unwrap();
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    s.release_photo_history(&id, SESSION);
    assert_eq!(
        s.reconcile_media().unwrap().quarantined[0]
            .asset_id
            .as_ref(),
        Some(&replaced.asset_id)
    );
    let other = draft(&mut s, "");
    let independent = attach(&mut s, &other, "independent");
    let second = attach(&mut s, &id, "fallback");
    let remaining = s
        .remove_draft_photo(&id, &p.photo_use_id)
        .unwrap()
        .draft
        .unwrap();
    assert_eq!(
        remaining.cover_photo_use_id.as_ref(),
        Some(&second.photo_use_id)
    );
    let empty = s
        .remove_draft_photo(&id, &second.photo_use_id)
        .unwrap()
        .draft
        .unwrap();
    assert!(empty.cover_photo_use_id.is_none() && empty.photos.is_empty());
    assert!(s.commit(&id, 0).is_err());
    assert!(s.reconcile_media().unwrap().quarantined.is_empty());
    assert_eq!(
        s.row(&other).unwrap().draft.as_ref().unwrap().photos,
        [independent]
    );
    assert_eq!(fs::read(s.asset_path(&p.asset_id).unwrap()).unwrap(), MINT);
}

#[test]
fn rejected_replacement_and_reorder_leave_exact_state_and_media() {
    let tmp = Temp::new("t5-failure");
    let mut s = Store::open_exclusive(&tmp.0).unwrap();
    let id = draft(&mut s, "synthetic");
    let p = attach(&mut s, &id, "old");
    s.commit(&id, 0).unwrap();
    let path = tmp.0.join("media").join("ast-5be0e93dd09a92cb.other");
    let mut bad = OTHER.to_vec();
    bad[15] ^= 1;
    fs::write(&path, &bad).unwrap();
    let before = tree(&tmp.0);
    for (source, code) in [
        (image(&[]), "EMPTY_ASSET"),
        (image(OTHER), "ASSET_CONFLICT"),
    ] {
        assert_eq!(
            s.replace_draft_photo(&id, &p.photo_use_id, source, None, Some(SESSION), None)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(tree(&tmp.0), before);
    }
    assert_eq!(
        s.replace_draft_photo(
            &id,
            &p.photo_use_id,
            image(OTHER),
            None,
            None,
            Some(&Story::default())
        )
        .unwrap_err()
        .code,
        "STORY_CHANGED"
    );
    assert_eq!(
        s.reorder_draft_photos(&id, &[]).unwrap_err().code,
        "PHOTO_ORDER_INVALID"
    );
    assert_eq!(tree(&tmp.0), before);
    drop(s);
    assert!(Store::open(&tmp.0)
        .unwrap()
        .row(&id)
        .unwrap()
        .draft
        .is_none());
}

#[cfg(feature = "fault-injection")]
#[test]
fn interrupted_or_uncertain_original_never_switches_or_overwrites_media() {
    use shiguang_core::fault::{self, FaultPoint};
    for (point, visit) in [
        (FaultPoint::TempWrite, 1),
        (FaultPoint::ParentSync, 1),
        (FaultPoint::AfterMediaWrite, 1),
        (FaultPoint::Replace, 2),
    ] {
        let tmp = Temp::new("t5-interrupted");
        let mut s = Store::open_exclusive(&tmp.0).unwrap();
        let id = draft(&mut s, "synthetic");
        let p = attach(&mut s, &id, "old");
        let before = tree(&tmp.0);
        fault::set_after(point, visit);
        assert!(
            s.replace_draft_photo(
                &id,
                &p.photo_use_id,
                image(OTHER),
                None,
                Some(SESSION),
                None
            )
            .is_err(),
            "{point:?}"
        );
        fault::clear();
        drop(s);
        let s = Store::open(&tmp.0).unwrap();
        assert_eq!(tree(&tmp.0), before);
        assert_eq!(s.row(&id).unwrap().draft.as_ref().unwrap().photos, [p]);
    }
}

#[test]
fn legacy_input_still_rejects_one_use_pointing_to_different_originals() {
    use shiguang_core::json::{self, Json};
    use unit05_support::set;
    let mut v5 = json::parse(include_str!("fixtures/v5/state.json")).unwrap();
    let mut records = v5.get("records").unwrap().as_arr().unwrap().to_vec();
    let mut draft = records[0].get("draft").unwrap().clone();
    let mut photos = draft.get("photos").unwrap().as_arr().unwrap().to_vec();
    let different = photos[1].get("assetId").unwrap().clone();
    set(&mut photos[0], "assetId", different);
    set(&mut draft, "photos", Json::Arr(photos));
    set(&mut records[0], "draft", draft);
    set(&mut v5, "records", Json::Arr(records));
    assert_eq!(
        shiguang_core::schema::migrate_v5_to_v6(v5)
            .unwrap_err()
            .code,
        "STATE_CORRUPT"
    );
}
