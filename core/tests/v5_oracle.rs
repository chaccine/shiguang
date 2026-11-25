//! Compatibility of the current native reader with two frozen native writers.
mod unit05_support;

use shiguang_core::{
    backup,
    json::{self, Json},
    sha256, BackupCounts, KdfParams, Store, ThemePreference,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use unit05_support::{seeded, tree, unpack, Temp};

const PASSWORD: &str = "synthetic-fixture-pass"; // Public test fixture only.

fn fixture(schema: i64) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/v{schema}"))
}

fn array<'a>(obj: &'a Json, key: &str) -> &'a [Json] {
    obj.get(key).unwrap().as_arr().unwrap()
}

fn source_copy(archive: &Path, root: &Path) -> Store {
    fs::create_dir_all(root.join("media")).unwrap();
    fs::copy(archive.join("state.json"), root.join("state.json")).unwrap();
    for entry in fs::read_dir(archive.join("media")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), root.join("media").join(entry.file_name())).unwrap();
    }
    Store::open_exclusive(root).unwrap()
}

fn media_hashes(root: &Path) -> BTreeMap<PathBuf, String> {
    tree(&root.join("media"))
        .into_iter()
        .map(|(path, bytes)| (path, sha256::hex_digest(&bytes)))
        .collect()
}

fn disk_hashes(root: &Path) -> (String, BTreeMap<PathBuf, String>) {
    (
        sha256::hex_digest(&fs::read(root.join("state.json")).unwrap()),
        media_hashes(root),
    )
}

#[test]
fn archived_envelopes_decrypt_to_the_exact_plain_package_and_source_files() {
    for (schema, version, plain_hash, encrypted_hash) in [
        (
            5,
            "0.1.12",
            "1e6219684710aa3ed5676fb4950713def97f106e9dee161f2ae677a905a2384b",
            "ee63e120c01ab959e8990d7f2cd11aab2e5f27bc191f20c39a95f04063e4976f",
        ),
        (
            3,
            "0.1.9",
            "a36c6395d12f14029bc445dd25572327c5a99f4311a77d5c01710e8cb32b89b9",
            "3a9faaaaae7508c93ce919c3e563276b5b1b5d455e4299237b68e41be80d40d4",
        ),
    ] {
        let dir = fixture(schema);
        let plain = dir.join("plain.sgbak");
        let encrypted = dir.join("encrypted.sgbak");
        let plain_bytes = fs::read(&plain).unwrap();
        let enc = fs::read(&encrypted).unwrap();
        assert_eq!(sha256::hex_digest(&plain_bytes), plain_hash);
        assert_eq!(sha256::hex_digest(&enc), encrypted_hash);
        assert_eq!(&plain_bytes[..8], b"SGBAK\0\0\x01");
        assert_eq!(&enc[..10], b"SGBAKENC\0\x01");
        let len = u32::from_le_bytes(enc[10..14].try_into().unwrap()) as usize;
        let header = json::parse(std::str::from_utf8(&enc[14..14 + len]).unwrap()).unwrap();
        assert_eq!(
            header.get("format"),
            Some(&Json::str("shiguang-backup-encrypted"))
        );
        assert_eq!(header.get("formatVersion"), Some(&Json::Num(1)));

        let info = backup::verify_backup(&plain).unwrap();
        assert_eq!(
            info,
            backup::verify_backup_with_password(&encrypted, PASSWORD).unwrap()
        );
        assert_eq!(info.app_version, version);
        assert_eq!(info.schema_version, schema);
        assert!(info.missing_media.is_empty());
        if schema == 5 {
            assert_eq!(
                info.counts,
                BackupCounts {
                    tags: 1,
                    favorites: 1,
                    formal: 2,
                    drafts: 1,
                    trashed: 1,
                    conflict_copies: 1,
                    media_files: 2,
                    ..Default::default()
                }
            );
        }
        let temp = Temp::new("oracle-decrypt");
        let decrypted = temp.0.join("inner.sgbak");
        backup::decrypt_backup(&encrypted, &decrypted, PASSWORD).unwrap();
        assert_eq!(fs::read(decrypted).unwrap(), plain_bytes);

        let (manifest, payloads) = unpack(&plain_bytes);
        assert_eq!(manifest.get("format"), Some(&Json::str("shiguang-backup")));
        assert_eq!(manifest.get("formatVersion"), Some(&Json::Num(1)));
        assert_eq!(manifest.get("schemaVersion"), Some(&Json::Num(schema)));
        for (entry, payload) in array(&manifest, "entries").iter().zip(payloads) {
            let path = entry.get("path").unwrap().as_str().unwrap();
            assert_eq!(payload, fs::read(dir.join(path)).unwrap(), "{path}");
        }
        let state = json::parse(&fs::read_to_string(dir.join("state.json")).unwrap()).unwrap();
        assert_eq!(state.get("version"), Some(&Json::Num(1)));
        assert_eq!(state.get("schemaVersion"), Some(&Json::Num(schema)));
    }
}

