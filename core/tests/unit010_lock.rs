mod unit05_support;
use shiguang_core::{
    backup,
    json::{self, Json},
    DraftPatch, KdfParams, Store, ThemePreference,
};
use std::{fs, path::Path};
use unit05_support::*;
fn lock_json(s: &Store) -> Json {
    s.state_json()
        .get("settings")
        .unwrap()
        .get("appLock")
        .unwrap()
        .clone()
}

#[test]
fn default_settings_and_passcode_format_validation_never_echo_inputs() {
    let t = Temp::new("u010-lock-default");
    let mut s = Store::open(&t.0).unwrap();
    let settings = s.settings().unwrap();
    assert_eq!(settings.theme, ThemePreference::System);
    assert!(!settings.app_lock.enabled);
    assert_eq!(
        s.verify_app_lock("482615").unwrap_err().code,
        "APP_LOCK_NOT_SET"
    );
    assert_eq!(
        s.disable_app_lock("482615").unwrap_err().code,
        "APP_LOCK_NOT_SET"
    );
    for bad in [
        "",
        "123",
        "123456789",
        "１２３４",
        "12 34",
        "1234\n",
        "1234\r",
        "1234\r\n",
        "<script>synthetic</script>",
    ] {
        let error = s.set_app_lock(bad).unwrap_err();
        assert_eq!(error.code, "APP_LOCK_CODE_INVALID");
        if !bad.is_empty() {
            assert!(!format!("{error} {error:?} {}", error.to_json().dump()).contains(bad));
        }
        assert!(!s.settings().unwrap().app_lock.enabled);
    }
    for value in ["1234", "12345678"] {
        s.set_app_lock(value).unwrap();
        s.verify_app_lock(value).unwrap();
        s.disable_app_lock(value).unwrap();
    }
}
#[test]
fn argon2id_random_salts_stored_parameters_and_no_plaintext_or_ipc_verifier() {
    let a = Temp::new("u010-salt-a");
    let b = Temp::new("u010-salt-b");
    let mut a = Store::open(&a.0).unwrap();
    let mut b = Store::open(&b.0).unwrap();
    a.set_app_lock("482615").unwrap();
    b.set_app_lock("482615").unwrap();
    let x = lock_json(&a);
    let y = lock_json(&b);
    assert_ne!(x.get("salt"), y.get("salt"));
    assert_ne!(x.get("hash"), y.get("hash"));
    assert_eq!(x.get("algorithm"), Some(&Json::str("argon2id")));
    assert_eq!(x.get("version"), Some(&Json::Num(19)));
    for (key, value) in [("m", 65536), ("t", 3), ("p", 1)] {
        assert_eq!(x.get(key), Some(&Json::Num(value)));
    }
    let ipc = a.settings().unwrap().to_json().dump();
    assert!(!ipc.contains("hash") && !ipc.contains("salt") && !ipc.contains("482615"));
    let raw = fs::read_to_string(a.root().join("state.json")).unwrap();
    assert!(!raw.contains("\"482615\""));
    // Independent primitive check: this persisted verifier is actually Argon2id.
    fn hex<const N: usize>(v: &Json, key: &str) -> [u8; N] {
        let text = v.get(key).unwrap().as_str().unwrap();
        let mut out = [0; N];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    let salt: [u8; 16] = hex(&x, "salt");
    let expected: [u8; 32] = hex(&x, "hash");
    let mut hash = [0; 32];
    argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(65536, 3, 1, Some(32)).unwrap(),
    )
    .hash_password_into(b"482615", &salt, &mut hash)
    .unwrap();
    assert_eq!(hash, expected);
}
#[test]
fn set_verify_change_disable_require_current_and_remain_persisted_after_reopen() {
    let t = Temp::new("u010-lock-ops");
    let mut s = Store::open(&t.0).unwrap();
    s.set_app_lock("482615").unwrap();
    assert_eq!(
        s.set_app_lock("123456").unwrap_err().code,
        "APP_LOCK_ALREADY_SET"
    );
    assert_eq!(
        s.verify_app_lock("wrong-synthetic").unwrap_err().code,
        "APP_LOCK_WRONG"
    );
    assert_eq!(s.settings().unwrap().app_lock.failed_attempts, 1);
    s.verify_app_lock("482615").unwrap();
    assert_eq!(s.settings().unwrap().app_lock.failed_attempts, 0);
    assert_eq!(
        s.change_app_lock("wrong-synthetic", "123456")
            .unwrap_err()
            .code,
        "APP_LOCK_WRONG"
    );
    let old = lock_json(&s);
    assert_eq!(
        s.change_app_lock("482615", "invalid-new").unwrap_err().code,
        "APP_LOCK_CODE_INVALID"
    );
    assert_eq!(lock_json(&s), old);
    s.change_app_lock("482615", "123456").unwrap();
    assert_ne!(lock_json(&s).get("salt"), old.get("salt"));
    drop(s);
    let mut s = Store::open(&t.0).unwrap();
    assert_eq!(
        s.verify_app_lock("482615").unwrap_err().code,
        "APP_LOCK_WRONG"
    );
    s.verify_app_lock("123456").unwrap();
    assert_eq!(
        s.disable_app_lock("482615").unwrap_err().code,
        "APP_LOCK_WRONG"
    );
    s.disable_app_lock("123456").unwrap();
    drop(s);
    let s = Store::open(&t.0).unwrap();
    assert!(!s.settings().unwrap().app_lock.enabled);
    assert_eq!(lock_json(&s), Json::Null);
}
#[test]
fn real_command_backoff_survives_restart_and_cannot_be_reset_by_set_change_disable() {
    let t = Temp::new("u010-lock-backoff");
    let mut s = Store::open(&t.0).unwrap();
    s.set_app_lock("482615").unwrap();
    for _ in 0..3 {
        assert_eq!(
            s.verify_app_lock("invalid").unwrap_err().code,
            "APP_LOCK_WRONG"
        );
    }
    assert_eq!(s.settings().unwrap().app_lock.failed_attempts, 3);
    assert!(s.settings().unwrap().app_lock.retry_after_ms > 0);
    let counter = lock_json(&s);
    drop(s);
    let mut s = Store::open(&t.0).unwrap();
    assert_eq!(lock_json(&s), counter);
    let before = fs::read(t.0.join("state.json")).unwrap();
    for result in [
        s.verify_app_lock("482615"),
        s.change_app_lock("482615", "123456"),
        s.disable_app_lock("482615"),
    ] {
        assert_eq!(result.unwrap_err().code, "APP_LOCK_THROTTLED");
    }
    assert_eq!(
        s.set_app_lock("123456").unwrap_err().code,
        "APP_LOCK_ALREADY_SET"
    );
    assert_eq!(fs::read(t.0.join("state.json")).unwrap(), before);
}
#[test]
fn theme_persists_without_touching_content_and_stale_store_preserves_lock() {
    let t = Temp::new("u010-theme");
    let mut s = Store::open(&t.0).unwrap();
    let id = draft(&mut s, "合成正文");
    s.commit(&id, 0).unwrap();
    s.save_draft_patch(
        &id,
        &DraftPatch {
            location: Some("待提交地点".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let row = s.row(&id).unwrap().to_json();
    let mut stale = Store::open(&t.0).unwrap();
    s.set_app_lock("482615").unwrap();
    let credential = lock_json(&s);
    for theme in [
        ThemePreference::Light,
        ThemePreference::Dark,
        ThemePreference::System,
    ] {
        stale.set_theme(theme).unwrap();
        assert_eq!(lock_json(&stale), credential);
        drop(s);
        s = Store::open(&t.0).unwrap();
        assert_eq!(s.settings().unwrap().theme, theme);
        assert_eq!(s.row(&id).unwrap().to_json(), row);
    }
    assert_eq!(
        ThemePreference::parse("blue").unwrap_err().code,
        "THEME_INVALID"
    );
}
#[test]
fn portable_plain_encrypted_backups_omit_lock_and_overwrite_preserves_target_lock() {
    let t = Temp::new("u010-lock-backup");
    let mut src = seeded(&t.0.join("src"), "合成源");
    src.set_theme(ThemePreference::Dark).unwrap();
    src.set_app_lock("482615").unwrap();
    let source_credential = lock_json(&src);
    let before = src.state_json();
    for encrypted in [false, true] {
        let file = t.0.join(if encrypted { "encrypted" } else { "plain" });
        if encrypted {
            src.export_backup_encrypted(
                &file,
                "0.1.10",
                "synthetic-backup-pass",
                KdfParams::fast(),
            )
            .unwrap();
        } else {
            src.export_backup(&file, "0.1.10").unwrap();
        }
        let plain = if encrypted {
            let p = t.0.join("decoded");
            backup::decrypt_backup(&file, &p, "synthetic-backup-pass").unwrap();
            p
        } else {
            file.clone()
        };
        let (_, entries) = unpack(&fs::read(&plain).unwrap());
        let text = std::str::from_utf8(&entries[0]).unwrap();
        let packed = json::parse(text).unwrap();
        assert_eq!(
            packed.get("settings").unwrap().get("appLock"),
            Some(&Json::Null)
        );
        assert!(!text.contains(source_credential.get("hash").unwrap().as_str().unwrap()));
        for locked in [false, true] {
            let mut dest =
                Store::open_exclusive(t.0.join(format!("dest-{encrypted}-{locked}"))).unwrap();
            if locked {
                dest.set_app_lock("123456").unwrap();
                dest.verify_app_lock("wrong-synthetic").unwrap_err();
            }
            let local_lock = lock_json(&dest);
            if encrypted {
                dest.restore_backup_overwrite_with_password(&file, "synthetic-backup-pass")
                    .unwrap();
            } else {
                dest.restore_backup_overwrite(&file).unwrap();
            }
            assert_eq!(lock_json(&dest), local_lock);
            assert_eq!(dest.settings().unwrap().theme, ThemePreference::Dark);
            if locked {
                dest.verify_app_lock("123456").unwrap();
            } else {
                assert!(!dest.settings().unwrap().app_lock.enabled);
            }
        }
        assert_eq!(src.state_json(), before);
    }
}
#[test]
fn v3_restore_retains_existing_lock_and_counter_and_merge_never_imports_settings() {
    let t = Temp::new("u010-lock-old");
    let mut d = Store::open_exclusive(t.0.join("dest")).unwrap();
    d.set_app_lock("482615").unwrap();
    d.verify_app_lock("invalid").unwrap_err();
    let local_lock = lock_json(&d);
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v3/plain.sgbak");
    d.restore_backup_overwrite(&fixture).unwrap();
    assert_eq!(lock_json(&d), local_lock);
    d.set_theme(ThemePreference::Light).unwrap();
    let mut src = Store::open_exclusive(t.0.join("src")).unwrap();
    src.set_theme(ThemePreference::Dark).unwrap();
    src.set_app_lock("123456").unwrap();
    draft(&mut src, "合成导入");
    let file = t.0.join("incoming");
    src.export_backup(&file, "synthetic").unwrap();
    d.merge_backup(&file).unwrap();
    assert_eq!(lock_json(&d), local_lock);
    assert_eq!(d.settings().unwrap().theme, ThemePreference::Light);
    let bytes = fs::read(d.root().join("state.json")).unwrap();
    d.merge_backup(&file).unwrap();
    assert_eq!(fs::read(d.root().join("state.json")).unwrap(), bytes);
}
#[test]
fn malformed_lock_parameters_fail_closed_without_leaking_hash_or_rewriting_state() {
    let t = Temp::new("u010-lock-malformed");
    let mut s = Store::open(&t.0).unwrap();
    s.set_app_lock("482615").unwrap();
    let base = s.state_json();
    let lock = lock_json(&s);
    drop(s);
    for (field, value) in [
        ("m", Json::Num(8)),
        ("m", Json::Num(1_048_576)),
        ("t", Json::Num(0)),
        ("p", Json::Num(20)),
        ("algorithm", Json::str("other")),
        ("hash", Json::str("482615")),
        ("blockedUntilMs", Json::Num(-1)),
    ] {
        let mut v = base.clone();
        let mut settings = v.get("settings").unwrap().clone();
        let mut credential = lock.clone();
        set(&mut credential, field, value);
        set(&mut settings, "appLock", credential);
        set(&mut v, "settings", settings);
        let bytes = v.pretty().into_bytes();
        fs::write(t.0.join("state.json"), &bytes).unwrap();
        let error = Store::open(&t.0).err().unwrap();
        assert_eq!(error.code, "STATE_CORRUPT");
        assert!(!format!("{error:?}").contains("482615"));
        assert_eq!(fs::read(t.0.join("state.json")).unwrap(), bytes);
    }
}

#[test]
fn crafted_backup_lock_never_overrides_target_lock_in_overwrite_or_merge() {
    let t = Temp::new("u010-crafted-lock");
    let mut source = seeded(&t.0.join("source"), "合成外来记录");
    source.set_theme(ThemePreference::Dark).unwrap();
    source.set_app_lock("123456").unwrap();
    let portable = t.0.join("portable.sgbak");
    source.export_backup(&portable, "0.1.10").unwrap();
    let (mut manifest, mut payloads) = unpack(&fs::read(portable).unwrap());
    let mut state = json::parse(std::str::from_utf8(&payloads[0]).unwrap()).unwrap();
    let mut settings = state.get("settings").unwrap().clone();
    set(&mut settings, "appLock", lock_json(&source));
    set(&mut state, "settings", settings);
    payloads[0] = state.dump().into_bytes();
    edit_entries(&mut manifest, |entries| {
        set(&mut entries[0], "size", Json::Num(payloads[0].len() as i64));
        set(
            &mut entries[0],
            "sha256",
            Json::str(shiguang_core::sha256::hex_digest(&payloads[0])),
        );
    });
    let incoming = t.0.join("crafted.sgbak");
    fs::write(&incoming, pack(&manifest, &payloads)).unwrap();
    backup::verify_backup(&incoming).unwrap();
    for merge in [false, true] {
        for locked in [false, true] {
            let root = t.0.join(format!("target-{merge}-{locked}"));
            let mut target = Store::open_exclusive(&root).unwrap();
            target.set_theme(ThemePreference::Light).unwrap();
            if locked {
                target.set_app_lock("482615").unwrap();
                target.verify_app_lock("invalid").unwrap_err();
            }
            let expected = lock_json(&target);
            if merge {
                target.merge_backup(&incoming).unwrap();
            } else {
                target.restore_backup_overwrite(&incoming).unwrap();
            }
            assert_eq!(lock_json(&target), expected);
            assert_eq!(
                target.settings().unwrap().theme,
                if merge {
                    ThemePreference::Light
                } else {
                    ThemePreference::Dark
                }
            );
            drop(target);
            let reopened = Store::open_exclusive(&root).unwrap();
            assert_eq!(lock_json(&reopened), expected);
        }
    }
}
