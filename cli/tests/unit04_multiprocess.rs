use shiguang_core::{
    json::{self, Json},
    Store,
};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
struct TempRoot(PathBuf);
impl TempRoot {
    fn new(name: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("shiguang-u04-cli-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.0.join("state.json")).unwrap()
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn command(root: &Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_shiguang"));
    c.arg("--data-dir").arg(root);
    c
}
fn holder(root: &Path, kind: &str) -> ChildGuard {
    let mut c = ChildGuard(
        command(root)
            .args(["hold-lock", "60000", "--kind", kind])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let out = c.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(out).read_line(&mut line);
        let _ = tx.send((read, line));
    });
    let (read, line) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("lock holder must report readiness within deadline");
    read.unwrap();
    if line.is_empty() {
        use std::io::Read;
        let mut diagnostic = String::new();
        c.0.stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostic)
            .unwrap();
        panic!("lock holder exited before ready: {diagnostic}");
    }
    assert_eq!(
        json::parse(&line).unwrap().get("ready"),
        Some(&Json::Bool(true))
    );
    c
}
fn seed(t: &TempRoot) -> String {
    Store::open(t.path())
        .unwrap()
        .create_draft(None, "合成标题", "合成正文", "2026-11-09", None)
        .unwrap()
        .record_id
}
#[test]
fn child_instance_lock_causes_store_locked_and_preserves_all_files() {
    let t = TempRoot::new("instance");
    seed(&t);
    let child = holder(t.path(), "instance");
    fs::write(t.path().join(".tmp-preserve"), b"synthetic writer data").unwrap();
    let before = t.bytes();
    let e = Store::open_exclusive(t.path())
        .err()
        .expect("child holds instance lock");
    assert_eq!(e.code, "STORE_LOCKED");
    assert_eq!(t.bytes(), before);
    assert_eq!(
        fs::read(t.path().join(".tmp-preserve")).unwrap(),
        b"synthetic writer data"
    );
    drop(child);
    Store::open_exclusive(t.path()).unwrap();
}
#[test]
fn child_write_lock_blocks_open_cleanup_and_preserves_state_bytes() {
    let t = TempRoot::new("write-open");
    seed(&t);
    let child = holder(t.path(), "write");
    fs::write(t.path().join(".tmp-preserve"), b"synthetic partial").unwrap();
    let before = t.bytes();
    let start = Instant::now();
    let e = Store::open(t.path())
        .err()
        .expect("open must wait for write lock before cleanup");
    assert_eq!(e.code, "STORE_BUSY");
    assert_eq!(
        e.message,
        "另一个拾光窗口正在写入，请稍后重试；你的输入未丢失"
    );
    assert!(start.elapsed() >= Duration::from_millis(14500));
    assert!(start.elapsed() < Duration::from_secs(30));
    assert_eq!(t.bytes(), before);
    assert!(t.path().join(".tmp-preserve").exists());
    drop(child);
    Store::open(t.path()).unwrap();
    assert!(!t.path().join(".tmp-preserve").exists());
}
fn busy_write(operation: &str) {
    let t = TempRoot::new(operation);
    let id = seed(&t);
    let mut s = Store::open(t.path()).unwrap();
    let child = holder(t.path(), "write");
    let before = t.bytes();
    let memory = s.state_json();
    let start = Instant::now();
    let e = if operation == "commit" {
        s.commit(&id, 0).unwrap_err()
    } else {
        s.save_draft(&id, None, Some("合成不可写"), None, None)
            .unwrap_err()
    };
    assert_eq!(e.code, "STORE_BUSY");
    assert!(start.elapsed() >= Duration::from_millis(14500));
    assert!(start.elapsed() < Duration::from_secs(30));
    assert_eq!(t.bytes(), before);
    assert_eq!(s.state_json(), memory);
    drop(child);
    if operation == "commit" {
        s.commit(&id, 0).unwrap();
    } else {
        s.save_draft(&id, None, Some("合成重试"), None, None)
            .unwrap();
    }
}
#[test]
fn child_write_lock_blocks_save_transaction_without_changes() {
    busy_write("save");
}
#[test]
fn child_write_lock_blocks_entire_commit_without_changes() {
    busy_write("commit");
}
#[test]
fn four_processes_create_twenty_drafts_each_without_lost_updates() {
    let t = TempRoot::new("concurrent");
    let gate = t.path().join("start");
    // Four long-lived CLI workers, not eighty sequential invocations.
    let mut children = Vec::new();
    for _ in 0..4 {
        children.push(ChildGuard(
            command(t.path())
                .args(["create-draft", "--count", "20", "--start-file"])
                .arg(&gate)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
    }
    fs::write(&gate, b"synthetic start").unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut errors = Vec::new();
    for child in &mut children {
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "concurrent worker timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        if !status.success() {
            use std::io::Read;
            let mut error = String::new();
            child
                .0
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut error)
                .unwrap();
            errors.push(error);
        }
    }
    assert!(
        errors.is_empty(),
        "all four workers must complete 20 writes: {errors:?}"
    );
    let state = json::parse(std::str::from_utf8(&t.bytes()).unwrap()).unwrap();
    let rows = state.get("records").and_then(Json::as_arr).unwrap();
    assert_eq!(rows.len(), 80);
    let ids: std::collections::BTreeSet<_> = rows
        .iter()
        .map(|r| r.get("recordId").and_then(Json::as_str).unwrap())
        .collect();
    assert_eq!(ids.len(), 80);
    let sequences: std::collections::BTreeSet<u64> = ids
        .iter()
        .map(|id| id.strip_prefix("rec-").unwrap().parse().unwrap())
        .collect();
    assert_eq!(sequences.len(), 80);
    assert_eq!(state.get("seq").and_then(Json::as_i64), Some(80));
    let store = Store::open(t.path()).unwrap();
    assert_eq!(store.list_drafts().len(), 80);
}