fn assert_v5_content(store: &Store) {
    let row = store.row("rec-000002").unwrap();
    let formal = row.formal.as_ref().unwrap();
    let window = ("pu-000004", "窗边\n第二张是封面");
    for (snapshot, body, first, second) in [
        (
            formal,
            " \t合成正文 e\u{301} 🪁\r\n第二行\u{3000} ",
            ("pu-000003", "茶色条纹"),
            window,
        ),
        (
            row.draft.as_ref().unwrap(),
            "  草稿 👩‍🚀\r\n未发布 e\u{301}\t ",
            window,
            ("pu-000003", "仅在草稿中的茶"),
        ),
    ] {
        assert_eq!(snapshot.body.as_bytes(), body.as_bytes());
        let uses: Vec<_> = snapshot
            .photos
            .iter()
            .map(|p| (p.photo_use_id.as_str(), p.caption.as_str()))
            .collect();
        assert_eq!(uses, [first, second]);
        assert_eq!(snapshot.cover().unwrap().photo_use_id, second.0);
    }
    let shared = &store.formal("rec-000005").unwrap().photos[0];
    assert_eq!(shared.asset_id, formal.photos[0].asset_id);
    assert_ne!(shared.photo_use_id, formal.photos[0].photo_use_id);
    assert_eq!(shared.caption, "另一条记录的茶");
}

// Each archived library has record, use and tag IDs distinct from the merge destination's.
fn assert_merged_library(merged: &Json, local: &Json, incoming: &Json) {
    for key in ["records", "tags", "deletionMarkers", "conflictCopies"] {
        let found = array(merged, key);
        let own = array(local, key);
        let added = array(incoming, key);
        assert_eq!(found.len(), own.len() + added.len(), "{key}");
        for item in own.iter().chain(added) {
            assert!(found.contains(item), "missing or altered {key}: {item:?}");
        }
    }
    assert_eq!(merged.get("seed"), local.get("seed"));
    assert_eq!(merged.get("settings"), local.get("settings"));
}

