#![allow(dead_code)]
use shiguang_core::{
    json::{self, Json},
    sha256, Store,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub struct Temp(pub PathBuf);
impl Temp {
    pub fn new(name: &str) -> Self {
        let p = std::env::temp_dir().join(format!(
            "sg-u05-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        #[cfg(feature = "fault-injection")]
        shiguang_core::fault::clear();
        #[cfg(feature = "fault-injection")]
        shiguang_core::lock::force_unsupported(false);
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, base: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for e in fs::read_dir(root).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            let n = e.file_name();
            let n = n.to_string_lossy();
            if n == ".write.lock" || n == ".instance.lock" || n.ends_with(".lock.owner") {
                continue;
            }
            if p.is_dir() {
                visit(&p, base, out);
            } else {
                out.insert(
                    p.strip_prefix(base).unwrap().to_owned(),
                    fs::read(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
pub fn live_tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    tree(root)
        .into_iter()
        .filter(|(p, _)| !p.starts_with("backups"))
        .collect()
}
pub fn clean(root: &Path) {
    for e in fs::read_dir(root).unwrap() {
        let n = e.unwrap().file_name().to_string_lossy().into_owned();
        assert!(
            !n.starts_with(".restore-") && !n.contains(".partial-") && !n.starts_with(".tmp-"),
            "leftover {n}"
        );
    }
}
pub fn draft(s: &mut Store, body: &str) -> String {
    s.create_draft(None, "合成标题", body, "2026-11-09", None)
        .unwrap()
        .record_id
}
pub fn photo(s: &mut Store, id: &str, tag: &str) -> shiguang_core::PhotoUse {
    s.attach_photo_bytes(
        id,
        "s.png",
        &shiguang_core::preview::preview_bytes(tag),
        "合成说明",
        None,
    )
    .unwrap()
}
pub fn seeded(root: &Path, body: &str) -> Store {
    let mut s = Store::open_exclusive(root).unwrap();
    let id = draft(&mut s, body);
    photo(&mut s, &id, body);
    s.commit(&id, 0).unwrap();
    s
}
pub fn set(v: &mut Json, k: &str, x: Json) {
    let Json::Obj(f) = v else { panic!("object") };
    f.retain(|(key, _)| key != k);
    f.push((k.into(), x));
}
pub fn unpack(bytes: &[u8]) -> (Json, Vec<Vec<u8>>) {
    let n = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
    let m = json::parse(std::str::from_utf8(&bytes[16..16 + n]).unwrap()).unwrap();
    let mut at = 16 + n;
    let mut payloads = Vec::new();
    for e in m.get("entries").and_then(Json::as_arr).unwrap() {
        let n = e.get("size").and_then(Json::as_i64).unwrap() as usize;
        payloads.push(bytes[at..at + n].to_vec());
        at += n;
    }
    (m, payloads)
}
pub fn pack(m: &Json, payloads: &[Vec<u8>]) -> Vec<u8> {
    let text = m.dump();
    let mut b = b"SGBAK\0\0\x01".to_vec();
    b.extend_from_slice(&(text.len() as u64).to_le_bytes());
    b.extend_from_slice(text.as_bytes());
    for p in payloads {
        b.extend_from_slice(p);
    }
    seal(&mut b);
    b
}
pub fn seal(b: &mut Vec<u8>) {
    let n = b.len() as u64;
    let h = sha256::digest(b);
    b.extend_from_slice(b"SGBAKEND");
    b.extend_from_slice(&h);
    b.extend_from_slice(&n.to_le_bytes());
}
pub fn edit_entries(m: &mut Json, f: impl FnOnce(&mut Vec<Json>)) {
    let Json::Obj(fields) = m else { panic!() };
    let Json::Arr(a) = &mut fields.iter_mut().find(|(k, _)| k == "entries").unwrap().1 else {
        panic!()
    };
    f(a);
}
