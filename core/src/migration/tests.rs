//! Only this harness encodes ordered fixture states. Store still reads/writes v5.
use super::{candidate, require_idle, PENDING};
use crate::{
    backup,
    json::{self, Json},
    schema, sha256,
    story::{Story, StoryBlock},
    CoreError, Snapshot, State, Store,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

fn bad(message: impl Into<String>) -> CoreError {
    CoreError::new("CANDIDATE_INVALID", message)
}

fn field_mut<'a>(v: &'a mut Json, key: &str) -> Result<&'a mut Json, CoreError> {
    if let Json::Obj(fields) = v {
        if let Some((_, child)) = fields.iter_mut().find(|(k, _)| k == key) {
            return Ok(child);
        }
    }
    Err(bad(format!("missing {key}")))
}

fn snapshots(
    state: &mut Json,
    mut visit: impl FnMut(&mut Json) -> Result<(), CoreError>,
) -> Result<(), CoreError> {
    for (array, slots) in [
        ("records", &["formal", "draft"][..]),
        ("conflictCopies", &["snapshot"][..]),
    ] {
        let Json::Arr(rows) = field_mut(state, array)? else {
            return Err(bad(array));
        };
        for row in rows {
            for key in slots {
                let snapshot = field_mut(row, key)?;
                if *snapshot != Json::Null {
                    visit(snapshot)?;
                }
            }
        }
    }
    Ok(())
}

fn remove_fields(v: &mut Json, keys: &[&str]) -> Result<(), CoreError> {
    let Json::Obj(fields) = v else {
        return Err(bad("expected object"));
    };
    fields.retain(|(k, _)| !keys.contains(&k.as_str()));
    Ok(())
}

