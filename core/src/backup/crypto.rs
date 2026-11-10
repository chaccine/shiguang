//! SGBAKENC v1: bounded STREAM framing, authenticated header, no secret diagnostics.
use super::*;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{AeadInPlace, KeyInit},
    Tag, XChaCha20Poly1305, XNonce,
};
use zeroize::Zeroizing;
const MAGIC_ENC: &[u8; 10] = b"SGBAKENC\0\x01";
const CHUNK: usize = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m: u32,
    pub t: u32,
    pub p: u32,
}
impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m: 65536,
            t: 3,
            p: 1,
        }
    }
}
impl KdfParams {
    /// Low cost only for tests and explicit CLI --kdf-fast.
    pub fn fast() -> Self {
        Self { m: 8, t: 1, p: 1 }
    }
    fn validate(self) -> Result<Params, CoreError> {
        if !(8..=1_048_576).contains(&self.m)
            || !(1..=10).contains(&self.t)
            || !(1..=4).contains(&self.p)
        {
            return Err(kdf_error());
        }
        Params::new(self.m, self.t, self.p, Some(32)).map_err(|_| kdf_error())
    }
}
fn kdf_error() -> CoreError {
    CoreError::new("BACKUP_KDF_PARAMS_INVALID", "备份口令派生参数无效")
}
fn crypto_error(first: bool) -> CoreError {
    if first {
        CoreError::new("BACKUP_PASSWORD_WRONG", "口令不正确，或文件已损坏")
    } else {
        corrupt("encrypted chunk")
    }
}
fn random<const N: usize>() -> Result<[u8; N], CoreError> {
    let mut b = [0; N];
    getrandom::getrandom(&mut b).map_err(|_| CoreError::io("无法获取安全随机数"))?;
    Ok(b)
}
fn derive(
    password: &str,
    params: KdfParams,
    salt: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CoreError> {
    let params = params.validate()?;
    let secret = Zeroizing::new(password.as_bytes().to_vec());
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(&secret, salt, key.as_mut())
        .map_err(|_| kdf_error())?;
    Ok(key)
}
fn b64<const N: usize>(s: &str) -> Result<[u8; N], CoreError> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for c in s.bytes().take_while(|b| *b != b'=') {
        let n = alphabet
            .iter()
            .position(|b| *b == c)
            .ok_or_else(|| corrupt("encrypted header"))?;
        bits = (bits << 6) | n as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            result.push((bits >> count) as u8);
        }
    }
    let result: [u8; N] = result.try_into().map_err(|_| corrupt("encrypted header"))?;
    if crate::base64::encode(&result) != s {
        return Err(corrupt("encrypted header"));
    }
    Ok(result)
}
fn header_text<'a>(value: &'a Json, key: &str) -> Result<&'a str, CoreError> {
    text(value, key).map_err(|_| corrupt("encrypted header"))
}
fn header_uint(value: &Json, key: &str) -> Result<u64, CoreError> {
    uint(value, key).map_err(|_| corrupt("encrypted header"))
}
fn nonce(prefix: &[u8; 19], i: u32, last: bool) -> [u8; 24] {
    let mut n = [0; 24];
    n[..19].copy_from_slice(prefix);
    n[19..23].copy_from_slice(&i.to_be_bytes());
    n[23] = u8::from(last);
    n
}
pub fn is_encrypted(path: &Path) -> bool {
    let mut bytes = [0; 10];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok()
        && &bytes == MAGIC_ENC
}
fn destination(dest: &Path) -> Result<&Path, CoreError> {
    if fs::symlink_metadata(dest).is_ok() {
        return Err(CoreError::new(
            BACKUP_DEST_EXISTS,
            "备份目标已存在，请选择新的文件名",
        ));
    }
    dest.file_name().ok_or_else(invalid)?;
    Ok(dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new(".")))
}
fn publish(partial: &Path, dest: &Path) -> Result<(), CoreError> {
    match fs::hard_link(partial, dest) {
        Ok(()) => {
            if let Err(e) = fs::remove_file(partial) {
                let _ = fs::remove_file(dest);
                return Err(e.into());
            }
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(CoreError::new(
                BACKUP_DEST_EXISTS,
                "备份目标已存在，请选择新的文件名",
            ))
        }
        Err(_) => {
            if fs::symlink_metadata(dest).is_ok() {
                return Err(CoreError::new(
                    BACKUP_DEST_EXISTS,
                    "备份目标已存在，请选择新的文件名",
                ));
            }
            fs::rename(partial, dest)?;
        }
    }
    if let Err(e) = sync_dir(
        dest.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    ) {
        let _ = fs::remove_file(dest);
        return Err(e);
    }
    Ok(())
}
fn encrypt(src: &Path, dest: &Path, password: &str, params: KdfParams) -> Result<(), CoreError> {
    let parent = destination(dest)?;
    let salt = random::<16>()?;
    let prefix = random::<19>()?;
    let key = derive(password, params, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| kdf_error())?;
    let mut source = File::open(src)?;
    let bytes = source.metadata()?.len();
    let json = Json::obj(vec![
        ("format", Json::str("shiguang-backup-encrypted")),
        ("formatVersion", Json::Num(1)),
        (
            "kdf",
            Json::obj(vec![
                ("alg", Json::str("argon2id")),
                ("version", Json::Num(19)),
                ("m", Json::Num(params.m as i64)),
                ("t", Json::Num(params.t as i64)),
                ("p", Json::Num(params.p as i64)),
                ("salt", Json::str(crate::base64::encode(&salt))),
            ]),
        ),
        (
            "aead",
            Json::obj(vec![
                ("alg", Json::str("xchacha20poly1305")),
                ("noncePrefix", Json::str(crate::base64::encode(&prefix))),
                ("chunkSize", Json::Num(CHUNK as i64)),
            ]),
        ),
        ("plaintextBytes", Json::Num(bytes as i64)),
    ])
    .dump();
    let mut header = MAGIC_ENC.to_vec();
    header.extend_from_slice(&(json.len() as u32).to_le_bytes());
    header.extend_from_slice(json.as_bytes());
    let partial = parent.join(format!(".encrypted.partial-{}", id()));
    let mut out = private_file(&partial)?;
    let result = (|| {
        out.write_all(&header)?;
        let blocks = bytes.div_ceil(CHUNK as u64).max(1);
        if blocks > u32::MAX as u64 {
            return Err(corrupt("encrypted length"));
        }
        let mut buffer = Zeroizing::new(vec![0; CHUNK]);
        let mut left = bytes;
        for i in 0..blocks {
            let size = left.min(CHUNK as u64) as usize;
            source.read_exact(&mut buffer[..size])?;
            let n = nonce(&prefix, i as u32, i + 1 == blocks);
            let tag = cipher
                .encrypt_in_place_detached(XNonce::from_slice(&n), &header, &mut buffer[..size])
                .map_err(|_| corrupt("encrypt"))?;
            out.write_all(&buffer[..size])?;
            out.write_all(&tag)?;
            fault::hit(FaultPoint::EncryptChunk)?;
            left -= size as u64;
        }
        out.sync_all()?;
        Ok::<_, CoreError>(())
    })();
    drop(out);
    drop(source);
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    // This is an internal temporary destination; caller authenticates a full decrypt before publication.
    let result = publish(&partial, dest);
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}
/// Authenticate every block and the inner backup before publishing a plaintext file.
/// A pre-existing destination is always preserved. Failed decrypts leave no plaintext.
pub fn decrypt_backup(src: &Path, dest_plain: &Path, password: &str) -> Result<(), CoreError> {
    let parent = destination(dest_plain)?;
    let mut input = File::open(src)?;
    let length = input.metadata()?.len();
    let mut framing = [0; 14];
    input.read_exact(&mut framing).map_err(|_| truncated())?;
    if &framing[..10] != MAGIC_ENC {
        return Err(invalid());
    }
    let size = u32::from_le_bytes(framing[10..].try_into().map_err(|_| invalid())?) as u64;
    if size > 64 * 1024 {
        return Err(corrupt("encrypted header"));
    }
    if size + 14 > length {
        return Err(truncated());
    }
    let mut header = framing.to_vec();
    header.resize(14 + size as usize, 0);
    input
        .read_exact(&mut header[14..])
        .map_err(|_| truncated())?;
    let h = parse_document(
        std::str::from_utf8(&header[14..]).map_err(|_| corrupt("encrypted header"))?,
    )
    .map_err(|_| corrupt("encrypted header"))?;
    if header_text(&h, "format")? != "shiguang-backup-encrypted"
        || header_uint(&h, "formatVersion")? != 1
    {
        return Err(corrupt("encrypted format"));
    }
    let k = h.get("kdf").ok_or_else(|| corrupt("encrypted kdf"))?;
    let a = h.get("aead").ok_or_else(|| corrupt("encrypted aead"))?;
    if header_text(k, "alg")? != "argon2id"
        || header_uint(k, "version")? != 19
        || header_text(a, "alg")? != "xchacha20poly1305"
        || header_uint(a, "chunkSize")? != CHUNK as u64
    {
        return Err(corrupt("encrypted algorithms"));
    }
    let param = |key| -> Result<u32, CoreError> {
        u32::try_from(header_uint(k, key).map_err(|_| kdf_error())?).map_err(|_| kdf_error())
    };
    let params = KdfParams {
        m: param("m")?,
        t: param("t")?,
        p: param("p")?,
    };
    params.validate()?;
    let salt = b64::<16>(header_text(k, "salt")?)?;
    let prefix = b64::<19>(header_text(a, "noncePrefix")?)?;
    let bytes = header_uint(&h, "plaintextBytes")?;
    let blocks = bytes.div_ceil(CHUNK as u64).max(1);
    if blocks > u32::MAX as u64 {
        return Err(corrupt("encrypted length"));
    }
    let expected = 14 + size + bytes + blocks * 16;
    if expected > length {
        return Err(truncated());
    }
    if expected != length {
        return Err(corrupt("encrypted length"));
    }
    let key = derive(password, params, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| kdf_error())?;
    let partial = parent.join(format!(".decrypted.partial-{}", id()));
    let mut out = private_file(&partial)?;
    let result = (|| {
        let mut buffer = Zeroizing::new(vec![0; CHUNK]);
        let mut left = bytes;
        for i in 0..blocks {
            let size = left.min(CHUNK as u64) as usize;
            input
                .read_exact(&mut buffer[..size])
                .map_err(|_| truncated())?;
            let mut tag = [0; 16];
            input.read_exact(&mut tag).map_err(|_| truncated())?;
            let n = nonce(&prefix, i as u32, i + 1 == blocks);
            cipher
                .decrypt_in_place_detached(
                    XNonce::from_slice(&n),
                    &header,
                    &mut buffer[..size],
                    Tag::from_slice(&tag),
                )
                .map_err(|_| crypto_error(i == 0))?;
            fault::hit(FaultPoint::DecryptChunk)?;
            out.write_all(&buffer[..size])?;
            left -= size as u64;
        }
        out.sync_all()?;
        Ok::<_, CoreError>(())
    })();
    drop(out);
    drop(input);
    let result = result
        .and_then(|()| verify_backup(&partial).map(|_| ()))
        .and_then(|()| publish(&partial, dest_plain));
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}
struct TempPlain(PathBuf, bool);
impl TempPlain {
    fn new(path: PathBuf) -> Self {
        Self(path, false)
    }
    fn own(&mut self) {
        self.1 = true;
    }
}
impl Drop for TempPlain {
    fn drop(&mut self) {
        if self.1 {
            let _ = fs::remove_file(&self.0);
        }
    }
}
impl Store {
    pub fn export_backup_encrypted(
        &self,
        dest: &Path,
        app_version: &str,
        password: &str,
        params: KdfParams,
    ) -> Result<ExportReport, CoreError> {
        if password.is_empty() {
            return Err(CoreError::new(
                "BACKUP_PASSWORD_EMPTY",
                "导出加密备份需要非空口令",
            ));
        }
        params.validate()?;
        let parent = destination(dest)?;
        let canonical = fs::canonicalize(parent)?;
        let root = fs::canonicalize(self.root())?;
        let name = dest
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(invalid)?;
        if canonical == root && (name == "state.json" || name.starts_with('.'))
            || ["media", "previews", "media-quarantine"]
                .iter()
                .any(|p| canonical.starts_with(root.join(p)))
        {
            return Err(invalid());
        }
        let mut plain = TempPlain::new(self.root().join(format!(".encrypt-{}.sgbak", id())));
        let _lock = write_lock(self.root())?;
        let mut report = self.export_backup_locked(&plain.0, app_version, true)?;
        plain.own();
        let mut encrypted = TempPlain::new(parent.join(format!(".encrypted.partial-{}", id())));
        encrypt(&plain.0, &encrypted.0, password, params)?;
        encrypted.own();
        let mut check = TempPlain::new(self.root().join(format!(".decrypt-{}.sgbak", id())));
        decrypt_backup(&encrypted.0, &check.0, password)?;
        check.own();
        let (bytes, hash) = hash_file(&encrypted.0)?;
        publish(&encrypted.0, dest)?;
        report.path = dest.to_owned();
        report.bytes = bytes;
        report.sha256 = hash;
        Ok(report)
    }
    pub fn plan_merge_with_password(
        &self,
        path: &Path,
        password: &str,
    ) -> Result<crate::MergePlan, CoreError> {
        if !is_encrypted(path) {
            return self.plan_merge(path);
        }
        let mut plain = TempPlain::new(self.root().join(format!(".decrypt-{}.sgbak", id())));
        decrypt_backup(path, &plain.0, password)?;
        plain.own();
        self.plan_merge(&plain.0)
    }
    pub fn merge_backup_with_password(
        &mut self,
        path: &Path,
        password: &str,
    ) -> Result<crate::MergeReport, CoreError> {
        if !is_encrypted(path) {
            return self.merge_backup(path);
        }
        let mut plain = TempPlain::new(self.root().join(format!(".decrypt-{}.sgbak", id())));
        decrypt_backup(path, &plain.0, password)?;
        plain.own();
        self.merge_backup(&plain.0)
    }
    pub fn restore_backup_overwrite_with_password(
        &mut self,
        path: &Path,
        password: &str,
    ) -> Result<RestoreReport, CoreError> {
        if !is_encrypted(path) {
            return self.restore_backup_overwrite(path);
        }
        let mut plain = TempPlain::new(self.root().join(format!(".decrypt-{}.sgbak", id())));
        decrypt_backup(path, &plain.0, password)?;
        plain.own();
        self.restore_backup_overwrite(&plain.0)
    }
}
/// Redacted, zeroizing CLI input. Passwords are never accepted as command arguments.
pub struct BackupPassword(Zeroizing<String>);
impl std::fmt::Debug for BackupPassword {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackupPassword([REDACTED])")
    }
}
impl BackupPassword {
    pub fn read(stdin: bool) -> Result<Self, CoreError> {
        let mut secret = Zeroizing::new(String::new());
        if stdin {
            use std::io::BufRead;
            let mut input = std::io::stdin().lock().take(64 * 1024 + 1);
            input.read_line(&mut secret)?;
            if secret.len() > 64 * 1024 {
                return Err(CoreError::new("USAGE", "口令输入过长"));
            }
            if secret.ends_with('\n') {
                secret.pop();
                if secret.ends_with('\r') {
                    secret.pop();
                }
            }
        } else {
            *secret = std::env::var("SHIGUANG_BACKUP_PASSWORD").map_err(|_| {
                CoreError::new(
                    "BACKUP_PASSWORD_REQUIRED",
                    "请通过环境变量或 --password-stdin 提供口令",
                )
            })?;
        }
        Ok(Self(secret))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
/// Store-free encrypted verification; temporary plaintext is removed on every exit.
pub fn verify_backup_with_password(path: &Path, password: &str) -> Result<BackupInfo, CoreError> {
    if !is_encrypted(path) {
        return verify_backup(path);
    }
    let mut plain = TempPlain::new(std::env::temp_dir().join(format!(".decrypt-{}.sgbak", id())));
    decrypt_backup(path, &plain.0, password)?;
    plain.own();
    verify_backup(&plain.0)
}
