use super::*;
use crate::fault::{self, FaultPoint::*};
use crate::migration::{CLEARING, SYNCED};

fn interrupt(f: &Fixture, installed: bool) {
    fault::set(if installed {
        MigrationAfterInstall
    } else {
        MigrationWrite
    });
    assert!(f.install().is_err());
    fault::clear();
    assert!(f.root.join(PENDING).is_file());
    f.assert_backup();
    if installed {
        f.assert_candidate()
    } else {
        f.assert_old()
    }
}

fn fenced(f: &Fixture) {
    assert_eq!(require_idle(&f.root).unwrap_err().code, "MIGRATION_PENDING");
    assert!(Store::open(&f.root).is_err());
    assert!(Store::open_exclusive(&f.root).is_err());
    assert_eq!(f.install().unwrap_err().code, "MIGRATION_PENDING");
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Visible {
    Old,
    OldPending,
    CandidatePending,
}

#[test]
fn backup_install_and_clear_faults_preserve_the_frozen_preimage_on_reopen() {
    use Visible::*;
    // Parent sync visits are backups/, root, pending publication, candidate
    // replace, retirement of pending, and confirmation of that decision.
    for schema in [3, 5] {
        for (point, visit, expected) in [
            (MigrationBackupVerify, 1, Old),
            (ParentSync, 1, Old),
            (ParentSync, 2, Old),
            (TempWrite, 1, Old),
            (Replace, 1, Old),
            (ParentSync, 3, OldPending),
            (MigrationWrite, 1, OldPending),
            (TempCreate, 2, OldPending),
            (TempWrite, 2, OldPending),
            (PartialTempWrite, 2, OldPending),
            (TempSync, 2, OldPending),
            (Replace, 2, OldPending),
            (ParentSync, 4, CandidatePending),
            (MigrationAfterInstall, 1, CandidatePending),
            (ParentSync, 5, CandidatePending),
            (ParentSync, 6, CandidatePending),
        ] {
            let f = Fixture::new(schema);
            fault::set_after(point, visit);
            let error = f.install().unwrap_err();
            fault::clear();
            f.assert_backup();
            if expected == CandidatePending {
                f.assert_candidate()
            } else {
                f.assert_old()
            }
            if expected == Old {
                require_idle(&f.root).unwrap();
            } else {
                fenced(&f);
                assert!(f.root.join(PENDING).is_file() || f.root.join(CLEARING).is_file());
            }
            f.reopen_old();
            f.assert_backup();
            f.reopen_old();
            assert!(!fs::read_dir(&f.root).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".tmp-")));
            eprintln!("v{schema} {point:?} visit={visit} error={} before_reopen={expected:?} reopened=exact_old originals={}", error.code, f.media.len());
        }
    }
}

#[test]
fn rollback_failure_and_uncertain_restoration_keep_writers_fenced() {
    for schema in [3, 5] {
        for (point, visit, old_visible) in [
            (RestoreSwitchState, 1, false),
            (TempWrite, 1, false),
            (ParentSync, 1, true),
            (ParentSync, 2, true),
        ] {
            let f = Fixture::new(schema);
            interrupt(&f, true);
            fault::set_after(point, visit);
            assert!(candidate::recover(&f.root).is_err());
            fault::clear();
            fenced(&f);
            if old_visible {
                f.assert_old()
            } else {
                f.assert_candidate()
            }
            f.assert_backup();
            f.reopen_old();
            f.assert_backup();
            eprintln!("v{schema} rollback {point:?} visit={visit} old_visible={old_visible} fenced reopened=exact_old originals={}", f.media.len());
        }
    }
}

#[test]
fn corrupt_missing_backup_or_third_state_blocks_all_destructive_recovery() {
    for schema in [3, 5] {
        for installed in [false, true] {
            for damage in [
                "corrupt-backup",
                "missing-backup",
                "third-state",
                "missing-state",
            ] {
                let f = Fixture::new(schema);
                interrupt(&f, installed);
                let before = fs::read(f.state()).unwrap();
                let journal = fs::read(f.root.join(PENDING)).unwrap();
                match damage {
                    "corrupt-backup" => fs::write(f.backup(), b"damaged").unwrap(),
                    "missing-backup" => fs::remove_file(f.backup()).unwrap(),
                    "third-state" => {
                        let mut other = f.old.clone();
                        other.push(b' ');
                        fs::write(f.state(), other).unwrap();
                    }
                    "missing-state" => fs::remove_file(f.state()).unwrap(),
                    _ => unreachable!(),
                }
                let live = fs::read(f.state()).ok();
                let backup = fs::read(f.backup()).ok();
                assert!(candidate::recover(&f.root).is_err());
                fenced(&f);
                assert_eq!(fs::read(f.state()).ok(), live);
                assert_eq!(fs::read(f.backup()).ok(), backup);
                assert_eq!(fs::read(f.root.join(PENDING)).unwrap(), journal);
                f.assert_media();
                // Repair only the deliberate damage so a new owner can recover.
                if damage.ends_with("backup") {
                    fs::write(f.backup(), &f.old).unwrap();
                } else {
                    fs::write(f.state(), &before).unwrap();
                }
                f.reopen_old();
                f.assert_backup();
                eprintln!("v{schema} {damage} installed={installed} rejected_without_mutation repaired_reopen=exact_old originals={}", f.media.len());
            }
        }
    }
}

