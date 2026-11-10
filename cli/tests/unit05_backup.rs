use shiguang_core::{
    json::{self, Json},
    Store,
};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
fn cli(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shiguang"))
        .arg("--data-dir")
        .arg(root)
        .args(args)
        .output()
        .unwrap()
}
fn success(out: Output) -> Json {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    json::parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap()
}
#[test]
fn cli_backup_roundtrip_requires_yes_and_verify_is_store_free() {
    let root = std::env::temp_dir().join(format!("sg-cli-u05-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let a = root.join("a");
    let b = root.join("b");
    let absent = root.join("verify-no-store");
    let dest = root.join("synthetic.sgbak");
    let file = dest.to_str().unwrap();
    let mut s = Store::open(&a).unwrap();
    let id = s
        .create_draft(None, "合成标题", "合成正文", "2026-11-09", None)
        .unwrap()
        .record_id;
    s.attach_photo_bytes(&id, "s.png", b"synthetic image", "说明", None)
        .unwrap();
    s.commit(&id, 0).unwrap();
    let expected = s.state_json();
    drop(s);
    success(cli(&a, &["export-backup", file]));
    success(cli(&absent, &["verify-backup", file]));
    assert!(!absent.exists());
    let refused = cli(&b, &["restore-backup", file]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("--yes"));
    assert!(!b.exists());
    success(cli(&b, &["restore-backup", file, "--yes"]));
    assert_eq!(Store::open(&b).unwrap().state_json(), expected);
    fs::remove_dir_all(root).unwrap();
}
