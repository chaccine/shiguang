use shiguang_core::{
    json::{self, Json},
    Store,
};
use std::{fs, path::Path, process::Command};
fn call(root: &Path, args: &[&str], ok: bool) -> Json {
    let o = Command::new(env!("CARGO_BIN_EXE_shiguang"))
        .arg("--data-dir")
        .arg(root)
        .args(args)
        .env("SHIGUANG_CLOCK", "2026-11-10T12:00:00Z")
        .output()
        .unwrap();
    assert_eq!(
        o.status.success(),
        ok,
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    json::parse(std::str::from_utf8(if ok { &o.stdout } else { &o.stderr }).unwrap()).unwrap()
}
#[test]
fn all_unit07_commands_end_to_end_and_confirmation_guards() {
    let root = std::env::temp_dir().join(format!("sg-cli-u07-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let mut s = Store::open(&root).unwrap();
    let id = s
        .create_draft(None, "合成", "合成内容", "2020-11-10", Some("10:00"))
        .unwrap()
        .record_id;
    s.commit(&id, 0).unwrap();
    drop(s);
    call(&root, &["favorite", &id, "on", "--expect", "0"], true);
    assert_eq!(
        call(&root, &["favorite", &id, "off", "--expect", "0"], false).get("code"),
        Some(&Json::str("META_REVISION_CONFLICT"))
    );
    let a = call(&root, &["tag-create", "A"], true)
        .get("tagId")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let b = call(&root, &["tag-create", "B"], true)
        .get("tagId")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    call(&root, &["tag-rename", &a, "Alpha"], true);
    call(&root, &["tag-set", &id, &a, &b, "--expect", "0"], true);
    assert_eq!(
        call(&root, &["tags"], true)
            .get("tags")
            .unwrap()
            .as_arr()
            .unwrap()
            .len(),
        2
    );
    let p = call(
        &root,
        &[
            "timeline",
            "--favorites",
            "--tag",
            &a,
            "--tag",
            &b,
            "--from",
            "2020-01-01",
            "--to",
            "2020-12-31",
            "--asc",
            "--limit",
            "1",
        ],
        true,
    );
    assert_eq!(p.get("total"), Some(&Json::Num(1)));
    assert_eq!(
        call(&root, &["calendar", "2020-11"], true)
            .get("days")
            .unwrap()
            .as_arr()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(&root, &["day", "2020-11-10"], true)
            .get("items")
            .unwrap()
            .as_arr()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &root,
            &["on-this-day", "11-10", "--today", "2026-11-10"],
            true
        )
        .get("years")
        .unwrap()
        .as_arr()
        .unwrap()
        .len(),
        1
    );
    call(&root, &["tag-merge", &a, &b], false);
    call(&root, &["tag-merge", &a, &b, "--yes"], true);
    call(&root, &["tag-delete", &b], false);
    call(&root, &["tag-delete", &b, "--yes"], true);
    call(&root, &["tag-set", &id], true);
    call(&root, &["favorite", &id, "off"], true);
    for args in [
        vec!["favorite", &id, "maybe"],
        vec!["timeline", "--limit", "0"],
        vec!["calendar", "2026-13"],
        vec!["day", "bad"],
        vec!["on-this-day", "02-30"],
        vec!["tag-set", &id, "--expect"],
        vec!["timeline", "--cursor", "broken"],
    ] {
        call(&root, &args, false);
    }
    fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn cli_platform_local_date_is_passed_into_pure_query() {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let root = std::env::temp_dir().join(format!("sg-cli-u07-local-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let mut s = Store::open(&root).unwrap();
    let shifted =
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + Duration::from_secs(14 * 3600);
    let local = shiguang_core::time::format_rfc3339(UNIX_EPOCH + shifted);
    let tomorrow =
        shiguang_core::time::format_rfc3339(UNIX_EPOCH + shifted + Duration::from_secs(86400));
    for date in [&local[..10], &tomorrow[..10]] {
        let id = s
            .create_draft(None, "合成", "合成", date, None)
            .unwrap()
            .record_id;
        s.commit(&id, 0).unwrap();
    }
    drop(s);
    let o = Command::new(env!("CARGO_BIN_EXE_shiguang"))
        .arg("--data-dir")
        .arg(&root)
        .arg("timeline")
        .env_remove("SHIGUANG_CLOCK")
        .env("TZ", "UTC-14")
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v = json::parse(std::str::from_utf8(&o.stdout).unwrap()).unwrap();
    let items = v.get("items").unwrap().as_arr().unwrap();
    assert_eq!(items[0].get("isFuture"), Some(&Json::Bool(true)));
    assert_eq!(items[1].get("isFuture"), Some(&Json::Bool(false)));
    fs::remove_dir_all(root).unwrap();
}