#[test]
fn invalid_pending_hashes_names_and_documents_cannot_write_through_the_record() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        interrupt(&f, true);
        let path = f.root.join(PENDING);
        let good = fs::read_to_string(&path).unwrap();
        let original = json::parse(&good).unwrap();
        let old = original.get("oldSha256").unwrap().clone();
        let mut corrupt = vec![
            ("empty", String::new()),
            ("truncated", "{".into()),
            ("oversized", " ".repeat(1025)),
            ("duplicate-key", good.replacen('{', "{\"backup\":\"x\",", 1)),
        ];
        for (label, key, value) in [
            ("parent", "backup", Json::str("../state.json")),
            (
                "absolute",
                "backup",
                Json::str(f.state().display().to_string()),
            ),
            ("backslash", "backup", Json::str("..\\state.json")),
            ("other-backup", "backup", Json::str("pre-restore-1")),
            (
                "name-digest",
                "backup",
                Json::str(format!("state.schema-v{schema}.{}.json", "a".repeat(64))),
            ),
            ("bad-old", "oldSha256", Json::str("a")),
            ("bad-new", "newSha256", Json::str("G".repeat(64))),
            ("identical", "newSha256", old),
            ("extra", "path", Json::str("media")),
        ] {
            let mut bad_record = original.clone();
            schema::set(&mut bad_record, key, value).unwrap();
            corrupt.push((label, bad_record.dump()));
        }
        for (index, (label, bytes)) in corrupt.into_iter().enumerate() {
            if index > 0 {
                interrupt(&f, true);
            }
            fs::write(&path, &bytes).unwrap();
            assert!(candidate::recover(&f.root).is_err(), "{label}");
            fenced(&f);
            assert_eq!(fs::read(&path).unwrap(), bytes.as_bytes());
            f.assert_candidate();
            fs::write(&path, &good).unwrap();
            f.reopen_old();
            f.assert_backup();
            eprintln!(
                "v{schema} pending={label} rejected_without_mutation repaired_reopen=exact_old originals={}",
                f.media.len()
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn symlinked_state_backup_pending_or_directory_never_reaches_its_target() {
    use std::os::unix::fs::symlink;
    for schema in [3, 5] {
        for name in ["state", "backup", "backups", "pending", "clearing"] {
            let f = Fixture::new(schema);
            interrupt(&f, true);
            let live = match name {
                "state" => f.state(),
                "backup" => f.backup(),
                "backups" => f.root.join("backups"),
                "pending" => f.root.join(PENDING),
                "clearing" => f.root.join(CLEARING),
                _ => unreachable!(),
            };
            let moved = f.root.join("disposable-target");
            if name == "clearing" {
                fs::create_dir(&moved).unwrap();
            } else {
                fs::rename(&live, &moved).unwrap();
            }
            symlink(&moved, &live).unwrap();
            assert!(candidate::recover(&f.root).is_err(), "{name}");
            fenced(&f);
            assert!(fs::symlink_metadata(&live).unwrap().is_symlink());
            f.assert_media();
            fs::remove_file(&live).unwrap();
            if name != "clearing" {
                fs::rename(&moved, &live).unwrap();
            }
            f.assert_candidate();
            f.reopen_old();
            eprintln!("v{schema} symlink={name} rejected_without_mutation reopened=exact_old originals={}", f.media.len());
        }
    }
}

#[test]
fn already_open_v5_writer_cannot_save_through_pending_even_when_old_bytes_are_visible() {
    let f = Fixture::new(5);
    let mut writer = Store::open(&f.root).unwrap();
    interrupt(&f, false);
    assert_eq!(writer.persist().unwrap_err().code, "MIGRATION_PENDING");
    f.assert_old();
    f.reopen_old();
    assert_eq!(
        Store::open(&f.root).unwrap().state_json(),
        writer.state_json()
    );
    f.assert_old();
}

fn recover_after_failed_confirmation(f: &Fixture) {
    let receipt = f.root.join(SYNCED);
    let record = json::parse(&fs::read_to_string(&receipt).unwrap()).unwrap();
    let candidate_hash = backup::hash_file(&f.state()).unwrap().1;
    assert_eq!(record.get("newSha256"), Some(&Json::str(&candidate_hash)));
    assert_eq!(record.get("oldSha256"), Some(&Json::str(&f.old_hash)));
    assert!(!f.root.join(PENDING).exists() && !f.root.join(CLEARING).exists());
    fenced(f);
    f.assert_candidate();

    candidate::recover(&f.root).unwrap();
    let live = backup::hash_file(&f.state()).unwrap().1;
    f.assert_backup();
    f.assert_media();
    eprintln!(
        "v{} fresh recovery: synced={} idle={} state={} old={} candidate={} originals={}",
        f.schema,
        receipt.exists(),
        require_idle(&f.root).is_ok(),
        live,
        f.old_hash,
        candidate_hash,
        f.media.len()
    );
    assert_eq!(
        live, f.old_hash,
        "fresh recovery published the unconfirmed candidate"
    );
    f.assert_old();
    require_idle(&f.root).unwrap();
    f.reopen_old();
    f.assert_backup();
}

fn crash_before_compensating_rename(schema: i64) {
    const CHILD_ROOT: &str = "SHIGUANG_TEST_M1_CRASH_ROOT";
    const INTERRUPTED: i32 = 86;
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        fault::set_after(ParentSync, 6);
        candidate::ON_SYNC_FAILURE.set(Some(Box::new(|| std::process::exit(INTERRUPTED))));
        panic!(
            "missed failed confirmation: {:?}",
            candidate::install(Path::new(&root), build, validate)
        );
    }

    let f = Fixture::new(schema);
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg(std::thread::current().name().unwrap())
        .env(CHILD_ROOT, &f.root)
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(INTERRUPTED), "{child:?}");
    eprintln!(
        "v{schema} parent sync visit 6 failed; installing process exited before compensation"
    );
    recover_after_failed_confirmation(&f);
}

