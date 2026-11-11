use shiguang_core::Store;
use std::fs;
#[test]
fn storage_counts_nested_categories_without_changing_data() {
    let root = std::env::temp_dir().join(format!("sg-storage-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let mut store = Store::open(&root).unwrap();
    store
        .create_draft(None, "synthetic", "fixture", "2026-11-11", None)
        .unwrap();
    fs::create_dir_all(root.join("media/nested")).unwrap();
    fs::create_dir_all(root.join("backups")).unwrap();
    fs::write(root.join("media/nested/synthetic"), b"12345").unwrap();
    fs::write(root.join("previews/synthetic"), b"123").unwrap();
    fs::write(root.join("backups/synthetic"), b"1234567").unwrap();
    let before = fs::read(root.join("state.json")).unwrap();
    let stats = store.storage_stats().unwrap();
    assert_eq!(
        (stats.media, stats.previews, stats.backups, stats.data),
        (5, 3, 7, before.len() as u64)
    );
    assert_eq!(
        stats.total,
        stats.media + stats.previews + stats.backups + stats.data + stats.other
    );
    assert_eq!(fs::read(root.join("state.json")).unwrap(), before);
    assert!(stats.to_json().dump().contains("\"available\":null"));
    fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn storage_skips_external_internal_and_looping_symlinks() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("sg-storage-links-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let mut store = Store::open(&root).unwrap();
    store
        .create_draft(None, "synthetic", "fixture", "2026-11-11", None)
        .unwrap();
    let before = store.storage_stats().unwrap();
    symlink("/tmp", root.join("media/external")).unwrap();
    symlink(&root, root.join("previews/loop")).unwrap();
    symlink(root.join("state.json"), root.join("backups-link")).unwrap();
    let after = store.storage_stats().unwrap();
    assert_eq!(after.total, before.total);
    assert_eq!(after.skipped_symlinks, 3);
    fs::remove_dir_all(root).unwrap();
}
