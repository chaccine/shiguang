//! Unit-0.5/0.6 备份/恢复/合并命令：文件选择与平台文件读写在这里，备份格式/校验/恢复语义全部在 shiguang_core::backup。
//!
//! - 桌面：tauri-plugin-dialog 原生保存/打开对话框，返回普通路径。
//! - Android：同一插件走系统文件选择器（保存用 ACTION_CREATE_DOCUMENT，选择用 ACTION_GET_CONTENT），
//!   返回 content:// URI，经 tauri-plugin-fs 取得文件描述符后流式读写。不申请任何存储/网络权限。
//! - 所有对话框都是阻塞调用，必须放在 spawn_blocking 中，不能占用主线程。
//! - Unit-0.6 加密：口令只在 export/unlock 两个命令的参数里出现，不记录、不回显、不放进错误信息；
//!   解锁后把明文副本放在应用私有缓存（与应用自身的 state.json 同等保护级别），合并/恢复/取消后立即删除，启动时清理残留。

use crate::{command_error, report_value, AppState, CommandError};
use shiguang_core::backup::{decrypt_backup, is_encrypted, verify_backup, BackupInfo, KdfParams};
use shiguang_core::merge::{MergePlan, RecordIdentity};
use shiguang_core::model::CoreError;
use shiguang_core::sha256::{hex, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(0);
const CHUNK: usize = 64 * 1024;

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| command_error("BACKUP_IO_FAILED", format!("无法解析应用缓存目录：{e}")))?
        .join(sub);
    fs::create_dir_all(&dir).map_err(|e| command_error("BACKUP_IO_FAILED", e))?;
    Ok(dir)
}

/// 启动时清理上次残留的临时导出/导入副本（只在应用缓存目录内，不触碰数据目录与用户文件）。
pub fn clean_cache(app: &AppHandle) {
    for sub in ["backup-exports", "backup-imports"] {
        if let Ok(dir) = app.path().app_cache_dir().map(|d| d.join(sub)) {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

fn summary_value(info: &BackupInfo, encrypted: bool) -> serde_json::Value {
    let c = &info.counts;
    serde_json::json!({
        // 内层明文包是 formatVersion 1；加密时外层是 SGBAKENC v1 容器。
        "formatVersion": 1,
        "schemaVersion": info.schema_version,
        "appVersion": info.app_version,
        "exportedAt": info.exported_at,
        "bytes": info.bytes,
        "encryption": if encrypted { "argon2id-xchacha20poly1305" } else { "none" },
        "counts": {
            "formal": c.formal, "drafts": c.drafts, "trashed": c.trashed,
            "deletionMarkers": c.deletion_markers, "conflictCopies": c.conflict_copies,
            "mediaFiles": c.media_files, "missingMedia": c.missing_media,
        },
    })
}

fn stamp() -> String {
    // UTC 时间戳，仅用于默认文件名。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days（Howard Hinnant）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn copy_stream(from: &mut impl Read, to: &mut impl Write) -> std::io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        to.write_all(&buf[..n])?;
        total += n as u64;
    }
    to.flush()?;
    Ok((total, hex(&hasher.finalize())))
}

fn hash_stream(from: &mut impl Read) -> std::io::Result<(u64, String)> {
    copy_stream(from, &mut std::io::sink())
}

fn open_read(app: &AppHandle, path: &FilePath) -> std::io::Result<fs::File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    app.fs().open(path.clone(), opts)
}

fn display_name(path: &FilePath) -> String {
    match path {
        FilePath::Path(p) => p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string_lossy().into_owned()),
        // SAF URI 的最后一段通常是编码后的文档 ID，不一定是文件名；只作提示。
        FilePath::Url(u) => u
            .path_segments()
            .and_then(|mut s| s.next_back().map(str::to_string))
            .map(|s| percent_decode(&s))
            .unwrap_or_else(|| "所选文件".to_string()),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 64
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn with_store<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut shiguang_core::Store) -> Result<T, CoreError>,
) -> Result<T, CommandError> {
    let state = app.state::<AppState>();
    let mut slot = state.store.wait_lock()?;
    let store = slot.as_mut().map_err(|e| CommandError::from(e.clone()))?;
    f(store).map_err(CommandError::from)
}

