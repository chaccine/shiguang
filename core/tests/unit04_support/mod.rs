#![allow(dead_code)]
use shiguang_core::{
    json::{self, Json},
    Store,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub struct TempRoot(pub PathBuf);
impl TempRoot {
    pub fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("shiguang-u04-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn bytes(&self) -> Vec<u8> {
        fs::read(self.0.join("state.json")).unwrap()
    }
    pub fn json(&self) -> Json {
        json::parse(std::str::from_utf8(&self.bytes()).unwrap()).unwrap()
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        #[cfg(feature = "fault-injection")]
        shiguang_core::fault::clear();
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn draft(store: &mut Store) -> String {
    store
        .create_draft(None, "合成标题", "合成正文", "2026-11-09", None)
        .unwrap()
        .record_id
}
pub fn formal(store: &mut Store) -> String {
    let id = draft(store);
    store.commit(&id, 0).unwrap();
    id
}
pub fn png() -> Vec<u8> {
    shiguang_core::preview::preview_bytes("unit04-synthetic")
}
pub fn set(value: &mut Json, key: &str, item: Json) {
    if let Json::Obj(entries) = value {
        entries.retain(|(k, _)| k != key);
        entries.push((key.to_owned(), item));
    } else {
        panic!("expected object");
    }
}
pub fn legacy(tmp: &TempRoot) -> Vec<u8> {
    let mut s = Store::open(tmp.path()).unwrap();
    formal(&mut s);
    let mut value = s.state_json();
    if let Json::Obj(entries) = &mut value {
        entries.retain(|(k, _)| {
            !["schemaVersion", "deletionMarkers", "conflictCopies"].contains(&k.as_str())
        });
        if let Some((_, Json::Arr(rows))) = entries.iter_mut().find(|(k, _)| k == "records") {
            for row in rows {
                if let Json::Obj(fields) = row {
                    fields.retain(|(k, _)| !["status", "trashedAt"].contains(&k.as_str()));
                }
            }
        }
    }
    // Deliberate whitespace: backup must preserve source bytes, not reserialize JSON.
    let bytes = format!(" \n{}\n  ", value.pretty()).into_bytes();
    fs::write(tmp.0.join("state.json"), &bytes).unwrap();
    bytes
}
pub fn backups(tmp: &TempRoot) -> Vec<PathBuf> {
    let mut paths: Vec<_> = fs::read_dir(tmp.0.join("backups"))
        .into_iter()
        .flatten()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .collect();
    paths.sort();
    paths
}
pub fn tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                result.extend(tree(&path));
            } else {
                result.push((path.clone(), fs::read(path).unwrap()));
            }
        }
    }
    result.sort();
    result
}
pub fn moved(root: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}
