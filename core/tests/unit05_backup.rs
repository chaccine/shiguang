mod unit05_support;
use shiguang_core::{backup::verify_backup, json::Json, sha256, ConflictChoice, Store};
use std::fs;
use unit05_support::*;

#[test]
fn rich_roundtrip_preserves_all_state_shared_photos_missing_and_conflicts() {
    let a = Temp::new("rich-a");
    let b = Temp::new("rich-b");
    let files = Temp::new("rich-pack");
    let mut s = seeded(&a.0, "formal");
    let first = s.list_formal()[0].record_id.clone();
    let shared = draft(&mut s, "second");
    photo(&mut s, &shared, "formal");
    s.commit(&shared, 0).unwrap();
    s.save_draft(&first, None, Some("修改已发布"), None, None)
        .unwrap();
    let fresh = draft(&mut s, "新建草稿");
    let missing = photo(&mut s, &fresh, "missing");
    fs::remove_file(s.asset_path(&missing.asset_id).unwrap()).unwrap();
    let trash = draft(&mut s, "回收站");
    photo(&mut s, &trash, "trash");
    s.commit(&trash, 0).unwrap();
    s.trash_record(&trash).unwrap();
    let purge = draft(&mut s, "永久删除");
    s.commit(&purge, 0).unwrap();
    s.trash_record(&purge).unwrap();
    s.purge_record(&purge).unwrap();
    let conflict = draft(&mut s, "副本");
    s.commit(&conflict, 0).unwrap();
    photo(&mut s, &conflict, "conflict-only");
    s.resolve_conflict(&conflict, ConflictChoice::KeepFormal)
        .unwrap();
    fs::write(a.0.join("media/orphan.png"), b"excluded synthetic orphan").unwrap();
    let expected = s.state_json();
    let dest = files.0.join("rich.sgbak");
    let report = s.export_backup(&dest, "test-version").unwrap();
    assert_eq!(report.missing_media.len(), 1);
    assert_eq!(report.missing_media[0].asset_id, missing.asset_id);
    assert_eq!(report.sha256, sha256::hex_digest(&fs::read(&dest).unwrap()));
    let info = verify_backup(&dest).unwrap();
    assert_eq!(info.counts.media_files, 3);
    assert_eq!(info.counts.missing_media, 1);
    assert_eq!(info.counts.conflict_copies, 1);
    assert_eq!(info.app_version, "test-version");
    let mut target = Store::open_exclusive(&b.0).unwrap();
    let restored = target.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(target.state_json(), expected);
    assert!(restored.media_report.quarantined.is_empty());
    assert!(!restored.media_report.missing.is_empty());
    for (path, bytes) in tree(&b.0)
        .into_iter()
        .filter(|(p, _)| p.starts_with("media"))
    {
        assert_eq!(
            sha256::hex_digest(&bytes),
            sha256::hex_digest(&fs::read(a.0.join(path)).unwrap())
        );
    }
    drop(target);
    let mut target = Store::open_exclusive(&b.0).unwrap();
    assert_eq!(target.state_json(), expected);
    assert!(target.reconcile_media().unwrap().quarantined.is_empty());
    clean(&b.0);
}
#[test]
fn overwrite_keeps_exact_safety_copy_all_originals_and_clears_previews() {
    let a = Temp::new("overwrite-a");
    let b = Temp::new("overwrite-b");
    let f = Temp::new("overwrite-file");
    let source = seeded(&a.0, "A");
    let mut target = seeded(&b.0, "B");
    fs::write(b.0.join("media/orphan.bin"), b"synthetic unreferenced").unwrap();
    fs::write(b.0.join("previews/cache"), b"cache").unwrap();
    let before = tree(&b.0);
    let dest = f.0.join("a.sgbak");
    source.export_backup(&dest, "1").unwrap();
    let out = target.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(target.state_json(), source.state_json());
    for (p, v) in before
        .iter()
        .filter(|(p, _)| p.starts_with("media") || p.as_os_str() == "state.json")
    {
        assert_eq!(&fs::read(out.safety_backup_dir.join(p)).unwrap(), v);
    }
    assert!(out.safety_backup_dir.join("SAFETY.json").exists());
    assert!(out
        .safety_backup_dir
        .join("replaced/media/orphan.bin")
        .exists());
    assert_eq!(fs::read_dir(b.0.join("previews")).unwrap().count(), 0);
    clean(&b.0);
}
#[test]
fn export_is_read_only_including_mtimes_and_refuses_existing_dest() {
    let a = Temp::new("read-only");
    let f = Temp::new("read-only-file");
    let s = seeded(&a.0, "source");
    let before = tree(&a.0);
    let mtimes: Vec<_> = before
        .keys()
        .map(|p| fs::metadata(a.0.join(p)).unwrap().modified().unwrap())
        .collect();
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    assert_eq!(tree(&a.0), before);
    assert_eq!(
        before
            .keys()
            .map(|p| fs::metadata(a.0.join(p)).unwrap().modified().unwrap())
            .collect::<Vec<_>>(),
        mtimes
    );
    let b = fs::read(&dest).unwrap();
    assert_eq!(
        s.export_backup(&dest, "1").unwrap_err().code,
        "BACKUP_DEST_EXISTS"
    );
    assert_eq!(fs::read(dest).unwrap(), b);
    clean(&f.0);
}
#[test]
fn empty_unpersisted_library_roundtrips() {
    let a = Temp::new("empty-a");
    let b = Temp::new("empty-b");
    let f = Temp::new("empty-file");
    let s = Store::open(&a.0).unwrap();
    let dest = f.0.join("empty.sgbak");
    s.export_backup(&dest, "1").unwrap();
    assert!(!a.0.join("state.json").exists());
    assert_eq!(verify_backup(&dest).unwrap().counts.formal, 0);
    let mut target = Store::open_exclusive(&b.0).unwrap();
    target.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(target.state_json(), s.state_json());
}
#[test]
fn export_reloads_disk_snapshot_and_reports_corrupt_media() {
    let a = Temp::new("reload");
    let f = Temp::new("reload-file");
    let stale = Store::open(&a.0).unwrap();
    let mut other = Store::open(&a.0).unwrap();
    let id = draft(&mut other, "new");
    let p = photo(&mut other, &id, "corrupt");
    fs::write(other.asset_path(&p.asset_id).unwrap(), b"damaged synthetic").unwrap();
    let dest = f.0.join("x.sgbak");
    stale.export_backup(&dest, "1").unwrap();
    let info = verify_backup(&dest).unwrap();
    assert_eq!(info.counts.drafts, 1);
    assert_eq!(info.counts.missing_media, 1);
    assert_eq!(info.counts.media_files, 0);
}
#[test]
fn restore_requires_exclusive_and_verify_does_not_create_store() {
    let a = Temp::new("nonexclusive");
    let f = Temp::new("nonexclusive-file");
    let mut s = Store::open(&a.0).unwrap();
    let before = tree(&a.0);
    assert_eq!(
        s.restore_backup_overwrite(&f.0.join("absent"))
            .unwrap_err()
            .code,
        "STORE_NOT_EXCLUSIVE"
    );
    assert_eq!(tree(&a.0), before);
    assert!(verify_backup(&f.0.join("absent")).is_err());
    assert!(tree(&f.0).is_empty());
}
fn bad_case(name: &str) {
    let a = Temp::new(name);
    let b = Temp::new("bad-target");
    let f = Temp::new("bad-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let original = fs::read(&dest).unwrap();
    let (mut m, mut payloads) = unpack(&original);
    let (bytes, code) = match name {
        "media_outer" => {
            let mut v = original.clone();
            let n = u64::from_le_bytes(v[8..16].try_into().unwrap()) as usize;
            v[16 + n + payloads[0].len()] ^= 1;
            (v, "BACKUP_CORRUPT")
        }
        "media_inner" => {
            payloads[1][0] ^= 1;
            (pack(&m, &payloads), "BACKUP_CORRUPT")
        }
        "entry_sha" => {
            edit_entries(&mut m, |e| {
                set(&mut e[1], "sha256", Json::str("0".repeat(64)))
            });
            (pack(&m, &payloads), "BACKUP_CORRUPT")
        }
        "schema" => {
            set(&mut m, "schemaVersion", Json::Num(99));
            (pack(&m, &payloads), "BACKUP_SCHEMA_TOO_NEW")
        }
        "encrypted" => {
            set(
                &mut m,
                "encryption",
                Json::obj(vec![("mode", Json::str("aes"))]),
            );
            (pack(&m, &payloads), "BACKUP_ENCRYPTED_UNSUPPORTED")
        }
        "format" => {
            set(&mut m, "formatVersion", Json::Num(2));
            (pack(&m, &payloads), "BACKUP_FORMAT_TOO_NEW")
        }
        "traversal_media" | "traversal_state" | "backslash" | "absolute" | "dot" | "long_name"
        | "double_dot" => {
            let path = match name {
                "traversal_media" => "media/../x".into(),
                "traversal_state" => "../state.json".into(),
                "backslash" => "media/a\\b".into(),
                "absolute" => "/state.json".into(),
                "dot" => "media/.hidden".into(),
                "double_dot" => "media/a..b".into(),
                _ => format!("media/{}", "a".repeat(129)),
            };
            edit_entries(&mut m, |e| set(&mut e[1], "path", Json::str(path)));
            (pack(&m, &payloads), "BACKUP_INVALID")
        }
        "duplicate" => {
            edit_entries(&mut m, |e| e.push(e[0].clone()));
            payloads.push(payloads[0].clone());
            (pack(&m, &payloads), "BACKUP_INVALID")
        }
        "missing_state" => {
            edit_entries(&mut m, |e| {
                e.remove(0);
            });
            payloads.remove(0);
            (pack(&m, &payloads), "BACKUP_INVALID")
        }
        "missing_field" => {
            let Json::Obj(e) = &mut m else { panic!() };
            e.retain(|(k, _)| k != "counts");
            (pack(&m, &payloads), "BACKUP_INVALID")
        }
        "counts" => {
            let mut c = m.get("counts").unwrap().clone();
            set(&mut c, "formal", Json::Num(7));
            set(&mut m, "counts", c);
            (pack(&m, &payloads), "BACKUP_CORRUPT")
        }
        "size" => {
            edit_entries(&mut m, |e| set(&mut e[0], "size", Json::Num(i64::MAX)));
            (pack(&m, &payloads), "BACKUP_INVALID")
        }
        "absent_reference" => {
            edit_entries(&mut m, |e| {
                e.remove(1);
            });
            payloads.remove(1);
            let mut c = m.get("counts").unwrap().clone();
            set(&mut c, "mediaFiles", Json::Num(0));
            set(&mut m, "counts", c);
            (pack(&m, &payloads), "BACKUP_CORRUPT")
        }
        "invalid_state" => {
            payloads[0] = b"{}".to_vec();
            edit_entries(&mut m, |e| {
                set(&mut e[0], "size", Json::Num(2));
                set(&mut e[0], "sha256", Json::str(sha256::hex_digest(b"{}")));
            });
            (pack(&m, &payloads), "BACKUP_CORRUPT")
        }
        _ => panic!("unknown {name}"),
    };
    fs::write(&dest, bytes).unwrap();
    let before = tree(&b.0);
    let file_tree = tree(&f.0);
    assert_eq!(verify_backup(&dest).unwrap_err().code, code, "{name}");
    assert_eq!(tree(&f.0), file_tree);
    assert_eq!(
        t.restore_backup_overwrite(&dest).unwrap_err().code,
        code,
        "{name}"
    );
    assert_eq!(tree(&b.0), before);
    clean(&b.0);
}
macro_rules! cases { ($($name:ident),*) => {$ (#[test] fn $name(){bad_case(stringify!($name));})*}; }
cases!(
    media_outer,
    media_inner,
    entry_sha,
    schema,
    encrypted,
    format,
    traversal_media,
    traversal_state,
    backslash,
    absolute,
    dot,
    long_name,
    double_dot,
    duplicate,
    missing_state,
    missing_field,
    counts,
    size,
    absent_reference,
    invalid_state
);
#[test]
fn truncation_and_nonbackup_never_modify_target() {
    let a = Temp::new("trunc-a");
    let b = Temp::new("trunc-b");
    let f = Temp::new("trunc-file");
    let s = seeded(&a.0, "source");
    let mut t = seeded(&b.0, "target");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let bytes = fs::read(&dest).unwrap();
    let before = tree(&b.0);
    for n in [
        0,
        1,
        7,
        8,
        15,
        16,
        63,
        64,
        bytes.len() / 2,
        bytes.len() - 24,
        bytes.len() - 1,
    ] {
        fs::write(&dest, &bytes[..n]).unwrap();
        let e = t.restore_backup_overwrite(&dest).unwrap_err();
        assert!(
            ["BACKUP_INVALID", "BACKUP_TRUNCATED"].contains(&e.code),
            "{n}: {e}"
        );
        assert_eq!(tree(&b.0), before);
        clean(&b.0);
    }
    fs::write(&dest, b"plain synthetic nonbackup document").unwrap();
    assert_eq!(verify_backup(&dest).unwrap_err().code, "BACKUP_INVALID");
    assert_eq!(
        t.restore_backup_overwrite(&dest).unwrap_err().code,
        "BACKUP_INVALID"
    );
    assert_eq!(tree(&b.0), before);
}
#[test]
fn legacy_v1_container_restores_and_migrates_to_v2() {
    let a = Temp::new("v1-a");
    let b = Temp::new("v1-b");
    let f = Temp::new("v1-file");
    let s = seeded(&a.0, "legacy");
    let dest = f.0.join("v1.sgbak");
    s.export_backup(&dest, "old").unwrap();
    let (mut m, mut p) = unpack(&fs::read(&dest).unwrap());
    let mut state = shiguang_core::json::parse(std::str::from_utf8(&p[0]).unwrap()).unwrap();
    let Json::Obj(fields) = &mut state else {
        panic!()
    };
    fields.retain(|(k, _)| {
        !["schemaVersion", "deletionMarkers", "conflictCopies"].contains(&k.as_str())
    });
    for (_, v) in fields.iter_mut().filter(|(k, _)| k == "records") {
        let Json::Arr(rows) = v else { panic!() };
        for row in rows {
            let Json::Obj(f) = row else { panic!() };
            f.retain(|(k, _)| !["status", "trashedAt"].contains(&k.as_str()));
        }
    }
    p[0] = state.pretty().into_bytes();
    set(&mut m, "schemaVersion", Json::Num(1));
    edit_entries(&mut m, |e| {
        set(&mut e[0], "size", Json::Num(p[0].len() as i64));
        set(&mut e[0], "sha256", Json::str(sha256::hex_digest(&p[0])));
    });
    fs::write(&dest, pack(&m, &p)).unwrap();
    assert_eq!(verify_backup(&dest).unwrap().schema_version, 1);
    let mut t = Store::open_exclusive(&b.0).unwrap();
    t.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(t.state_json(), s.state_json());
    drop(t);
    assert_eq!(Store::open(&b.0).unwrap().state_json(), s.state_json());
}
#[test]
fn open_removes_only_abandoned_staging_without_journal() {
    let a = Temp::new("orphan-stage");
    fs::create_dir(a.0.join(".restore-staging-abandoned")).unwrap();
    fs::write(a.0.join(".restore-staging-abandoned/file"), b"synthetic").unwrap();
    fs::create_dir(a.0.join(".restore-old-preserve")).unwrap();
    Store::open(&a.0).unwrap();
    assert!(!a.0.join(".restore-staging-abandoned").exists());
    assert!(a.0.join(".restore-old-preserve").exists());
}

#[test]
fn manifest_limits_and_portable_path_aliases_are_rejected_without_writes() {
    let a = Temp::new("bounds-a");
    let b = Temp::new("bounds-b");
    let f = Temp::new("bounds-file");
    let s = seeded(&a.0, "bounds");
    let mut t = seeded(&b.0, "target");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let (m, p) = unpack(&fs::read(&dest).unwrap());
    let before = tree(&b.0);
    for bad in [
        "media/CON",
        "media/nul.png",
        "media/LPT1.png",
        "media/file.",
    ] {
        let mut v = m.clone();
        edit_entries(&mut v, |e| set(&mut e[1], "path", Json::str(bad)));
        fs::write(&dest, pack(&v, &p)).unwrap();
        assert_eq!(
            t.restore_backup_overwrite(&dest).unwrap_err().code,
            "BACKUP_INVALID"
        );
        assert_eq!(tree(&b.0), before);
    }
    let mut v = m.clone();
    edit_entries(&mut v, |e| {
        let mut extra = e[1].clone();
        let path = extra
            .get("path")
            .and_then(Json::as_str)
            .unwrap()
            .to_ascii_uppercase()
            .replacen("MEDIA/", "media/", 1);
        set(&mut extra, "path", Json::str(path));
        e.push(extra);
    });
    let mut payloads = p.clone();
    payloads.push(p[1].clone());
    fs::write(&dest, pack(&v, &payloads)).unwrap();
    assert_eq!(verify_backup(&dest).unwrap_err().code, "BACKUP_INVALID");
    assert_eq!(
        t.restore_backup_overwrite(&dest).unwrap_err().code,
        "BACKUP_INVALID"
    );
    let mut v = m.clone();
    set(&mut v, "entries", Json::Arr(vec![Json::Null; 100_001]));
    fs::write(&dest, pack(&v, &[])).unwrap();
    assert_eq!(
        t.restore_backup_overwrite(&dest).unwrap_err().code,
        "BACKUP_INVALID"
    );
    let mut bytes = b"SGBAK\0\0\x01".to_vec();
    let n = 8 * 1024 * 1024 + 1;
    bytes.extend_from_slice(&(n as u64).to_le_bytes());
    bytes.resize(16 + n, b' ');
    seal(&mut bytes);
    fs::write(&dest, bytes).unwrap();
    assert_eq!(verify_backup(&dest).unwrap_err().code, "BACKUP_INVALID");
    assert_eq!(
        t.restore_backup_overwrite(&dest).unwrap_err().code,
        "BACKUP_INVALID"
    );
    assert_eq!(tree(&b.0), before);
    clean(&b.0);
}
#[test]
fn streaming_sha256_matches_standard_vectors_at_every_block_boundary() {
    use shiguang_core::sha256::Sha256;
    let bytes = vec![b'a'; 1_000_000];
    for chunk in [1, 7, 55, 56, 63, 64, 65, 8191, 65536] {
        let mut h = Sha256::new();
        h.update(&[]);
        for b in bytes.chunks(chunk) {
            h.update(b);
            h.update(&[]);
        }
        assert_eq!(
            sha256::hex(&h.finalize()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
#[test]
fn restored_seed_is_preserved_across_reopen_and_future_writes() {
    let a = Temp::new("seed-a");
    let b = Temp::new("seed-b");
    let f = Temp::new("seed-file");
    let s = seeded(&a.0, "seed");
    let mut state = s.state_json();
    drop(s);
    set(&mut state, "seed", Json::str("synthetic-foreign-seed"));
    fs::write(a.0.join("state.json"), state.pretty()).unwrap();
    let s = Store::open(&a.0).unwrap();
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    t.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(t.state_json(), s.state_json());
    drop(t);
    let mut t = Store::open(&b.0).unwrap();
    draft(&mut t, "future");
    assert_eq!(t.seed(), "synthetic-foreign-seed");
    assert_eq!(
        t.state_json().get("seed"),
        Some(&Json::str("synthetic-foreign-seed"))
    );
}
#[cfg(unix)]
#[test]
fn symlink_media_and_journal_escape_never_write_outside_root() {
    use std::os::unix::fs::symlink;
    let a = Temp::new("link-a");
    let b = Temp::new("link-b");
    let f = Temp::new("link-file");
    let outside = Temp::new("outside");
    let s = seeded(&a.0, "source");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    fs::remove_dir(b.0.join("media")).unwrap();
    symlink(&outside.0, b.0.join("media")).unwrap();
    fs::write(outside.0.join("keep"), b"synthetic outside").unwrap();
    let before = tree(&outside.0);
    assert!(t.restore_backup_overwrite(&dest).is_err());
    assert_eq!(tree(&outside.0), before);
    drop(t);
    fs::remove_file(b.0.join("media")).unwrap();
    fs::create_dir(b.0.join("media")).unwrap();
    let journal = Json::obj(vec![
        ("phase", Json::str("switching")),
        ("staging", Json::str("../outside")),
        ("old", Json::str("../outside")),
        ("safety", Json::str("../outside")),
        ("stateSha256", Json::str("0".repeat(64))),
    ]);
    fs::write(b.0.join(".restore-journal.json"), journal.dump()).unwrap();
    assert!(Store::open(&b.0).is_err());
    assert_eq!(tree(&outside.0), before);
}

#[test]
fn malformed_json_and_excessive_nesting_fail_before_any_restore_write() {
    let a = Temp::new("strict-a");
    let b = Temp::new("strict-b");
    let f = Temp::new("strict-file");
    let s = seeded(&a.0, "strict");
    let mut t = seeded(&b.0, "target");
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let (m, p) = unpack(&fs::read(&dest).unwrap());
    let before = tree(&b.0);
    let leading_zero = m
        .dump()
        .replacen("\"formatVersion\":1", "\"formatVersion\":01", 1);
    let deep = format!("{{\"unknown\":{}0{}}}", "[".repeat(256), "]".repeat(256));
    for raw in [
        leading_zero,
        deep,
        "{\"format\":\"x\",\"format\":\"x\"}".into(),
    ] {
        let mut bytes = b"SGBAK\0\0\x01".to_vec();
        bytes.extend_from_slice(&(raw.len() as u64).to_le_bytes());
        bytes.extend_from_slice(raw.as_bytes());
        for payload in &p {
            bytes.extend_from_slice(payload);
        }
        seal(&mut bytes);
        fs::write(&dest, bytes).unwrap();
        assert_eq!(verify_backup(&dest).unwrap_err().code, "BACKUP_INVALID");
        assert_eq!(
            t.restore_backup_overwrite(&dest).unwrap_err().code,
            "BACKUP_INVALID"
        );
        assert_eq!(tree(&b.0), before);
        clean(&b.0);
    }
}

#[test]
fn large_original_roundtrips_across_multiple_stream_buffers() {
    let a = Temp::new("large-a");
    let b = Temp::new("large-b");
    let f = Temp::new("large-file");
    let mut s = Store::open(&a.0).unwrap();
    let id = draft(&mut s, "large synthetic");
    let bytes: Vec<u8> = (0..(5 * 65536 + 17)).map(|i| (i % 251) as u8).collect();
    let photo = s
        .attach_photo_bytes(&id, "large.bin", &bytes, "大合成原图", None)
        .unwrap();
    s.commit(&id, 0).unwrap();
    let dest = f.0.join("x.sgbak");
    s.export_backup(&dest, "1").unwrap();
    let mut t = Store::open_exclusive(&b.0).unwrap();
    let report = t.restore_backup_overwrite(&dest).unwrap();
    assert_eq!(t.state_json(), s.state_json());
    assert_eq!(
        fs::read(t.asset_path(&photo.asset_id).unwrap()).unwrap(),
        bytes
    );
    assert!(report.media_report.missing.is_empty());
    assert!(report.media_report.corrupt.is_empty());
    assert!(report.media_report.quarantined.is_empty());
}
