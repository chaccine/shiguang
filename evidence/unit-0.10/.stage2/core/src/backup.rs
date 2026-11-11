//! `.sgbak` format 1：无压缩、无加密，固定缓冲传输原图。
//!
//! manifest（最多 8 MiB）与领域 state JSON 需要解析到内存；包及原图从不整体载入。
//! 恢复日志只包含数据根内的相对路径，提交后的收尾和提交前的回滚均可重复执行。
use crate::{
    error_codes::*,
    fault::{self, FaultPoint},
    json::{self, Json},
    model::{CoreError, MediaReport, PhotoUse, RecordStatus},
    persist::{self, Durability},
    schema,
    sha256::{self, Sha256},
    store::{write_lock, State},
    time, Store,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const MAGIC: &[u8; 8] = b"SGBAK\0\0\x01";
const END: &[u8; 8] = b"SGBAKEND";
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const BUFFER: usize = 64 * 1024;
const JOURNAL: &str = ".restore-journal.json";
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackupCounts {
    pub tags: u64,
    pub favorites: u64,
    pub formal: u64,
    pub drafts: u64,
    pub trashed: u64,
    pub deletion_markers: u64,
    pub conflict_copies: u64,
    pub media_files: u64,
    pub missing_media: u64,
}
impl BackupCounts {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("tags", num(self.tags)),
            ("favorites", num(self.favorites)),
            ("formal", num(self.formal)),
            ("drafts", num(self.drafts)),
            ("trashed", num(self.trashed)),
            ("deletionMarkers", num(self.deletion_markers)),
            ("conflictCopies", num(self.conflict_copies)),
            ("mediaFiles", num(self.media_files)),
            ("missingMedia", num(self.missing_media)),
        ])
    }
    fn parse(v: &Json) -> Result<Self, CoreError> {
        Ok(Self {
            tags: if v.get("tags").is_none() {
                0
            } else {
                uint(v, "tags")?
            },
            favorites: if v.get("favorites").is_none() {
                0
            } else {
                uint(v, "favorites")?
            },
            formal: uint(v, "formal")?,
            drafts: uint(v, "drafts")?,
            trashed: uint(v, "trashed")?,
            deletion_markers: uint(v, "deletionMarkers")?,
            conflict_copies: uint(v, "conflictCopies")?,
            media_files: uint(v, "mediaFiles")?,
            missing_media: uint(v, "missingMedia")?,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissingMedia {
    pub asset_id: String,
}
impl MissingMedia {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![("assetId", Json::str(&self.asset_id))])
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupInfo {
    pub counts: BackupCounts,
    pub exported_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub bytes: u64,
    pub missing_media: Vec<MissingMedia>,
}
impl BackupInfo {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("counts", self.counts.to_json()),
            ("exportedAt", Json::str(&self.exported_at)),
            ("appVersion", Json::str(&self.app_version)),
            ("schemaVersion", Json::Num(self.schema_version)),
            ("bytes", num(self.bytes)),
            ("missingMedia", missing_json(&self.missing_media)),
        ])
    }
}
#[derive(Clone, Debug)]
pub struct ExportReport {
    pub path: PathBuf,
    pub bytes: u64,
    /// SHA-256 of the complete container, including trailer.
    pub sha256: String,
    pub manifest: BackupInfo,
    pub missing_media: Vec<MissingMedia>,
}
impl ExportReport {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("path", Json::str(self.path.to_string_lossy())),
            ("bytes", num(self.bytes)),
            ("sha256", Json::str(&self.sha256)),
            ("manifest", self.manifest.to_json()),
            ("missingMedia", missing_json(&self.missing_media)),
        ])
    }
}
#[derive(Clone, Debug)]
pub struct RestoreReport {
    pub restored_counts: BackupCounts,
    pub safety_backup_dir: PathBuf,
    pub media_report: MediaReport,
}
impl RestoreReport {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("restoredCounts", self.restored_counts.to_json()),
            (
                "safetyBackupDir",
                Json::str(self.safety_backup_dir.to_string_lossy()),
            ),
            ("mediaReport", self.media_report.to_json()),
        ])
    }
}
fn num(n: u64) -> Json {
    Json::Num(n as i64)
}
fn missing_json(items: &[MissingMedia]) -> Json {
    Json::Arr(items.iter().map(MissingMedia::to_json).collect())
}
fn invalid() -> CoreError {
    CoreError::new(BACKUP_INVALID, "这不是拾光备份文件，或文件已损坏")
}
fn corrupt(path: &str) -> CoreError {
    CoreError::new(BACKUP_CORRUPT, format!("备份文件内容被修改或损坏：{path}"))
}
fn truncated() -> CoreError {
    CoreError::new(BACKUP_TRUNCATED, "备份文件不完整（可能拷贝中断）")
}
fn text<'a>(v: &'a Json, key: &str) -> Result<&'a str, CoreError> {
    v.get(key).and_then(Json::as_str).ok_or_else(invalid)
}
fn uint(v: &Json, key: &str) -> Result<u64, CoreError> {
    v.get(key)
        .and_then(Json::as_i64)
        .filter(|n| *n >= 0)
        .map(|n| n as u64)
        .ok_or_else(invalid)
}
fn array<'a>(v: &'a Json, key: &str) -> Result<&'a [Json], CoreError> {
    v.get(key).and_then(Json::as_arr).ok_or_else(invalid)
}
// The shared parser rejects duplicate keys, bad UTF-8 and trailing garbage.
// Bound recursion BEFORE invoking it, and reject non-JSON leading-zero integers.
fn parse_document(input: &str) -> Result<Json, String> {
    let bytes = input.as_bytes();
    let mut at = 0;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    while at < bytes.len() {
        let byte = bytes[at];
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > 128 {
                        return Err("JSON 嵌套过深".into());
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                b'-' | b'0'..=b'9' => {
                    if byte == b'-' {
                        at += 1;
                    }
                    if bytes.get(at) == Some(&b'0')
                        && bytes.get(at + 1).is_some_and(u8::is_ascii_digit)
                    {
                        return Err("JSON 整数不能有前导零".into());
                    }
                    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                        at += 1;
                    }
                    continue;
                }
                _ => {}
            }
        }
        at += 1;
    }
    json::parse(input)
}

