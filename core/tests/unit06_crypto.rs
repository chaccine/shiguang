mod unit05_support;
use shiguang_core::{
    backup::{decrypt_backup, is_encrypted, verify_backup},
    KdfParams, Store,
};
use std::fs;
use unit05_support::*;
const PASSWORD: &str = "synthetic-unit06-secret";
const WRONG: &str = "synthetic-unit06-other";
fn encrypted() -> (Temp, Temp, std::path::PathBuf) {
    let a = Temp::new("enc-a");
    let f = Temp::new("enc-f");
    let s = seeded(&a.0, "encrypted synthetic");
    let path = f.0.join("x.sgbak");
    s.export_backup_encrypted(&path, "1", PASSWORD, KdfParams::fast())
        .unwrap();
    (a, f, path)
}
#[test]
fn encrypted_roundtrip_password_wrappers_and_required_error() {
    let (a, _f, path) = encrypted();
    assert!(is_encrypted(&path));
    assert_eq!(
        verify_backup(&path).unwrap_err().code,
        "BACKUP_PASSWORD_REQUIRED"
    );
    let b = Temp::new("enc-b");
    let mut t = Store::open_exclusive(&b.0).unwrap();
    let before = tree(&b.0);
    let p = t.plan_merge_with_password(&path, PASSWORD).unwrap();
    assert_eq!(before, tree(&b.0));
    assert_eq!(p.added, 1);
    t.merge_backup_with_password(&path, PASSWORD).unwrap();
    let c = Temp::new("enc-c");
    let mut u = Store::open_exclusive(&c.0).unwrap();
    u.restore_backup_overwrite_with_password(&path, PASSWORD)
        .unwrap();
    assert_eq!(Store::open(&a.0).unwrap().state_json(), u.state_json());
    clean_crypto(&b.0);
    clean_crypto(&c.0);
}
fn clean_crypto(root: &std::path::Path) {
    for p in tree(root).keys() {
        let s = p.to_string_lossy();
        assert!(!s.contains(".decrypt-") && !s.contains(".encrypt-") && !s.contains(".partial-"));
    }
}
#[test]
fn wrong_password_never_leaks_in_message_debug_or_changes_destination() {
    let (_a, f, path) = encrypted();
    let dest = f.0.join("plain");
    fs::write(&dest, b"synthetic keep").unwrap();
    let e = decrypt_backup(&path, &dest, WRONG).unwrap_err();
    assert!(!e.message.contains(PASSWORD) && !e.message.contains(WRONG));
    assert!(!format!("{e:?}").contains(PASSWORD) && !format!("{e:?}").contains(WRONG));
    assert_eq!(fs::read(&dest).unwrap(), b"synthetic keep");
    fs::remove_file(&dest).unwrap();
    let e = decrypt_backup(&path, &dest, WRONG).unwrap_err();
    assert_eq!(e.code, "BACKUP_PASSWORD_WRONG");
    assert!(!dest.exists());
}
#[test]
fn empty_password_and_invalid_kdf_rejected_without_artifacts() {
    let a = Temp::new("empty");
    let f = Temp::new("empty-f");
    let s = seeded(&a.0, "content");
    let before = tree(&a.0);
    let p = f.0.join("x");
    assert_eq!(
        s.export_backup_encrypted(&p, "1", "", KdfParams::fast())
            .unwrap_err()
            .code,
        "BACKUP_PASSWORD_EMPTY"
    );
    for params in [
        KdfParams { m: 7, t: 1, p: 1 },
        KdfParams {
            m: 1_048_577,
            t: 1,
            p: 1,
        },
        KdfParams { m: 8, t: 11, p: 1 },
        KdfParams { m: 8, t: 1, p: 5 },
    ] {
        assert_eq!(
            s.export_backup_encrypted(&p, "1", PASSWORD, params)
                .unwrap_err()
                .code,
            "BACKUP_KDF_PARAMS_INVALID"
        );
    }
    assert_eq!(tree(&a.0), before);
    assert!(tree(&f.0).is_empty());
    let d = KdfParams::default();
    assert_eq!((d.m, d.t, d.p), (65536, 3, 1));
}
#[test]
fn multichunk_tamper_truncation_header_aad_and_reorder_rejected() {
    let a = Temp::new("chunks");
    let f = Temp::new("chunks-f");
    let mut s = Store::open(&a.0).unwrap();
    let id = draft(&mut s, "chunks");
    s.attach_photo_bytes(
        &id,
        "large.bin",
        &vec![42; 2 * 1024 * 1024 + 77],
        "synthetic",
        None,
    )
    .unwrap();
    s.commit(&id, 0).unwrap();
    let path = f.0.join("enc");
    s.export_backup_encrypted(&path, "1", PASSWORD, KdfParams::fast())
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    let h = 14 + u32::from_le_bytes(bytes[10..14].try_into().unwrap()) as usize;
    let chunk = 1024 * 1024 + 16;
    let mut cases = vec![
        bytes[..h].to_vec(),
        bytes[..bytes.len() / 2].to_vec(),
        bytes[..h + chunk].to_vec(),
        bytes[..bytes.len() - 1].to_vec(),
    ];
    for pos in [h, h + chunk, bytes.len() - 1] {
        let mut b = bytes.clone();
        b[pos] ^= 1;
        cases.push(b);
    }
    let mut swapped = bytes.clone();
    let first = swapped[h..h + chunk].to_vec();
    let second = swapped[h + chunk..h + 2 * chunk].to_vec();
    swapped[h..h + chunk].copy_from_slice(&second);
    swapped[h + chunk..h + 2 * chunk].copy_from_slice(&first);
    cases.push(swapped);
    let mut aad = bytes.clone();
    let index = bytes[14..h].windows(3).position(|w| w == b"\"t\"").unwrap() + 14 + 4;
    aad[index] = b'2';
    cases.push(aad);
    for (i, b) in cases.into_iter().enumerate() {
        let input = f.0.join(format!("bad-{i}"));
        fs::write(&input, b).unwrap();
        let dest = f.0.join("plain");
        let e = decrypt_backup(&input, &dest, PASSWORD).unwrap_err();
        assert!([
            "BACKUP_CORRUPT",
            "BACKUP_TRUNCATED",
            "BACKUP_PASSWORD_WRONG",
            "BACKUP_KDF_PARAMS_INVALID"
        ]
        .contains(&e.code));
        assert!(!e.message.contains(PASSWORD));
        assert!(!dest.exists());
    }
}
#[test]
fn wrong_password_wrappers_preserve_entire_existing_root() {
    let (_a, _f, path) = encrypted();
    let b = Temp::new("wrong-target");
    let mut t = seeded(&b.0, "local synthetic");
    let before = tree(&b.0);
    let errors = [
        t.plan_merge_with_password(&path, WRONG).unwrap_err(),
        t.merge_backup_with_password(&path, WRONG).unwrap_err(),
        t.restore_backup_overwrite_with_password(&path, WRONG)
            .unwrap_err(),
    ];
    for e in errors {
        assert_eq!(e.code, "BACKUP_PASSWORD_WRONG");
        assert!(!e.message.contains(PASSWORD) && !e.message.contains(WRONG));
        assert!(!format!("{e:?}").contains(PASSWORD) && !format!("{e:?}").contains(WRONG));
    }
    assert_eq!(tree(&b.0), before);
}
#[test]
fn untrusted_header_kdf_bounds_and_algorithms_are_rejected_before_plaintext() {
    use shiguang_core::json::{self, Json};
    let (_a, f, path) = encrypted();
    let bytes = fs::read(path).unwrap();
    let end = 14 + u32::from_le_bytes(bytes[10..14].try_into().unwrap()) as usize;
    let original = json::parse(std::str::from_utf8(&bytes[14..end]).unwrap()).unwrap();
    for (key, value) in [
        ("m", 7),
        ("m", 1_048_577),
        ("m", i64::MAX),
        ("t", 0),
        ("t", 11),
        ("p", 0),
        ("p", 5),
    ] {
        let mut header = original.clone();
        let mut k = header.get("kdf").unwrap().clone();
        set(&mut k, key, Json::Num(value));
        set(&mut header, "kdf", k);
        let h = header.dump();
        let mut bad = b"SGBAKENC\0\x01".to_vec();
        bad.extend_from_slice(&(h.len() as u32).to_le_bytes());
        bad.extend_from_slice(h.as_bytes());
        bad.extend_from_slice(&bytes[end..]);
        let input = f.0.join("bad");
        fs::write(&input, bad).unwrap();
        let output = f.0.join("out");
        let e = decrypt_backup(&input, &output, PASSWORD).unwrap_err();
        assert_eq!(e.code, "BACKUP_KDF_PARAMS_INVALID");
        assert!(!output.exists());
    }
    let mut missing = original.clone();
    let Json::Obj(fields) = &mut missing else {
        panic!()
    };
    fields.retain(|(key, _)| key != "plaintextBytes");
    let header = missing.dump();
    let mut malformed = b"SGBAKENC\0\x01".to_vec();
    malformed.extend_from_slice(&(header.len() as u32).to_le_bytes());
    malformed.extend_from_slice(header.as_bytes());
    malformed.extend_from_slice(&bytes[end..]);
    let input = f.0.join("missing-field");
    fs::write(&input, malformed).unwrap();
    assert_eq!(
        decrypt_backup(&input, &f.0.join("out"), PASSWORD)
            .unwrap_err()
            .code,
        "BACKUP_CORRUPT"
    );
    for index in [0, 13, 14, end - 1] {
        let mut b = bytes.clone();
        b[index] ^= 0x40;
        let input = f.0.join("bad");
        fs::write(&input, b).unwrap();
        assert!(decrypt_backup(&input, &f.0.join("out"), PASSWORD).is_err());
        assert!(!f.0.join("out").exists());
    }
}