fn fail_compensating_rename(schema: i64) {
    let f = Fixture::new(schema);
    let clearing = f.root.join(CLEARING);
    let obstruction = clearing.clone();
    candidate::ON_SYNC_FAILURE.set(Some(Box::new(move || fs::create_dir(obstruction).unwrap())));
    fault::set_after(ParentSync, 6);
    let error = f.install().unwrap_err();
    fault::clear();
    assert_eq!(error.code, "IO_ERROR");
    assert!(f.root.join(SYNCED).is_file());
    // The kernel rejected the rename onto this directory. Remove only the
    // test obstruction so the fresh owner sees the surviving receipt alone.
    fs::remove_dir(clearing).unwrap();
    eprintln!("v{schema} parent sync visit 6 failed; compensating rename returned {error}");
    recover_after_failed_confirmation(&f);
}

#[test]
fn unconfirmed_sync_crash_v3() {
    crash_before_compensating_rename(3);
}

#[test]
fn unconfirmed_sync_crash_v5() {
    crash_before_compensating_rename(5);
}

#[test]
fn unconfirmed_sync_compensation_error_v3() {
    fail_compensating_rename(3);
}

#[test]
fn unconfirmed_sync_compensation_error_v5() {
    fail_compensating_rename(5);
}

#[test]
fn verified_commit_receipt_needs_confirmed_sync_before_releasing_the_writer() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        fault::set(MigrationAfterCommit);
        assert!(f.install().is_err());
        fault::clear();
        assert!(f.root.join(SYNCED).is_file());
        fenced(&f);
        f.assert_candidate();
        fault::set(ParentSync);
        assert!(candidate::recover(&f.root).is_err());
        fault::clear();
        fenced(&f);
        f.assert_candidate();
        candidate::recover(&f.root).unwrap();
        require_idle(&f.root).unwrap();
        f.assert_candidate();
        eprintln!("v{schema} interruption after durable commit; receipt sync failure fenced; confirmed reopen=candidate originals={}", f.media.len());
    }
}