fn digest_valid(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// Extra portable-name restrictions avoid Windows aliases / device files and case collisions.
fn name_valid(s: &str) -> bool {
    if s.is_empty()
        || s.len() > 128
        || s.starts_with('.')
        || s.ends_with('.')
        || s.contains("..")
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return false;
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    !["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
fn path_valid(s: &str) -> bool {
    s == "state.json" || s.strip_prefix("media/").is_some_and(name_valid)
}
fn no_link(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            Err(io::Error::other("不允许通过符号链接访问备份数据"))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
fn check_root(root: &Path) -> Result<(), CoreError> {
    for p in ["state.json", "media", "previews", "backups", JOURNAL] {
        no_link(&root.join(p))?;
    }
    Ok(())
}
// Backups and authenticated plaintext temporaries may contain private data.
fn private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
fn sync_dir(path: &Path) -> Result<(), CoreError> {
    match persist::parent_sync(path) {
        Durability::Uncertain { error } => Err(CoreError::io(error)),
        _ => Ok(()),
    }
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    match persist::write_atomic(path, bytes)? {
        Durability::Uncertain { error } => Err(CoreError::io(error)),
        _ => Ok(()),
    }
}
fn id() -> String {
    format!(
        "{}-{}-{}",
        time::now_rfc3339()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Copy exactly `size` bytes using a fixed buffer, hashing the bytes actually read.
fn transfer(reader: &mut impl Read, writer: &mut impl Write, size: u64) -> io::Result<String> {
    let mut left = size;
    let mut buffer = [0u8; BUFFER];
    let mut hash = Sha256::new();
    while left > 0 {
        let n = left.min(BUFFER as u64) as usize;
        reader.read_exact(&mut buffer[..n])?;
        writer.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
        left -= n as u64;
    }
    Ok(sha256::hex(&hash.finalize()))
}
pub(crate) fn hash_file(path: &Path) -> io::Result<(u64, String)> {
    no_link(path)?;
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let hash = transfer(&mut file, &mut io::sink(), size)?;
    let mut extra = [0];
    if file.read(&mut extra)? != 0 {
        return Err(io::Error::other("文件读取期间长度变化"));
    }
    Ok((size, hash))
}
struct HashWriter<W> {
    inner: W,
    hash: Sha256,
    bytes: u64,
}
impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(b)?;
        self.hash.update(&b[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
#[derive(Clone)]
struct Entry {
    path: String,
    size: u64,
    hash: String,
}
impl Entry {
    fn to_json(&self) -> Json {
        Json::obj(vec![
            ("path", Json::str(&self.path)),
            ("size", num(self.size)),
            ("sha256", Json::str(&self.hash)),
        ])
    }
}
struct Verified {
    info: BackupInfo,
    entries: Vec<Entry>,
    offset: u64,
    state: Json,
}
fn counts(state: &Json, media: u64, missing: u64) -> Result<BackupCounts, CoreError> {
    let mut c = BackupCounts {
        media_files: media,
        missing_media: missing,
        ..BackupCounts::default()
    };
    c.tags = array(state, "tags")?.len() as u64;
    for row in array(state, "records")? {
        if row.get("favorite") == Some(&Json::Bool(true)) {
            c.favorites += 1;
        }
        if text(row, "status")? == RecordStatus::Trashed.as_str() {
            c.trashed += 1;
        } else {
            if row.get("formal").is_some_and(|v| *v != Json::Null) {
                c.formal += 1;
            }
            if row.get("draft").is_some_and(|v| *v != Json::Null) {
                c.drafts += 1;
            }
        }
    }
    c.deletion_markers = array(state, "deletionMarkers")?.len() as u64;
    c.conflict_copies = array(state, "conflictCopies")?.len() as u64;
    Ok(c)
}
fn refs(state: &Json) -> Result<BTreeMap<String, Vec<PhotoUse>>, CoreError> {
    let state = State::from_json(state)?;
    let mut out: BTreeMap<String, Vec<PhotoUse>> = BTreeMap::new();
    for (_, p) in state.photo_refs() {
        out.entry(p.asset_id.clone()).or_default().push(p.clone());
    }
    Ok(out)
}

/// Fully verifies a container without opening a Store or writing any file.
pub fn verify_backup(path: &Path) -> Result<BackupInfo, CoreError> {
    let mut f = File::open(path)?;
    Ok(verify(&mut f)?.info)
}
fn verify(file: &mut File) -> Result<Verified, CoreError> {
    file.seek(SeekFrom::Start(0))?;
    let mut encrypted_magic = [0; 10];
    if file.read_exact(&mut encrypted_magic).is_ok() && &encrypted_magic == b"SGBAKENC\0\x01" {
        return Err(CoreError::new("BACKUP_PASSWORD_REQUIRED", "此备份需要口令"));
    }
    let bytes = file.metadata()?.len();
    if bytes < 64 {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0; 16];
    file.read_exact(&mut header)?;
    if &header[..8] != MAGIC {
        return Err(invalid());
    }
    let end = bytes - 48;
    file.seek(SeekFrom::Start(end))?;
    let mut trailer = [0; 48];
    file.read_exact(&mut trailer)?;
    if &trailer[..8] != END
        || u64::from_le_bytes(trailer[40..].try_into().map_err(|_| invalid())?) != end
    {
        return Err(truncated());
    }
    file.seek(SeekFrom::Start(0))?;
    let hash = transfer(file, &mut io::sink(), end).map_err(|_| corrupt("container"))?;
    if hash != sha256::hex(&trailer[8..40]) {
        return Err(corrupt("container"));
    }
    let len = u64::from_le_bytes(header[8..16].try_into().map_err(|_| invalid())?);
    if len > MAX_MANIFEST || len > end - 16 {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(16))?;
    let mut manifest = Vec::new();
    transfer(file, &mut manifest, len).map_err(|_| invalid())?;
    let manifest = std::str::from_utf8(&manifest).map_err(|_| invalid())?;
    let m = parse_document(manifest).map_err(|_| invalid())?;
    if text(&m, "format")? != "shiguang-backup" {
        return Err(invalid());
    }
    let version = uint(&m, "formatVersion")?;
    if version > 1 {
        return Err(CoreError::new(
            BACKUP_FORMAT_TOO_NEW,
            "备份格式来自更新版本，请先升级",
        ));
    }
    if version != 1 {
        return Err(invalid());
    }
    let mode = m.get("encryption").ok_or_else(invalid)?;
    if text(mode, "mode")? != "none" {
        return Err(CoreError::new(
            BACKUP_ENCRYPTED_UNSUPPORTED,
            "此备份已加密，当前版本尚不支持口令解密",
        ));
    }
    let schema_version = uint(&m, "schemaVersion")?;
    if schema_version > schema::CURRENT_SCHEMA_VERSION as u64 {
        return Err(CoreError::new(
            BACKUP_SCHEMA_TOO_NEW,
            "备份来自更新版本的拾光，请先升级",
        ));
    }
    if schema_version == 0 || text(&m, "compression")? != "none" {
        return Err(invalid());
    }
    let mut info = BackupInfo {
        counts: BackupCounts::parse(m.get("counts").ok_or_else(invalid)?)?,
        exported_at: text(&m, "exportedAt")?.into(),
        app_version: text(&m, "appVersion")?.into(),
        schema_version: schema_version as i64,
        bytes,
        missing_media: Vec::new(),
    };
    let mut missing = BTreeSet::new();
    for item in array(&m, "missingMedia")? {
        let asset = text(item, "assetId")?;
        if !name_valid(asset) || !missing.insert(asset.to_owned()) {
            return Err(invalid());
        }
        info.missing_media.push(MissingMedia {
            asset_id: asset.into(),
        });
    }
    let items = array(&m, "entries")?;
    if items.len() > MAX_ENTRIES {
        return Err(invalid());
    }
    let mut entries = Vec::new();
    let mut paths = BTreeSet::new();
    let mut total = 16 + len;
    for item in items {
        let path = text(item, "path")?;
        let size = uint(item, "size")?;
        let hash = text(item, "sha256")?;
        if !path_valid(path)
            || !paths.insert(path.to_ascii_lowercase())
            || !digest_valid(hash)
            || size > bytes
        {
            return Err(invalid());
        }
        total = total.checked_add(size).ok_or_else(invalid)?;
        if total > bytes {
            return Err(invalid());
        }
        entries.push(Entry {
            path: path.into(),
            size,
            hash: hash.into(),
        });
    }
    if !paths.contains("state.json") {
        return Err(invalid());
    }
    if total != end {
        return Err(corrupt("entries size"));
    }
    let mut state_bytes = Vec::new();
    for entry in &entries {
        let hash = if entry.path == "state.json" {
            transfer(file, &mut state_bytes, entry.size)
        } else {
            transfer(file, &mut io::sink(), entry.size)
        }
        .map_err(|_| corrupt(&entry.path))?;
        if hash != entry.hash {
            return Err(corrupt(&entry.path));
        }
    }
    let raw = parse_document(std::str::from_utf8(&state_bytes).map_err(|_| corrupt("state.json"))?)
        .map_err(|_| corrupt("state.json"))?;
    if schema::version(&raw).map_err(|_| corrupt("state.json"))? != info.schema_version {
        return Err(corrupt("state.json schemaVersion"));
    }
    let state = schema::migrate(raw).map_err(|_| corrupt("state.json"))?;
    let references = refs(&state).map_err(|_| corrupt("state.json"))?;
    let actual = counts(&state, (entries.len() - 1) as u64, missing.len() as u64)
        .map_err(|_| corrupt("counts"))?;
    if actual != info.counts {
        return Err(corrupt("counts"));
    }
    let mut media: BTreeMap<&str, &Entry> = BTreeMap::new();
    for e in entries.iter().filter(|e| e.path != "state.json") {
        let asset = Path::new(&e.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(invalid)?;
        if media.insert(asset, e).is_some()
            || !references.contains_key(asset)
            || missing.contains(asset)
        {
            return Err(corrupt(&e.path));
        }
    }
    for asset in &missing {
        if !references.contains_key(asset) {
            return Err(corrupt("missingMedia"));
        }
    }
    for (asset, photos) in references {
        if missing.contains(&asset) {
            continue;
        }
        let e = media
            .get(asset.as_str())
            .ok_or_else(|| corrupt(&format!("media/{asset}")))?;
        if photos
            .iter()
            .any(|p| p.bytes != e.size || p.sha256 != e.hash)
        {
            return Err(corrupt(&e.path));
        }
    }
    Ok(Verified {
        info,
        entries,
        offset: 16 + len,
        state,
    })
}

impl Store {
    /// Exports a consistent snapshot while holding the store write lock.
    pub fn export_backup(&self, dest: &Path, app_version: &str) -> Result<ExportReport, CoreError> {
        let _lock = write_lock(self.root())?;
        self.export_backup_locked(dest, app_version, false)
    }
    fn export_backup_locked(
        &self,
        dest: &Path,
        app_version: &str,
        internal: bool,
    ) -> Result<ExportReport, CoreError> {
        check_root(self.root())?;
        if fs::symlink_metadata(dest).is_ok() {
            return Err(CoreError::new(
                BACKUP_DEST_EXISTS,
                "备份目标已存在，请选择新的文件名",
            ));
        }
        let parent = dest
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = dest
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(invalid)?;
        // A backup written into media/state/cache would mutate the source snapshot.
        let canonical_parent = fs::canonicalize(parent)?;
        let root = fs::canonicalize(self.root())?;
        let destination = canonical_parent.join(name);
        if (canonical_parent == root
            && (name.starts_with(".tmp-")
                || name.starts_with(".restore-")
                || name.starts_with(".merge-")
                || (!internal && (name.starts_with(".encrypt-") || name.starts_with(".decrypt-")))))
            || destination == root.join("state.json")
            || destination == root.join(JOURNAL)
            || destination == root.join(".write.lock")
            || destination == root.join(".instance.lock")
            || ["media", "previews", "media-quarantine"]
                .iter()
                .any(|p| canonical_parent.starts_with(root.join(p)))
        {
            return Err(invalid());
        }
        let state = self.portable_backup_snapshot()?;
        let references = refs(&state)?;
        let state_bytes = state.pretty().into_bytes();
        let mut entries = vec![Entry {
            path: "state.json".into(),
            size: state_bytes.len() as u64,
            hash: sha256::hex_digest(&state_bytes),
        }];
        let mut missing = Vec::new();
        let files = media_paths(self.root())?;
        for (asset, photos) in references {
            let found = files
                .iter()
                .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(&asset));
            let candidate =
                found.and_then(|p| hash_file(p).ok().map(|(size, hash)| (p, size, hash)));
            if let Some((path, size, hash)) = candidate.filter(|(_, size, hash)| {
                photos.iter().all(|p| p.bytes == *size && p.sha256 == *hash)
            }) {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(invalid)?;
                if !name_valid(name) {
                    return Err(invalid());
                }
                entries.push(Entry {
                    path: format!("media/{name}"),
                    size,
                    hash,
                });
            } else {
                missing.push(MissingMedia { asset_id: asset });
            }
        }
        entries[1..].sort_by(|a, b| a.path.cmp(&b.path));
        if entries.len() > MAX_ENTRIES {
            return Err(invalid());
        }
        let info = BackupInfo {
            counts: counts(&state, (entries.len() - 1) as u64, missing.len() as u64)?,
            exported_at: time::now_rfc3339(),
            schema_version: schema::CURRENT_SCHEMA_VERSION,
            app_version: app_version.into(),
            bytes: 0,
            missing_media: missing.clone(),
        };
        let manifest = Json::obj(vec![
            ("format", Json::str("shiguang-backup")),
            ("formatVersion", Json::Num(1)),
            ("schemaVersion", Json::Num(info.schema_version)),
            ("appVersion", Json::str(app_version)),
            ("exportedAt", Json::str(&info.exported_at)),
            ("encryption", Json::obj(vec![("mode", Json::str("none"))])),
            ("compression", Json::str("none")),
            ("counts", info.counts.to_json()),
            ("missingMedia", missing_json(&missing)),
            (
                "entries",
                Json::Arr(entries.iter().map(Entry::to_json).collect()),
            ),
        ])
        .dump();
        if manifest.len() as u64 > MAX_MANIFEST {
            return Err(invalid());
        }
        let partial = parent.join(format!(
            ".{name}.partial-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let file = private_file(&partial)?;
        let result = (|| {
            let mut out = HashWriter {
                inner: file,
                hash: Sha256::new(),
                bytes: 0,
            };
            out.write_all(MAGIC)?;
            out.write_all(&(manifest.len() as u64).to_le_bytes())?;
            out.write_all(manifest.as_bytes())?;
            for entry in &entries {
                if entry.path == "state.json" {
                    out.write_all(&state_bytes)?;
                } else {
                    let mut source = File::open(self.root().join(&entry.path)).map_err(|_| {
                        CoreError::new(BACKUP_SOURCE_CHANGED, "导出期间原图发生变化")
                    })?;
                    let hash = transfer(&mut source, &mut out, entry.size).map_err(|_| {
                        CoreError::new(BACKUP_SOURCE_CHANGED, "导出期间原图发生变化")
                    })?;
                    let mut extra = [0];
                    if hash != entry.hash || source.read(&mut extra)? != 0 {
                        return Err(CoreError::new(
                            BACKUP_SOURCE_CHANGED,
                            "导出期间原图发生变化",
                        ));
                    }
                }
                fault::hit(FaultPoint::BackupWrite)?;
            }
            let hash = out.hash.finalize();
            out.inner.write_all(END)?;
            out.inner.write_all(&hash)?;
            out.inner.write_all(&out.bytes.to_le_bytes())?;
            out.inner.sync_all()?;
            drop(out.inner);
            let info = verify_backup(&partial)?;
            let (bytes, sha256) = hash_file(&partial)?;
            fault::hit(FaultPoint::BackupFinalize)?;
            // hard_link is an atomic no-clobber publication on all four platforms.
            // The partial and destination share a directory / filesystem. Closing all
            // handles first also permits Windows unlink of the temporary name.
            match fs::hard_link(&partial, dest) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(CoreError::new(
                        BACKUP_DEST_EXISTS,
                        "备份目标已存在，请选择新的文件名",
                    ));
                }
                // 个别文件系统/沙箱（如部分 Android 存储、FAT/exFAT）不允许硬链接：
                // 退回“确认目标不存在后 rename”。仍不会覆盖已有文件（仅剩极小的并发窗口）。
                Err(_) if fs::symlink_metadata(dest).is_err() => {
                    fs::rename(&partial, dest)?;
                }
                Err(_) => {
                    return Err(CoreError::new(
                        BACKUP_DEST_EXISTS,
                        "备份目标已存在，请选择新的文件名",
                    ));
                }
            }
            let finalize = (|| {
                if fs::symlink_metadata(&partial).is_ok() {
                    fs::remove_file(&partial)?;
                }
                sync_dir(parent)
            })();
            if let Err(e) = finalize {
                let _ = fs::remove_file(dest);
                let _ = sync_dir(parent);
                return Err(e);
            }
            Ok(ExportReport {
                path: dest.to_owned(),
                bytes,
                sha256,
                manifest: info,
                missing_media: missing,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result
    }
    /// Verifies, stages, copies a permanent safety backup, then atomically commits state.
    pub fn restore_backup_overwrite(&mut self, path: &Path) -> Result<RestoreReport, CoreError> {
        if self.instance_lock.is_none() {
            return Err(CoreError::new(
                STORE_NOT_EXCLUSIVE,
                "覆盖恢复需要独占打开数据目录",
            ));
        }
        let _lock = write_lock(self.root())?;
        let mut source = File::open(path)?;
        let mut verified = verify(&mut source)?;
        let mut restored_settings = State::from_json(&verified.state)?.settings;
        restored_settings.app_lock = self.candidate_state()?.settings.app_lock;
        schema::set(&mut verified.state, "settings", restored_settings.to_json())?;
        check_root(self.root())?;
        // Complete an earlier simulated interruption before creating another journal.
        recover(self.root())?;
        let (staging_name, old_name, safety_name) = loop {
            let tag = id();
            let paths = (
                format!(".restore-staging-{tag}"),
                format!(".restore-old-{tag}"),
                format!("backups/pre-restore-{tag}"),
            );
            if [&paths.0, &paths.1, &paths.2]
                .iter()
                .any(|p| fs::symlink_metadata(self.root().join(p)).is_ok())
            {
                continue;
            }
            match fs::create_dir(self.root().join(&paths.0)) {
                Ok(()) => break paths,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(restore_error("stage", e)),
            }
        };
        let staging = self.root().join(&staging_name);
        let safety = self.root().join(&safety_name);
        let stage = (|| {
            fs::create_dir(staging.join("media"))?;
            source.seek(SeekFrom::Start(verified.offset))?;
            for e in &verified.entries {
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(staging.join(&e.path))?;
                let hash = transfer(&mut source, &mut f, e.size)?;
                f.sync_all()?;
                drop(f);
                if hash != e.hash {
                    return Err(corrupt(&e.path));
                }
                fault::hit(FaultPoint::RestoreStage)?;
            }
            // Restore portable preferences, but retain this device's lock and backoff.
            // Even a crafted incoming lock must never replace or reset the local gate.
            atomic(
                &staging.join("state.json"),
                verified.state.pretty().as_bytes(),
            )?;
            // If old and new JSON bytes coincide, a state-byte comparison cannot
            // identify the commit point. A trailing JSON whitespace byte makes
            // the staged representation distinct without changing domain data.
            let staged_state = staging.join("state.json");
            let staged_digest = hash_file(&staged_state)?;
            let current_digest = match hash_file(&self.root().join("state.json")) {
                Ok(digest) => Some(digest),
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            if Some(staged_digest) == current_digest {
                let mut state_file = OpenOptions::new().append(true).open(&staged_state)?;
                state_file.write_all(b"\n")?;
                state_file.sync_all()?;
            }
            let state_hash = hash_file(&staged_state)?.1;
            sync_dir(&staging.join("media"))?;
            sync_dir(&staging)?;
            sync_dir(self.root())?;
            Ok::<_, CoreError>(state_hash)
        })();
        drop(source);
        let state_hash = match stage {
            Ok(hash) => hash,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(restore_error("stage", e));
            }
        };
        let safety_result = self.safety_backup(&safety);
        if let Err(e) = safety_result {
            let _ = fs::remove_dir_all(&staging);
            return Err(CoreError::with_stage(
                RESTORE_SAFETY_BACKUP_FAILED,
                "safety",
                format!("恢复前安全副本失败：{e}"),
            ));
        }
        let journal = Journal {
            staging: staging_name,
            old: old_name,
            safety: safety_name,
            state_hash,
        };
        let switch = (|| {
            atomic(
                &self.root().join(JOURNAL),
                journal.to_json().dump().as_bytes(),
            )?;
            let old = self.root().join(&journal.old);
            fs::create_dir(&old)?;
            sync_dir(self.root())?;
            fs::rename(self.root().join("media"), old.join("media"))?;
            sync_dir(&old)?;
            sync_dir(self.root())?;
            fs::rename(staging.join("media"), self.root().join("media"))?;
            sync_dir(&staging)?;
            sync_dir(self.root())?;
            fault::hit(FaultPoint::CrashAfterMediaSwap)?;
            fault::hit(FaultPoint::RestoreSwitchMedia)?;
            if let Durability::Uncertain { error } = persist::write_atomic_restore(
                &self.root().join("state.json"),
                &staging.join("state.json"),
            )? {
                return Err(CoreError::io(error));
            }
            Ok::<_, CoreError>(())
        })();
        if let Err(e) = switch {
            // A persist parent-sync failure can occur AFTER state replacement. Inspect
            // disk before deciding; never roll media back after the commit point.
            if committed(self.root(), &journal)? {
                return Err(restore_error("switch", e));
            }
            if fault::hit(FaultPoint::CrashAfterMediaSwap).is_err() {
                return Err(restore_error("switch", e));
            }
            if self.root().join(JOURNAL).exists() {
                rollback(self.root(), &journal).map_err(|e| restore_error("switch", e))?;
            } else {
                let _ = fs::remove_dir_all(&staging);
            }
            return Err(restore_error("switch", e));
        }
        fault::hit(FaultPoint::RestoreAfterCommit).map_err(|e| restore_error("switch", e))?;
        finish(self.root(), &journal).map_err(|e| restore_error("reopen", e))?;
        self.install_restored_state(&verified.state)
            .map_err(|e| restore_error("reopen", e))?;
        // reconcile_media takes its own write lock; release ours only after the
        // entire restore and reconciliation are complete via the unlocked helper.
        let media_report = self
            .reconcile_media_locked()
            .map_err(|e| restore_error("reopen", e))?;
        Ok(RestoreReport {
            restored_counts: verified.info.counts,
            safety_backup_dir: safety,
            media_report,
        })
    }
    fn safety_backup(&self, dest: &Path) -> Result<(), CoreError> {
        let backups = self.root().join("backups");
        fs::create_dir_all(&backups)?;
        fs::create_dir(dest)?;
        let result = (|| {
            fs::create_dir(dest.join("media"))?;
            if self.root().join("state.json").exists() {
                copy_checked(&self.root().join("state.json"), &dest.join("state.json"))?;
            }
            for path in media_paths(self.root())? {
                let name = path.file_name().ok_or_else(invalid)?;
                copy_checked(&path, &dest.join("media").join(name))?;
                fault::hit(FaultPoint::RestoreSafety)?;
            }
            fault::hit(FaultPoint::RestoreSafety)?;
            let state = self.backup_snapshot()?;
            let c = counts(&state, media_paths(self.root())?.len() as u64, 0)?;
            atomic(
                &dest.join("SAFETY.json"),
                Json::obj(vec![
                    ("createdAt", Json::str(time::now_rfc3339())),
                    ("counts", c.to_json()),
                ])
                .pretty()
                .as_bytes(),
            )?;
            sync_dir(&dest.join("media"))?;
            sync_dir(dest)?;
            sync_dir(&backups)?;
            sync_dir(self.root())?;
            Ok(())
        })();
        // create_dir(dest) succeeded above: only this invocation owns this
        // incomplete copy. Never delete a pre-existing complete safety backup.
        if result.is_err() {
            let _ = fs::remove_dir_all(dest);
        }
        result
    }
}
fn restore_error(stage: &'static str, e: impl std::fmt::Display) -> CoreError {
    CoreError::with_stage(RESTORE_FAILED, stage, format!("恢复失败：{e}"))
}
fn media_paths(root: &Path) -> Result<Vec<PathBuf>, CoreError> {
    let mut out = Vec::new();
    for e in fs::read_dir(root.join("media"))? {
        let e = e?;
        if !e.file_type()?.is_file() {
            return Err(CoreError::io("media 中含符号链接或非普通文件"));
        }
        out.push(e.path());
    }
    out.sort();
    Ok(out)
}
fn copy_checked(src: &Path, dest: &Path) -> Result<(), CoreError> {
    let mut input = File::open(src)?;
    no_link(src)?;
    let size = input.metadata()?.len();
    let mut output = OpenOptions::new().write(true).create_new(true).open(dest)?;
    let hash = transfer(&mut input, &mut output, size)?;
    let mut extra = [0];
    if input.read(&mut extra)? != 0 {
        return Err(CoreError::io("安全副本源文件变化"));
    }
    output.sync_all()?;
    drop(output);
    drop(input);
    if hash_file(dest)? != (size, hash) {
        return Err(CoreError::io("安全副本校验失败"));
    }
    Ok(())
}
struct Journal {
    staging: String,
    old: String,
    safety: String,
    state_hash: String,
}
impl Journal {
    fn to_json(&self) -> Json {
        Json::obj(vec![
            ("phase", Json::str("switching")),
            ("staging", Json::str(&self.staging)),
            ("old", Json::str(&self.old)),
            ("safety", Json::str(&self.safety)),
            ("stateSha256", Json::str(&self.state_hash)),
        ])
    }
    fn parse(v: &Json) -> Result<Self, CoreError> {
        let j = Self {
            staging: text(v, "staging")?.into(),
            old: text(v, "old")?.into(),
            safety: text(v, "safety")?.into(),
            state_hash: text(v, "stateSha256")?.into(),
        };
        let suffix = j
            .staging
            .strip_prefix(".restore-staging-")
            .filter(|s| name_valid(s))
            .ok_or_else(invalid)?;
        if text(v, "phase")? != "switching"
            || j.old != format!(".restore-old-{suffix}")
            || j.safety != format!("backups/pre-restore-{suffix}")
            || !digest_valid(&j.state_hash)
        {
            return Err(invalid());
        }
        Ok(j)
    }
}
fn committed(root: &Path, j: &Journal) -> Result<bool, CoreError> {
    let staged_media = root.join(&j.staging).join("media");
    Ok(!staged_media.exists()
        && root.join("media").is_dir()
        && hash_file(&root.join("state.json"))
            .map(|(_, h)| h == j.state_hash)
            .unwrap_or(false))
}
fn clear_previews(root: &Path) -> Result<(), CoreError> {
    let path = root.join("previews");
    no_link(&path)?;
    if path.exists() {
        fs::remove_dir_all(&path)?;
    }
    fs::create_dir(&path)?;
    sync_dir(root)
}
fn finish(root: &Path, j: &Journal) -> Result<(), CoreError> {
    let old = root.join(&j.old);
    let safety = root.join(&j.safety);
    let staging = root.join(&j.staging);
    if old.exists() {
        let replaced = safety.join("replaced");
        if replaced.exists() {
            return Err(restore_error("reopen", "安全副本 replaced 已存在"));
        }
        fs::rename(&old, &replaced)?;
        sync_dir(&safety)?;
        sync_dir(root)?;
    }
    clear_previews(root)?;
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
        sync_dir(root)?;
    }
    // Delete the journal LAST: every crash during cleanup remains recoverable.
    fs::remove_file(root.join(JOURNAL))?;
    sync_dir(root)?;
    Ok(())
}
fn rollback(root: &Path, j: &Journal) -> Result<(), CoreError> {
    let old = root.join(&j.old);
    let staging = root.join(&j.staging);
    let old_media = old.join("media");
    if old_media.exists() {
        if root.join("media").exists() {
            fs::rename(root.join("media"), staging.join("media"))?;
            sync_dir(root)?;
            sync_dir(&staging)?;
        }
        fs::rename(&old_media, root.join("media"))?;
        sync_dir(&old)?;
        sync_dir(root)?;
    }
    // Keep the journal through rollback cleanup too. It is safe to repeat even if
    // old/media was already moved back before a crash.
    if old.exists() {
        fs::remove_dir(&old)?;
    }
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    sync_dir(root)?;
    fs::remove_file(root.join(JOURNAL))?;
    sync_dir(root)?;
    Ok(())
}
/// Called under the Store write lock, before `.tmp-*` cleanup / state loading.
pub(crate) fn recover(root: &Path) -> Result<(), CoreError> {
    check_root(root)?;
    if root.join(JOURNAL).exists() {
        let size = fs::metadata(root.join(JOURNAL))?.len();
        if size > 16 * 1024 {
            return Err(restore_error("recovery", "恢复日志过大"));
        }
        let value = parse_document(&fs::read_to_string(root.join(JOURNAL))?)
            .map_err(|e| restore_error("recovery", e))?;
        let j = Journal::parse(&value).map_err(|e| restore_error("recovery", e))?;
        for path in [
            root.join(&j.staging),
            root.join(&j.old),
            root.join(&j.safety),
            root.join(&j.staging).join("media"),
            root.join(&j.staging).join("state.json"),
            root.join(&j.old).join("media"),
            root.join(&j.safety).join("replaced"),
        ] {
            no_link(&path)?;
        }
        if committed(root, &j)? {
            finish(root, &j)?;
        } else {
            rollback(root, &j)?;
        }
    }
    for e in fs::read_dir(root)? {
        let e = e?;
        if e.file_name()
            .to_string_lossy()
            .starts_with(".restore-staging-")
        {
            if e.file_type()?.is_dir() {
                fs::remove_dir_all(e.path())?;
            } else if e.file_type()?.is_symlink() {
                fs::remove_file(e.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_safety_directory_is_never_removed_on_create_failure() {
        let root = std::env::temp_dir().join(format!("sg-safety-collision-{}", id()));
        let store = Store::open_exclusive(&root).unwrap();
        let safety = root.join("backups/pre-restore-existing");
        fs::create_dir_all(&safety).unwrap();
        fs::write(safety.join("SAFETY.json"), b"synthetic existing safety").unwrap();
        assert!(store.safety_backup(&safety).is_err());
        assert_eq!(
            fs::read(safety.join("SAFETY.json")).unwrap(),
            b"synthetic existing safety"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

const MERGE_JOURNAL: &str = ".merge-journal.json";
fn merge_error(e: impl std::fmt::Display) -> CoreError {
    CoreError::new("MERGE_FAILED", format!("合并失败：{e}"))
}
struct MergeMedia {
    entry: Entry,
    offset: u64,
}
fn inspect_merge_media(
    root: &Path,
    v: &Verified,
    merged: &Json,
    plan: &mut crate::MergePlan,
) -> Result<Vec<MergeMedia>, CoreError> {
    check_root(root)?;
    let references = refs(merged)?;
    let existing = media_paths(root)?;
    let mut offset = v.offset;
    let mut entries = BTreeMap::new();
    for e in &v.entries {
        if e.path != "state.json" {
            let asset = Path::new(&e.path)
                .file_stem()
                .and_then(|n| n.to_str())
                .ok_or_else(invalid)?;
            entries.insert(asset.to_owned(), (e, offset));
        }
        offset += e.size;
    }
    let mut added = Vec::new();
    for (asset, photos) in references {
        let local = existing.iter().find(|p| {
            p.file_stem()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(&asset))
        });
        let entry = entries.get(&asset);
        if let Some(path) = local {
            let (size, hash) = hash_file(path)?;
            if entry.is_some() && photos.iter().any(|p| p.sha256 != hash || p.bytes != size) {
                plan.media_conflicts.push(asset);
            }
        } else if let Some((entry, offset)) = entry {
            if photos
                .iter()
                .all(|p| p.sha256 == entry.hash && p.bytes == entry.size)
            {
                added.push(MergeMedia {
                    entry: (*entry).clone(),
                    offset: *offset,
                });
                plan.media_added += 1;
            } else {
                plan.media_conflicts.push(asset);
            }
        } else {
            plan.media_missing += 1;
        }
    }
    Ok(added)
}
impl Store {
    pub fn plan_merge(&self, path: &Path) -> Result<crate::MergePlan, CoreError> {
        if self.instance_lock.is_none() {
            return Err(CoreError::new(
                STORE_NOT_EXCLUSIVE,
                "合并需要独占打开数据目录",
            ));
        }
        let _lock = write_lock(self.root())?;
        let verified = verify(&mut File::open(path)?)?;
        let local = self.backup_snapshot()?;
        let (merged, mut plan) = crate::merge_states(
            &State::from_json(&local)?,
            &State::from_json(&verified.state)?,
        )?;
        inspect_merge_media(
            self.root(),
            &verified,
            &merged.to_json(self.seed()),
            &mut plan,
        )?;
        Ok(plan)
    }
    pub fn merge_backup(&mut self, path: &Path) -> Result<crate::MergeReport, CoreError> {
        if self.instance_lock.is_none() {
            return Err(CoreError::new(
                STORE_NOT_EXCLUSIVE,
                "合并需要独占打开数据目录",
            ));
        }
        let _lock = write_lock(self.root())?;
        let mut source = File::open(path)?;
        let verified = verify(&mut source)?;
        check_root(self.root())?;
        recover_merge(self.root())?;
        let local = self.backup_snapshot()?;
        let (merged, mut plan) = crate::merge_states(
            &State::from_json(&local)?,
            &State::from_json(&verified.state)?,
        )?;
        let seed = local
            .get("seed")
            .and_then(Json::as_str)
            .ok_or_else(invalid)?;
        let value = merged.to_json(seed);
        let media = inspect_merge_media(self.root(), &verified, &value, &mut plan)?;
        // Strictly parse the serialized representation before any write.
        let mut encoded = value.pretty().into_bytes();
        State::from_json(
            &parse_document(std::str::from_utf8(&encoded).map_err(|_| invalid())?)
                .map_err(|_| invalid())?,
        )?;
        fault::hit(FaultPoint::MergeStage).map_err(merge_error)?;
        if value == local && media.is_empty() {
            self.install_restored_state(&value)?;
            return Ok(crate::MergeReport {
                plan,
                safety_backup_dir: None,
                media_report: self.reconcile_media_locked()?,
            });
        }
        if fs::read(self.root().join("state.json")).ok().as_ref() == Some(&encoded) {
            encoded.push(b'\n');
        }
        let tag = id();
        let safety = self.root().join(format!("backups/pre-merge-{tag}"));
        no_link(&self.root().join("backups"))?;
        fs::create_dir_all(self.root().join("backups"))?;
        fs::create_dir(&safety)?;
        let safety_result = (|| {
            if self.root().join("state.json").exists() {
                copy_checked(&self.root().join("state.json"), &safety.join("state.json"))?;
            }
            atomic(
                &safety.join("SAFETY.json"),
                Json::obj(vec![(
                    "mediaAdded",
                    Json::Arr(media.iter().map(|m| Json::str(&m.entry.path)).collect()),
                )])
                .dump()
                .as_bytes(),
            )?;
            sync_dir(&safety)?;
            sync_dir(&self.root().join("backups"))
        })();
        if let Err(e) = safety_result {
            let _ = fs::remove_dir_all(&safety);
            return Err(merge_error(e));
        }
        let mut names = Vec::new();
        for (i, m) in media.iter().enumerate() {
            names.push(m.entry.path.clone());
            names.push(format!("media/.tmp-merge-{tag}-{i}"));
        }
        let journal = Json::obj(vec![
            ("stateSha256", Json::str(sha256::hex_digest(&encoded))),
            ("files", Json::Arr(names.iter().map(Json::str).collect())),
        ]);
        atomic(&self.root().join(MERGE_JOURNAL), journal.dump().as_bytes())?;
        let result = (|| {
            for (i, m) in media.iter().enumerate() {
                let tmp = self.root().join(format!("media/.tmp-merge-{tag}-{i}"));
                let dest = self.root().join(&m.entry.path);
                if fs::symlink_metadata(&dest).is_ok() {
                    return Err(merge_error("目标原图已存在"));
                }
                let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
                source.seek(SeekFrom::Start(m.offset))?;
                let hash = transfer(&mut source, &mut f, m.entry.size)?;
                f.sync_all()?;
                drop(f);
                if hash != m.entry.hash {
                    return Err(corrupt(&m.entry.path));
                }
                fs::rename(&tmp, &dest)?;
                sync_dir(&self.root().join("media"))?;
                fault::hit(FaultPoint::MergeMediaWrite)?;
            }
            fault::hit(FaultPoint::CrashAfterMergeMedia)?;
            fault::hit(FaultPoint::MergeStateWrite)?;
            // The state replacement is the commit point. A subsequent sync error
            // must be resolved by the journal, never by removing committed media.
            atomic(&self.root().join("state.json"), &encoded)?;
            Ok::<_, CoreError>(())
        })();
        drop(source);
        if let Err(e) = result {
            if fault::hit(FaultPoint::CrashAfterMergeMedia).is_err() {
                return Err(merge_error(e));
            }
            recover_merge(self.root())?;
            return Err(merge_error(e));
        }
        fault::hit(FaultPoint::MergeAfterCommit).map_err(merge_error)?;
        recover_merge(self.root())?;
        self.install_restored_state(&value)?;
        Ok(crate::MergeReport {
            plan,
            safety_backup_dir: Some(safety),
            media_report: self.reconcile_media_locked()?,
        })
    }
}
pub(crate) fn recover_merge(root: &Path) -> Result<(), CoreError> {
    let path = root.join(MERGE_JOURNAL);
    no_link(&path)?;
    if !path.exists() {
        return Ok(());
    }
    check_root(root)?;
    if fs::metadata(&path)?.len() > 64 * 1024 * 1024 {
        return Err(merge_error("合并日志过大"));
    }
    let j = parse_document(&fs::read_to_string(&path)?).map_err(|_| merge_error("合并日志无效"))?;
    let hash = text(&j, "stateSha256")?;
    if !digest_valid(hash) {
        return Err(merge_error("合并日志摘要无效"));
    }
    let mut files = Vec::new();
    let listed = array(&j, "files")?;
    if listed.len() > 2 * MAX_ENTRIES {
        return Err(merge_error("合并日志文件数过多"));
    }
    for v in listed {
        let name = v.as_str().ok_or_else(invalid)?;
        let file = name.strip_prefix("media/").ok_or_else(invalid)?;
        let temporary = file.strip_prefix(".tmp-merge-").is_some_and(name_valid);
        if !(name_valid(file) || temporary) {
            return Err(merge_error("合并日志路径无效"));
        }
        let path = root.join(name);
        no_link(&path)?;
        files.push(path);
    }
    let committed = match hash_file(&root.join("state.json")) {
        Ok((_, current)) => current == hash,
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    if !committed {
        for file in files {
            match fs::remove_file(file) {
                Ok(()) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
        }
        sync_dir(&root.join("media"))?;
    }
    fs::remove_file(path)?;
    sync_dir(root)
}

mod crypto;
pub use crypto::{
    decrypt_backup, is_encrypted, verify_backup_with_password, BackupPassword, KdfParams,
};