fn exercise_imports(schema: i64) {
    let archive = fixture(schema);
    let temp = Temp::new("oracle-source-copy");
    let source = source_copy(&archive, &temp.0.join("library"));
    let expected = source.state_json();
    let originals = media_hashes(&archive);
    assert_eq!(media_hashes(source.root()), originals);
    if schema == 5 {
        let frozen = fs::read(archive.join("state.json")).unwrap();
        assert_eq!(fs::read(source.root().join("state.json")).unwrap(), frozen);
        assert_eq!(expected.pretty().as_bytes(), frozen);
        assert_v5_content(&source);
    }
    for name in ["plain.sgbak", "encrypted.sgbak"] {
        let package = archive.join(name);
        let temp = Temp::new("oracle-import");
        let overwritten = temp.0.join("overwrite");
        let mut store = seeded(&overwritten, "合成覆盖目标");
        store
            .restore_backup_overwrite_with_password(&package, PASSWORD)
            .unwrap();
        drop(store);
        let mut restored = Store::open_exclusive(&overwritten).unwrap();
        assert_eq!(restored.state_json(), expected);
        assert_eq!(media_hashes(&overwritten), originals);
        if schema == 5 {
            assert_v5_content(&restored);
            let trash = restored.restore_record("rec-000008").unwrap();
            assert_eq!(trash.formal.as_ref(), source.formal("rec-000008"));
            let copy = source.list_conflict_copies().unwrap().remove(0);
            let row = restored.restore_conflict_copy(&copy.conflict_id).unwrap();
            assert_eq!(row.draft.as_ref(), Some(&copy.snapshot));
            assert_eq!(row.formal.as_ref(), source.formal(&copy.record_id));
            drop(restored);
            let recovered = Store::open_exclusive(&overwritten).unwrap();
            assert!(recovered.list_trash().unwrap().is_empty());
            assert_eq!(
                recovered.row(&trash.record_id).unwrap().to_json(),
                trash.to_json()
            );
            assert!(recovered.list_conflict_copies().unwrap().is_empty());
            assert_eq!(
                recovered.row(&copy.record_id).unwrap().to_json(),
                row.to_json()
            );
        }

        let root = temp.0.join("merge");
        let mut dest = seeded(&root, "合成目标自己的正式正文");
        let id = dest.list_formal()[0].record_id.clone();
        let tag = dest.create_tag("合成目标自己的标签").unwrap();
        dest.set_record_tags(&id, &[tag.tag_id], Some(0)).unwrap();
        dest.set_favorite(&id, true, Some(0)).unwrap();
        dest.set_theme(ThemePreference::Light).unwrap();
        let local = dest.state_json();
        let mut all_media = media_hashes(&root);
        all_media.extend(originals.clone());

        let first = dest.merge_backup_with_password(&package, PASSWORD).unwrap();
        assert_eq!(first.plan.added as usize, array(&expected, "records").len());
        let merged = dest.state_json();
        assert_merged_library(&merged, &local, &expected);
        assert_eq!(media_hashes(&root), all_media);
        let before = disk_hashes(&root);
        drop(dest);
        let mut dest = Store::open_exclusive(&root).unwrap();
        assert_eq!(dest.state_json(), merged);
        let repeat = dest.merge_backup_with_password(&package, PASSWORD).unwrap();
        assert!(repeat.safety_backup_dir.is_none());
        assert_eq!(repeat.plan.added, 0);
        assert_eq!(repeat.plan.conflict_copies_added, 0);
        assert_eq!(disk_hashes(&root), before);

        let exported = temp.0.join("roundtrip.sgbak");
        if name == "plain.sgbak" {
            dest.export_backup(&exported, env!("CARGO_PKG_VERSION"))
                .unwrap();
        } else {
            dest.export_backup_encrypted(
                &exported,
                env!("CARGO_PKG_VERSION"),
                PASSWORD,
                KdfParams::default(),
            )
            .unwrap();
        }
        assert_eq!(backup::is_encrypted(&exported), name == "encrypted.sgbak");
        let info = backup::verify_backup_with_password(&exported, PASSWORD).unwrap();
        assert_eq!(info.schema_version, 5);
        assert!(info.missing_media.is_empty());
        let final_root = temp.0.join("roundtrip");
        Store::open_exclusive(&final_root)
            .unwrap()
            .restore_backup_overwrite_with_password(&exported, PASSWORD)
            .unwrap();
        let reopened = Store::open_exclusive(&final_root).unwrap();
        assert_eq!(reopened.state_json(), merged);
        assert_eq!(media_hashes(&final_root), all_media);
        if schema == 5 {
            assert_v5_content(&reopened);
        }
    }
}

#[test]
fn v5_state_plain_and_encrypted_overwrite_merge_twice_and_reexport() {
    exercise_imports(5);
}

#[test]
fn archived_v3_state_plain_and_encrypted_overwrite_merge_twice_and_reexport() {
    exercise_imports(3);
}

#[test]
fn v5_wrong_password_and_changed_bytes_preserve_the_destination() {
    let archive = fixture(5);
    let temp = Temp::new("oracle-rejection");
    let root = temp.0.join("library");
    let mut dest = seeded(&root, "合成拒绝目标");
    let before = disk_hashes(&root);
    let state = dest.state_json();
    // Flip the last plain payload byte (before its 48-byte trailer), or the AEAD tag.
    for (name, from_end) in [("plain.sgbak", 49), ("encrypted.sgbak", 1)] {
        let mut data = fs::read(archive.join(name)).unwrap();
        let at = data.len() - from_end;
        data[at] ^= 1;
        fs::write(temp.0.join(name), data).unwrap();
    }
    for (path, password, error) in [
        (
            archive.join("encrypted.sgbak"),
            "wrong-test-password",
            "BACKUP_PASSWORD_WRONG",
        ),
        (temp.0.join("plain.sgbak"), PASSWORD, "BACKUP_CORRUPT"),
        (
            temp.0.join("encrypted.sgbak"),
            PASSWORD,
            "BACKUP_PASSWORD_WRONG",
        ),
    ] {
        assert_eq!(
            backup::verify_backup_with_password(&path, password)
                .unwrap_err()
                .code,
            error
        );
        assert_eq!(
            dest.restore_backup_overwrite_with_password(&path, password)
                .unwrap_err()
                .code,
            error
        );
        assert_eq!(disk_hashes(&root), before);
        assert_eq!(dest.state_json(), state);
        assert_eq!(
            dest.merge_backup_with_password(&path, password)
                .unwrap_err()
                .code,
            error
        );
        assert_eq!(disk_hashes(&root), before);
        assert_eq!(dest.state_json(), state);
    }
    drop(dest);
    assert_eq!(Store::open_exclusive(&root).unwrap().state_json(), state);
    assert_eq!(disk_hashes(&root), before);
}