#[test]
fn witness_io_faults_leave_a_fenced_receipt_for_the_next_owner() {
    for schema in [3, 5] {
        for (point, digit) in [(MigrationWitnessWrite, 0), (MigrationWitnessSync, 1)] {
            let f = Fixture::new(schema);
            fault::set(point);
            assert!(f.install().is_err());
            fault::clear();
            let path = f.root.join(SYNCED);
            let record = json::parse(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(record.get("confirmed"), Some(&Json::Num(digit)));
            fenced(&f);
            f.assert_candidate();

            candidate::recover(&f.root).unwrap();
            require_idle(&f.root).unwrap();
            if digit == 0 {
                f.assert_old();
                f.assert_backup();
            } else {
                f.assert_candidate();
            }
            eprintln!(
                "v{schema} {point:?} confirmed={digit} recovered state={}",
                backup::hash_file(&f.state()).unwrap().1
            );
        }
    }
}

#[test]
fn legacy_receipts_and_malformed_witnesses_preserve_the_fence_or_exact_old_state() {
    for schema in [3, 5] {
        for (name, digit, rollback) in [
            (PENDING, None, true),
            (CLEARING, None, true),
            (SYNCED, None, false),
            (PENDING, Some(1), false),
            (CLEARING, Some(1), false),
            (SYNCED, Some(2), false),
        ] {
            let f = Fixture::new(schema);
            interrupt(&f, true);
            let pending = f.root.join(PENDING);
            let path = f.root.join(name);
            if path != pending {
                fs::rename(pending, &path).unwrap();
            }
            let mut record = json::parse(&fs::read_to_string(&path).unwrap()).unwrap();
            match digit {
                Some(n) => schema::set(&mut record, "confirmed", Json::Num(n)).unwrap(),
                None => remove_fields(&mut record, &["confirmed"]).unwrap(),
            }
            let bytes = record.dump();
            fs::write(&path, &bytes).unwrap();
            if rollback {
                f.reopen_old();
                f.assert_backup();
            } else {
                assert_eq!(
                    candidate::recover(&f.root).unwrap_err().code,
                    "MIGRATION_FAILED"
                );
                fenced(&f);
                assert_eq!(fs::read(path).unwrap(), bytes.as_bytes());
                f.assert_candidate();
            }
        }
    }
}

#[test]
fn conflicting_intents_and_wrong_version_pairs_stay_fenced() {
    for schema in [3, 5] {
        for damage in [
            "two-phase-names",
            "overlapping-import",
            "backup-schema",
            "foreign-state",
        ] {
            let f = Fixture::new(schema);
            interrupt(&f, true);
            let path = f.root.join(PENDING);
            let good = fs::read_to_string(&path).unwrap();
            let mut record = json::parse(&good).unwrap();
            let candidate = fs::read(f.state()).unwrap();
            let extra = match damage {
                "two-phase-names" => {
                    let p = f.root.join(CLEARING);
                    fs::write(&p, &good).unwrap();
                    Some(p)
                }
                "overlapping-import" => {
                    let p = f.root.join(".merge-journal.json");
                    fs::write(&p, b"preserve the existing intent").unwrap();
                    Some(p)
                }
                "backup-schema" => {
                    let name = format!("state.schema-v1.{}.json", f.old_hash);
                    let p = f.root.join("backups").join(&name);
                    fs::copy(f.backup(), &p).unwrap();
                    schema::set(&mut record, "backup", Json::str(name)).unwrap();
                    Some(p)
                }
                "foreign-state" => {
                    let mut foreign = build(&f.source()).unwrap();
                    *field_mut(&mut foreign, "schemaVersion").unwrap() = Json::Num(77);
                    let bytes = foreign.pretty();
                    schema::set(
                        &mut record,
                        "newSha256",
                        Json::str(sha256::hex_digest(bytes.as_bytes())),
                    )
                    .unwrap();
                    fs::write(f.state(), bytes).unwrap();
                    None
                }
                _ => unreachable!(),
            };
            let stored = record.dump();
            fs::write(&path, &stored).unwrap();
            let state = fs::read(f.state()).unwrap();
            let extra_bytes = extra.as_ref().map(|p| fs::read(p).unwrap());
            assert!(candidate::recover(&f.root).is_err(), "{damage}");
            fenced(&f);
            assert_eq!(fs::read(&path).unwrap(), stored.as_bytes());
            assert_eq!(fs::read(f.state()).unwrap(), state);
            assert_eq!(extra.as_ref().map(|p| fs::read(p).unwrap()), extra_bytes);
            f.assert_backup();
            f.assert_media();
            if let Some(p) = extra {
                fs::remove_file(p).unwrap();
            }
            fs::write(&path, good).unwrap();
            fs::write(f.state(), candidate).unwrap();
            f.reopen_old();
            eprintln!("v{schema} {damage} rejected_without_mutation repaired_reopen=exact_old originals={}", f.media.len());
        }
    }
}