fn build(source: &Json) -> Result<Json, CoreError> {
    let mut value = schema::migrate(source.clone())?;
    State::from_json(&value)?;
    snapshots(&mut value, |v| {
        let snap = Snapshot::from_json(v).map_err(bad)?;
        let story = Story::from_legacy(&snap).map_err(bad)?;
        let mut blocks = Vec::new();
        for block in story.blocks() {
            blocks.push(match block {
                StoryBlock::Paragraph(runs) => Json::obj(vec![
                    ("kind", Json::str("paragraph")),
                    (
                        "runs",
                        Json::Arr(
                            runs.iter()
                                .map(|r| {
                                    Json::obj(vec![
                                        ("text", Json::str(&r.text)),
                                        ("bold", Json::Bool(r.bold)),
                                        ("italic", Json::Bool(r.italic)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ]),
                StoryBlock::Photo(p) => Json::obj(vec![
                    ("kind", Json::str("photo")),
                    ("photoUse", p.to_json()),
                ]),
                _ => return Err(bad("unexpected legacy block")),
            });
        }
        let contents = Json::obj(vec![
            ("blocks", Json::Arr(blocks)),
            (
                "coverPhotoUseId",
                story
                    .cover_photo_use_id()
                    .map(Json::str)
                    .unwrap_or(Json::Null),
            ),
        ]);
        remove_fields(v, &["body", "photos", "coverPhotoUseId"])?;
        schema::set(v, "story", contents)
    })?;
    *field_mut(&mut value, "version")? = Json::Num(2);
    *field_mut(&mut value, "schemaVersion")? = Json::Num(6);
    Ok(value)
}

// Compare every field at its original row/slot/array index. Object member
// ordering alone has no meaning in JSON.
fn sort_keys(v: &mut Json) {
    match v {
        Json::Obj(fields) => {
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, item) in fields {
                sort_keys(item);
            }
        }
        Json::Arr(items) => items.iter_mut().for_each(sort_keys),
        _ => {}
    }
}

fn validate(source: &Json, encoded: &Json) -> Result<(), CoreError> {
    if encoded.get("version") != Some(&Json::Num(2))
        || encoded.get("schemaVersion") != Some(&Json::Num(6))
    {
        return Err(bad("wrong candidate version pair"));
    }
    let mut rebuilt = encoded.clone();
    snapshots(&mut rebuilt, |v| {
        if ["body", "photos", "coverPhotoUseId"]
            .iter()
            .any(|k| v.get(k).is_some())
        {
            return Err(bad("two representations of one snapshot"));
        }
        let story =
            Story::from_json(v.get("story").ok_or_else(|| bad("missing story"))?).map_err(bad)?;
        remove_fields(v, &["story"])?;
        schema::set(v, "body", Json::str(story.plain_text()))?;
        schema::set(
            v,
            "photos",
            Json::Arr(story.photos().map(|p| p.to_json()).collect()),
        )?;
        schema::set(
            v,
            "coverPhotoUseId",
            story
                .cover_photo_use_id()
                .map(Json::str)
                .unwrap_or(Json::Null),
        )?;
        let snapshot = Snapshot::from_json(v).map_err(bad)?;
        if Story::from_legacy(&snapshot).map_err(bad)? != story {
            return Err(bad("changed blocks or marks"));
        }
        Ok(())
    })?;
    *field_mut(&mut rebuilt, "version")? = Json::Num(1);
    *field_mut(&mut rebuilt, "schemaVersion")? = Json::Num(5);
    State::from_json(&rebuilt)?;
    let mut expected = schema::migrate(source.clone())?;
    sort_keys(&mut expected);
    sort_keys(&mut rebuilt);
    if rebuilt != expected {
        return Err(bad("legacy state differs after story round trip"));
    }
    Ok(())
}

// Use the archived scalar fields directly as the content oracle. In v3 the
// first use supplied the implicit cover; v5 carries an explicit occurrence ID.
fn assert_frozen_snapshots(raw: &Json, candidate: &Json) {
    for (array, id, slots) in [
        ("records", "recordId", &["formal", "draft"][..]),
        ("conflictCopies", "conflictId", &["snapshot"][..]),
    ] {
        let old_rows = raw.get(array).unwrap().as_arr().unwrap();
        let new_rows = candidate.get(array).unwrap().as_arr().unwrap();
        assert_eq!(old_rows.len(), new_rows.len());
        for (old, new) in old_rows.iter().zip(new_rows) {
            assert_eq!(old.get(id), new.get(id));
            assert_eq!(old.get("status"), new.get("status"));
            for key in slots {
                let (old, new) = (old.get(key).unwrap(), new.get(key).unwrap());
                if *old == Json::Null {
                    assert_eq!(*new, Json::Null);
                    continue;
                }
                let story = Story::from_json(new.get("story").unwrap()).unwrap();
                assert_eq!(
                    story.plain_text().as_bytes(),
                    old.get("body").unwrap().as_str().unwrap().as_bytes()
                );
                let photos: Vec<_> = old
                    .get("photos")
                    .unwrap()
                    .as_arr()
                    .unwrap()
                    .iter()
                    .map(|v| crate::PhotoUse::from_json(v).unwrap())
                    .collect();
                let cover = match old.get("coverPhotoUseId") {
                    Some(v) => v.as_str(),
                    None => photos.first().map(|p| p.photo_use_id.as_str()),
                };
                assert_eq!(story.cover_photo_use_id(), cover);
                assert!(story.photos().eq(&photos));
            }
        }
    }
}

fn media_hashes(root: &Path) -> BTreeMap<std::ffi::OsString, String> {
    fs::read_dir(root.join("media"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            assert!(entry.file_type().unwrap().is_file());
            (
                entry.file_name(),
                backup::hash_file(&entry.path()).unwrap().1,
            )
        })
        .collect()
}

struct Fixture {
    root: PathBuf,
    old: Vec<u8>,
    old_hash: String,
    media: BTreeMap<std::ffi::OsString, String>,
    schema: i64,
}

impl Fixture {
    fn new(schema: i64) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "sg-t42b-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("media")).unwrap();
        let archive =
            Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/v{schema}"));
        let old = fs::read(archive.join("state.json")).unwrap();
        let old_hash = sha256::hex_digest(&old);
        let media = media_hashes(&archive);
        assert_eq!(media.len(), if schema == 3 { 7 } else { 2 });
        fs::copy(archive.join("state.json"), root.join("state.json")).unwrap();
        for name in media.keys() {
            fs::copy(
                archive.join("media").join(name),
                root.join("media").join(name),
            )
            .unwrap();
        }
        let f = Self {
            root,
            old,
            old_hash,
            media,
            schema,
        };
        f.assert_old();
        f
    }

    fn state(&self) -> PathBuf {
        self.root.join("state.json")
    }
    fn backup(&self) -> PathBuf {
        self.root.join("backups").join(format!(
            "state.schema-v{}.{}.json",
            self.schema, self.old_hash
        ))
    }
    fn source(&self) -> Json {
        json::parse(std::str::from_utf8(&self.old).unwrap()).unwrap()
    }
    fn assert_media(&self) {
        assert_eq!(media_hashes(&self.root), self.media);
    }
    fn assert_old(&self) {
        assert_eq!(backup::hash_file(&self.state()).unwrap().1, self.old_hash);
        assert_eq!(fs::read(self.state()).unwrap(), self.old);
        self.assert_media();
    }
    fn assert_backup(&self) {
        assert_eq!(backup::hash_file(&self.backup()).unwrap().1, self.old_hash);
        assert_eq!(fs::read(self.backup()).unwrap(), self.old);
    }
    fn assert_candidate(&self) {
        let bytes = fs::read_to_string(self.state()).unwrap();
        let source = self.source();
        assert_eq!(bytes, build(&source).unwrap().pretty());
        let decoded = json::parse(&bytes).unwrap();
        validate(&source, &decoded).unwrap();
        assert_frozen_snapshots(&source, &decoded);
        self.assert_backup();
        self.assert_media();
    }
    fn install(&self) -> Result<(), CoreError> {
        candidate::install(&self.root, build, validate)
    }
    fn reopen_old(&self) {
        candidate::recover(&self.root).unwrap();
        require_idle(&self.root).unwrap();
        self.assert_old();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        #[cfg(feature = "fault-injection")]
        crate::fault::clear();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn frozen_stories_install_and_remain_committed_after_reopen() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        f.install().unwrap();
        f.assert_candidate();
        require_idle(&f.root).unwrap();
        candidate::recover(&f.root).unwrap();
        f.assert_candidate();
        assert!(
            matches!(Store::open_exclusive(&f.root), Err(e) if e.code == "STATE_VERSION_UNSUPPORTED")
        );
        f.assert_candidate();
        eprintln!(
            "v{schema} durable candidate {} preimage {} originals {}",
            backup::hash_file(&f.state()).unwrap().1,
            f.old_hash,
            f.media.len()
        );
    }
}

#[test]
fn malformed_or_lossy_round_trip_cannot_install() {
    for schema in [3, 5] {
        for loss in [false, true] {
            let f = Fixture::new(schema);
            let result = candidate::install(
                &f.root,
                |source| {
                    let mut candidate = build(source)?;
                    snapshots(&mut candidate, |v| {
                        let story = field_mut(v, "story")?;
                        if loss {
                            let Json::Arr(blocks) = field_mut(story, "blocks")? else {
                                return Err(bad("blocks"));
                            };
                            if let Some(first) = blocks
                                .first_mut()
                                .filter(|b| b.get("kind") == Some(&Json::str("paragraph")))
                            {
                                let Json::Arr(runs) = field_mut(first, "runs")? else {
                                    return Err(bad("runs"));
                                };
                                *field_mut(&mut runs[0], "text")? = Json::str("different body");
                            }
                        } else {
                            *field_mut(story, "coverPhotoUseId")? = Json::str("missing-use");
                        }
                        Ok(())
                    })?;
                    Ok(candidate)
                },
                validate,
            );
            assert_eq!(result.unwrap_err().code, "CANDIDATE_INVALID");
            assert!(!f.root.join(PENDING).exists());
            f.assert_old();
            f.reopen_old();
        }
    }
}

#[test]
fn an_existing_wrong_backup_is_never_replaced() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        fs::create_dir(f.root.join("backups")).unwrap();
        for wrong in [b"wrong backup".as_slice(), &f.old[..f.old.len() / 2]] {
            fs::write(f.backup(), wrong).unwrap();
            assert!(f.install().is_err());
            assert_eq!(fs::read(f.backup()).unwrap(), wrong);
            f.assert_old();
            f.reopen_old();
        }
    }
}

#[test]
fn ownership_and_source_version_refusal_precede_candidate_writes() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        let owner = crate::store::instance_lock(&f.root).unwrap();
        assert_eq!(f.install().unwrap_err().code, "STORE_LOCKED");
        assert_eq!(
            candidate::recover(&f.root).unwrap_err().code,
            "STORE_LOCKED"
        );
        f.assert_old();
        drop(owner);
        let mut unknown = f.source();
        *field_mut(&mut unknown, "schemaVersion").unwrap() = Json::Num(77);
        let bytes = unknown.pretty();
        fs::write(f.state(), &bytes).unwrap();
        fs::create_dir(f.root.join(".restore-staging-sentinel")).unwrap();
        assert_eq!(f.install().unwrap_err().code, "SCHEMA_TOO_NEW");
        assert!(!f.root.join("backups").exists());
        assert!(f.root.join(".restore-staging-sentinel").is_dir());
        assert_eq!(fs::read(f.state()).unwrap(), bytes.as_bytes());
        f.assert_media();
        fs::write(f.state(), &f.old).unwrap();
        f.reopen_old();
    }
}

#[cfg(feature = "fault-injection")]
mod faults;

#[test]
fn builder_and_validator_run_with_both_store_locks_and_a_verified_preimage() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        let check = || {
            for name in [".instance.lock", ".write.lock"] {
                assert!(matches!(
                    crate::lock::try_acquire(&f.root, name).unwrap(),
                    crate::lock::Acquire::Busy
                ));
            }
            f.assert_backup();
            f.assert_old();
            assert!(!f.root.join(PENDING).exists());
        };
        candidate::install(
            &f.root,
            |source| {
                check();
                build(source)
            },
            |source, candidate| {
                check();
                validate(source, candidate)
            },
        )
        .unwrap();
        f.assert_candidate();
    }
}

#[test]
fn existing_store_import_recovery_runs_before_taking_the_preimage() {
    for schema in [3, 5] {
        let f = Fixture::new(schema);
        let journal = f.root.join(".merge-journal.json");
        let temp_media = f.root.join("media/.tmp-merge-synthetic");
        fs::write(&temp_media, b"uncommitted merge staging").unwrap();
        let intent = Json::obj(vec![
            ("stateSha256", Json::str("0".repeat(64))),
            (
                "files",
                Json::Arr(vec![Json::str("media/.tmp-merge-synthetic")]),
            ),
        ]);
        fs::write(&journal, intent.dump()).unwrap();
        f.install().unwrap();
        assert!(!journal.exists());
        assert!(!temp_media.exists());
        f.assert_candidate();
    }
}