fn join_err(e: impl std::fmt::Display) -> CommandError {
    command_error("BACKUP_IO_FAILED", format!("后台任务失败：{e}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn backup_capabilities() -> serde_json::Value {
    serde_json::json!({
        "platform": platform(),
        "overwriteRestore": true,
        "merge": true,
        "encryption": true,
        "antiResurrection": true,
        "fileAccess": if cfg!(target_os = "android") { "saf" } else { "dialog" },
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_backup(
    app: AppHandle,
    password: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let password = password.map(zeroize::Zeroizing::new);
    if matches!(&password, Some(p) if p.is_empty()) {
        return Err(command_error(
            "BACKUP_PASSWORD_EMPTY",
            "请设置口令，或不勾选加密",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        export_backup_blocking(&app, password.as_ref().map(|p| p.as_str()))
    })
    .await
    .map_err(join_err)?
}

fn export_backup_blocking(
    app: &AppHandle,
    password: Option<&str>,
) -> Result<serde_json::Value, CommandError> {
    // 先确认数据可用，再弹对话框。
    with_store(app, |_| Ok(()))?;
    let suffix = if password.is_some() { "-加密" } else { "" };
    let file_name = format!("拾光备份-{}{suffix}.sgbak", stamp());
    let builder = app.dialog().file().set_file_name(&file_name);
    #[cfg(target_os = "android")]
    let builder = builder.add_filter("拾光备份", &["application/octet-stream"]);
    #[cfg(not(target_os = "android"))]
    let builder = builder.add_filter("拾光备份", &["sgbak"]);
    let Some(target) = builder.blocking_save_file() else {
        return Ok(serde_json::json!({ "cancelled": true }));
    };

    // 1) core 在一致性快照下导出到应用缓存目录，并已完整校验。
    let dir = cache_dir(app, "backup-exports")?;
    let temp = dir.join(format!(
        "export-{}-{}.sgbak",
        std::process::id(),
        NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_file(&temp);
    let version = app.package_info().version.to_string();
    let report = with_store(app, |store| match password {
        Some(pw) => store.export_backup_encrypted(&temp, &version, pw, KdfParams::default()),
        None => store.export_backup(&temp, &version),
    });
    let report = match report {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
    };
    // 2) 流式复制到用户选择的位置，再读回比对整包 sha256。
    let result = deliver(app, &temp, &target, &report.sha256, password.is_some());
    let _ = fs::remove_file(&temp);
    let location = result?;
    Ok(serde_json::json!({
        "cancelled": false,
        "fileName": display_name(&target),
        "location": location,
        "sha256": report.sha256,
        "summary": summary_value(&report.manifest, password.is_some()),
        "missingMedia": report.missing_media.iter().map(|m| m.asset_id.clone()).collect::<Vec<_>>(),
    }))
}

fn deliver(
    app: &AppHandle,
    temp: &Path,
    target: &FilePath,
    expected: &str,
    encrypted: bool,
) -> Result<String, CommandError> {
    let write_err = |e: std::io::Error| command_error("BACKUP_WRITE_FAILED", e);
    let mut src = fs::File::open(temp).map_err(write_err)?;
    match target {
        FilePath::Path(dest) => {
            // 桌面：同目录临时文件 → fsync → rename，避免留下半个备份。
            let parent = dest
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let partial = parent.join(format!(
                ".{}.partial-{}",
                dest.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "backup".into()),
                std::process::id()
            ));
            let outcome = (|| -> Result<(), CommandError> {
                let mut out = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&partial)
                    .map_err(write_err)?;
                let (_, sha) = copy_stream(&mut src, &mut out).map_err(write_err)?;
                out.sync_all().map_err(write_err)?;
                drop(out);
                if sha != expected {
                    return Err(command_error(
                        "BACKUP_WRITE_FAILED",
                        "写出的备份与校验和不一致",
                    ));
                }
                fs::rename(&partial, dest).map_err(write_err)?;
                Ok(())
            })();
            if let Err(e) = outcome {
                let _ = fs::remove_file(&partial);
                return Err(e);
            }
            // 读回整包完整校验（加密包：容器已由 core 解密自检，这里比对整包 sha256 即可）。
            if encrypted {
                let mut back = fs::File::open(dest).map_err(write_err)?;
                let (_, sha) = hash_stream(&mut back).map_err(write_err)?;
                if sha != expected {
                    return Err(command_error(
                        "BACKUP_WRITE_FAILED",
                        "读回的备份与校验和不一致",
                    ));
                }
            } else {
                verify_backup(dest).map_err(CommandError::from)?;
            }
            Ok(dest.to_string_lossy().into_owned())
        }
        FilePath::Url(_) => {
            // Android SAF：用户选的文档由系统创建；以 "wt" 打开并截断写入，再重新以只读打开比对哈希。
            let mut opts = OpenOptions::new();
            opts.read(false).write(true).truncate(true);
            let mut out = app.fs().open(target.clone(), opts).map_err(write_err)?;
            copy_stream(&mut src, &mut out).map_err(write_err)?;
            out.sync_all().map_err(write_err)?;
            drop(out);
            let mut back = open_read(app, target).map_err(write_err)?;
            let (_, sha) = hash_stream(&mut back).map_err(write_err)?;
            if sha != expected {
                return Err(command_error(
                    "BACKUP_WRITE_FAILED",
                    "读回的备份与校验和不一致，请换一个保存位置重试",
                ));
            }
            Ok("系统文件选择器中你选择的位置".to_string())
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn pick_backup(app: AppHandle) -> Result<serde_json::Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || pick_backup_blocking(&app))
        .await
        .map_err(join_err)?
}

fn pick_backup_blocking(app: &AppHandle) -> Result<serde_json::Value, CommandError> {
    with_store(app, |_| Ok(()))?;
    let builder = app.dialog().file();
    #[cfg(not(target_os = "android"))]
    let builder = builder.add_filter("拾光备份", &["sgbak"]);
    let Some(source) = builder.blocking_pick_file() else {
        return Ok(serde_json::json!({ "cancelled": true }));
    };
    let token = format!(
        "imp-{}-{}",
        std::process::id(),
        NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
    );
    let dir = cache_dir(app, "backup-imports")?;
    let copy = dir.join(format!("{token}.sgbak"));
    let read_err = |e: std::io::Error| command_error("BACKUP_IO_FAILED", e);
    let outcome = (|| -> Result<Option<BackupInfo>, CommandError> {
        // 先完整复制到应用缓存（SAF URI 只能可靠地读一次），再在副本上做完整校验。
        let mut src = open_read(app, &source).map_err(read_err)?;
        let mut out = fs::File::create(&copy).map_err(read_err)?;
        copy_stream(&mut src, &mut out).map_err(read_err)?;
        out.sync_all().map_err(read_err)?;
        drop(out);
        if is_encrypted(&copy) {
            // 加密包：等用户输入口令后由 unlock_backup 解密并完整校验。
            return Ok(None);
        }
        verify_backup(&copy).map(Some).map_err(CommandError::from)
    })();
    match outcome {
        Ok(info) => Ok(serde_json::json!({
            "cancelled": false,
            "token": token,
            "fileName": display_name(&source),
            "encrypted": info.is_none(),
            "summary": info.as_ref().map(|i| summary_value(i, false)),
        })),
        Err(e) => {
            let _ = fs::remove_file(&copy);
            Err(e)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn restore_backup(
    app: AppHandle,
    token: String,
) -> Result<serde_json::Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || restore_backup_blocking(&app, &token))
        .await
        .map_err(join_err)?
}

fn restore_backup_blocking(
    app: &AppHandle,
    token: &str,
) -> Result<serde_json::Value, CommandError> {
    if !is_valid_token(token) {
        return Err(command_error("BACKUP_TOKEN_INVALID", "请重新选择备份文件"));
    }
    let copy = usable_copy(app, token)?;
    let report = with_store(app, |store| {
        let report = store.restore_backup_overwrite(&copy)?;
        Ok((report, store.last_durability().as_str()))
    });
    let (report, durability) = report?;
    remove_picked(app, token);
    refresh_media_report(app, &report.media_report);
    let c = &report.restored_counts;
    Ok(serde_json::json!({
        "restored": {
            "formal": c.formal, "drafts": c.drafts, "trashed": c.trashed,
            "deletionMarkers": c.deletion_markers, "conflictCopies": c.conflict_copies,
            "mediaFiles": c.media_files, "missingMedia": c.missing_media,
        },
        "safetyBackup": report.safety_backup_dir.to_string_lossy(),
        "mediaReport": report_value(&report.media_report),
        "durability": durability,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn discard_picked_backup(app: AppHandle, token: String) -> Result<(), CommandError> {
    if !is_valid_token(&token) {
        return Ok(());
    }
    remove_picked(&app, &token);
    Ok(())
}

fn picked_paths(app: &AppHandle, token: &str) -> Result<(PathBuf, PathBuf), CommandError> {
    if !is_valid_token(token) {
        return Err(command_error("BACKUP_TOKEN_INVALID", "请重新选择备份文件"));
    }
    let dir = cache_dir(app, "backup-imports")?;
    Ok((
        dir.join(format!("{token}.sgbak")),
        dir.join(format!("{token}.plain.sgbak")),
    ))
}

/// 返回可直接交给 core 的明文包路径：未加密包就是导入副本；加密包必须先解锁。
fn usable_copy(app: &AppHandle, token: &str) -> Result<PathBuf, CommandError> {
    let (copy, plain) = picked_paths(app, token)?;
    if plain.is_file() {
        return Ok(plain);
    }
    if !copy.is_file() {
        return Err(command_error("BACKUP_TOKEN_INVALID", "请重新选择备份文件"));
    }
    if is_encrypted(&copy) {
        return Err(command_error(
            "BACKUP_PASSWORD_REQUIRED",
            "这是加密备份，请先输入口令",
        ));
    }
    Ok(copy)
}

fn remove_picked(app: &AppHandle, token: &str) {
    if let Ok((copy, plain)) = picked_paths(app, token) {
        let _ = fs::remove_file(plain);
        let _ = fs::remove_file(copy);
    }
}

fn refresh_media_report(app: &AppHandle, report: &shiguang_core::MediaReport) {
    // 恢复/合并后刷新启动时的照片核查结果。
    let state = app.state::<AppState>();
    let guard = state.media_report.lock();
    if let Ok(mut slot) = guard {
        *slot = Ok(report.clone());
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn unlock_backup(
    app: AppHandle,
    token: String,
    password: String,
) -> Result<serde_json::Value, CommandError> {
    let password = zeroize::Zeroizing::new(password);
    tauri::async_runtime::spawn_blocking(move || unlock_backup_blocking(&app, &token, &password))
        .await
        .map_err(join_err)?
}

fn unlock_backup_blocking(
    app: &AppHandle,
    token: &str,
    password: &str,
) -> Result<serde_json::Value, CommandError> {
    let (copy, plain) = picked_paths(app, token)?;
    if !copy.is_file() {
        return Err(command_error("BACKUP_TOKEN_INVALID", "请重新选择备份文件"));
    }
    if !is_encrypted(&copy) {
        let info = verify_backup(&copy).map_err(CommandError::from)?;
        return Ok(serde_json::json!({ "summary": summary_value(&info, false) }));
    }
    let _ = fs::remove_file(&plain);
    // 错口令/篡改：core 拒绝并清掉半成品；数据目录完全不碰。
    let outcome = decrypt_backup(&copy, &plain, password)
        .and_then(|_| verify_backup(&plain))
        .map_err(CommandError::from);
    match outcome {
        Ok(info) => Ok(serde_json::json!({ "summary": summary_value(&info, true) })),
        Err(e) => {
            let _ = fs::remove_file(&plain);
            Err(e)
        }
    }
}

fn identities(list: &[RecordIdentity]) -> Vec<String> {
    list.iter().map(|i| i.record_id.clone()).collect()
}

fn plan_value(plan: &MergePlan) -> serde_json::Value {
    serde_json::json!({
        "counts": {
            "added": plan.added, "updated": plan.updated, "unchanged": plan.unchanged,
            "conflicts": plan.conflicts, "keptTrashed": plan.kept_trashed, "keptActive": plan.kept_active,
            "skippedDeleted": plan.skipped_deleted.len(), "deletedInBackup": plan.deleted_in_backup.len(),
            "markersAdded": plan.markers_added, "conflictCopiesAdded": plan.conflict_copies_added,
            "conflictCopiesDropped": plan.conflict_copies_dropped,
            "mediaAdded": plan.media_added, "mediaMissing": plan.media_missing,
            "mediaConflicts": plan.media_conflicts.len(),
        },
        "skippedDeleted": identities(&plan.skipped_deleted),
        "deletedInBackup": identities(&plan.deleted_in_backup),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn plan_merge(app: AppHandle, token: String) -> Result<serde_json::Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = usable_copy(&app, &token)?;
        let plan = with_store(&app, |store| store.plan_merge(&path))?;
        Ok(plan_value(&plan))
    })
    .await
    .map_err(join_err)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn merge_backup(
    app: AppHandle,
    token: String,
) -> Result<serde_json::Value, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = usable_copy(&app, &token)?;
        let (report, durability) = with_store(&app, |store| {
            let report = store.merge_backup(&path)?;
            Ok((report, store.last_durability().as_str()))
        })?;
        remove_picked(&app, &token);
        refresh_media_report(&app, &report.media_report);
        Ok(serde_json::json!({
            "plan": plan_value(&report.plan),
            "safetyBackup": report.safety_backup_dir.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            "mediaReport": report_value(&report.media_report),
            "durability": durability,
        }))
    })
    .await
    .map_err(join_err)?
}
