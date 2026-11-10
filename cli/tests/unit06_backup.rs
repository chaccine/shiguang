use shiguang_core::Store;
use std::{
    fs,
    io::Write,
    process::{Command, Output, Stdio},
};
const PASSWORD: &str = "synthetic-cli-secret";
fn cli(root: &std::path::Path, args: &[&str], stdin: bool) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_shiguang"));
    c.arg("--data-dir")
        .arg(root)
        .args(args)
        .env_remove("SHIGUANG_BACKUP_PASSWORD");
    if stdin {
        let mut child = c
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{PASSWORD}\n").as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    } else {
        c.env("SHIGUANG_BACKUP_PASSWORD", PASSWORD)
            .output()
            .unwrap()
    }
}
fn success(out: Output) {
    assert!(out.status.success(), "CLI failed");
    assert!(!String::from_utf8_lossy(&out.stdout).contains(PASSWORD));
    assert!(!String::from_utf8_lossy(&out.stderr).contains(PASSWORD));
}
#[test]
fn encrypted_export_verify_plan_merge_restore_env_and_stdin() {
    let root = std::env::temp_dir().join(format!("sg-cli-u06-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let a = root.join("a");
    let b = root.join("b");
    let c = root.join("c");
    let mut s = Store::open(&a).unwrap();
    let id = s
        .create_draft(None, "synthetic", "synthetic content", "2026-11-09", None)
        .unwrap()
        .record_id;
    s.commit(&id, 0).unwrap();
    drop(s);
    let path = root.join("enc");
    let p = path.to_str().unwrap();
    success(cli(
        &a,
        &["export-backup", p, "--encrypt", "--kdf-fast"],
        false,
    ));
    success(cli(
        &root.join("absent"),
        &["verify-backup", p, "--password-stdin"],
        true,
    ));
    assert!(!root.join("absent").exists());
    success(cli(&b, &["plan-merge", p], false));
    assert!(!cli(&b, &["merge-backup", p], false).status.success());
    success(cli(&b, &["merge-backup", p, "--yes"], false));
    success(cli(
        &c,
        &["restore-backup", p, "--yes", "--password-stdin"],
        true,
    ));
    assert_eq!(
        Store::open(&b).unwrap().state_json().get("records"),
        Store::open(&c).unwrap().state_json().get("records")
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn password_argv_is_rejected_without_echo_or_data_creation() {
    let root = std::env::temp_dir().join(format!("sg-cli-u06-argv-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let output = cli(
        &root,
        &[
            "export-backup",
            "synthetic.sgbak",
            "--encrypt",
            "--password",
            PASSWORD,
        ],
        false,
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(PASSWORD));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(PASSWORD));
    assert!(!root.exists());
}
