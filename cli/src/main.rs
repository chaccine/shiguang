//! 拾光 Unit-0 CLI：供验收脚本驱动领域核心（仅合成数据）。
//!
//! 每次调用都是独立进程 —— 因而天然覆盖“杀进程/重启后读回”的持久化路径。

use shiguang_core::json::Json;
use shiguang_core::model::RecordRow;
use shiguang_core::{preview, ConflictChoice, CoreError, Store};
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::process::ExitCode;
use std::thread::sleep;
use std::time::Duration;

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{}", value.pretty());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{}", err.to_json().pretty());
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<Json, CoreError> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut data_dir = std::env::var("SHIGUANG_DATA_DIR").ok().map(PathBuf::from);
    let mut cleaned = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--data-dir" {
            let value = args
                .get(i + 1)
                .ok_or_else(|| CoreError::new("USAGE", "--data-dir 需要目录参数"))?;
            data_dir = Some(PathBuf::from(value));
            i += 2;
        } else {
            cleaned.push(args[i].clone());
            i += 1;
        }
    }
    args = cleaned;

    let command = args
        .first()
        .cloned()
        .ok_or_else(|| CoreError::new("USAGE", usage()))?;
    if command == "--help" || command == "help" {
        println!("{}", usage());
        return Ok(Json::obj(vec![("ok", Json::Bool(true))]));
    }

    let root = data_dir.unwrap_or_else(|| PathBuf::from(".shiguang-data"));
    let rest = &args[1..];
    if [
        "export-backup",
        "verify-backup",
        "restore-backup",
        "plan-merge",
        "merge-backup",
    ]
    .contains(&command.as_str())
    {
        return backup_command(&root, &command, rest);
    }
    // Test driver: announce readiness only after the requested lock is held.
    if command == "hold-lock" {
        let ms = rest
            .first()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(|| CoreError::new("USAGE", "hold-lock <ms> [--kind instance|write]"))?;
        let opts = Options::parse(&rest[1..])?;
        let kind = opts.get("kind").unwrap_or("instance");
        if kind == "write" {
            std::fs::create_dir_all(&root)?;
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(root.join(".write.lock"))?;
            lock.lock()?;
            println!("{}", Json::obj(vec![("ready", Json::Bool(true))]).dump());
            std::io::stdout().flush()?;
            sleep(Duration::from_millis(ms));
            drop(lock);
        } else if kind == "instance" {
            let held = Store::open_exclusive(&root)?;
            println!("{}", Json::obj(vec![("ready", Json::Bool(true))]).dump());
            std::io::stdout().flush()?;
            sleep(Duration::from_millis(ms));
            drop(held);
        } else {
            return Err(CoreError::new("USAGE", "kind must be instance or write"));
        }
        return Ok(Json::obj(vec![("ok", Json::Bool(true))]));
    }
    if command == "create-draft" {
        let opts = Options::parse(rest)?;
        if let Some(gate) = opts.get("start-file") {
            let start = std::time::Instant::now();
            while !std::path::Path::new(gate).exists() {
                if start.elapsed() > Duration::from_secs(5) {
                    return Err(CoreError::new("TEST_TIMEOUT", "start-file"));
                }
                sleep(Duration::from_millis(5));
            }
        }
    }
    let mut store = if command == "reconcile" {
        Store::open_exclusive(root)?
    } else {
        Store::open(root)?
    };

    match command.as_str() {
        "init" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("dataDir", Json::str(store.root().display().to_string())),
            ("seed", Json::str(store.seed())),
        ])),
        "create-draft" => {
            // 长生命周期并发测试驱动：每次 create_draft 都使用独立写事务。
            let opts = Options::parse(rest)?;
            let count = opts
                .get("count")
                .unwrap_or("1")
                .parse::<usize>()
                .map_err(|_| CoreError::new("USAGE", "--count must be an integer"))?;
            for _ in 0..count {
                store.create_draft(
                    None,
                    opts.get("title").unwrap_or("合成标题"),
                    opts.get("body").unwrap_or("合成正文"),
                    opts.get("date").unwrap_or("2026-11-09"),
                    None,
                )?;
            }
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("created", Json::Num(count as i64)),
            ]))
        }
        "trash" | "restore" => {
            let (id, _) = first_positional(rest)?;
            let row = if command == "trash" {
                store.trash_record(&id)?
            } else {
                store.restore_record(&id)?
            };
            Ok(ok_record(&row, Some(store.last_durability().as_str())))
        }
        "purge" | "empty-trash" => {
            let outcome = if command == "purge" {
                let (id, _) = first_positional(rest)?;
                store.purge_record(&id)?
            } else {
                store.empty_trash()?
            };
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("outcome", outcome.to_json()),
            ]))
        }
        "list-trash" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            (
                "records",
                Json::Arr(
                    store
                        .list_trash()?
                        .into_iter()
                        .map(RecordRow::to_json)
                        .collect(),
                ),
            ),
        ])),
        "reconcile" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("report", store.reconcile_media()?.to_json()),
        ])),
        "resolve-conflict" => {
            let (id, opts) = first_positional(rest)?;
            let choice = match opts.get("choice") {
                Some("keepMine") => ConflictChoice::KeepMine,
                Some("keepFormal") => ConflictChoice::KeepFormal,
                _ => {
                    return Err(CoreError::new(
                        "USAGE",
                        "--choice 需要 keepMine 或 keepFormal",
                    ))
                }
            };
            let row = store.resolve_conflict(&id, choice)?;
            Ok(ok_record(&row, Some(store.last_durability().as_str())))
        }
        "list-conflicts" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            (
                "conflictCopies",
                Json::Arr(
                    store
                        .list_conflict_copies()?
                        .iter()
                        .map(|c| c.to_json())
                        .collect(),
                ),
            ),
        ])),
        "restore-conflict-copy" => {
            let (id, _) = first_positional(rest)?;
            let row = store.restore_conflict_copy(&id)?;
            Ok(ok_record(&row, Some(store.last_durability().as_str())))
        }
        "draft-new" => {
            let opts = Options::parse(rest)?;
            let base = opts.get("base");
            let row = store.create_draft(
                base,
                opts.get("title").unwrap_or(""),
                opts.get("body").unwrap_or(""),
                opts.get("date").unwrap_or(""),
                opts.get("time"),
            )?;
            Ok(ok_record(&row, Some(store.last_durability().as_str())))
        }
        "draft-save" => {
            let (id, opts) = first_positional(rest)?;
            let time_patch = if opts.has("clear-time") {
                Some(None)
            } else {
                opts.get("time").map(Some)
            };
            let row = store.save_draft(
                &id,
                opts.get("title"),
                opts.get("body"),
                opts.get("date"),
                time_patch,
            )?;
            if let Some(ms) = opts.get("hold-ms").and_then(|v| v.parse::<u64>().ok()) {
                // 已落盘后保持进程存活，供验收脚本做 kill -9 演练。
                println!(
                    "{}",
                    ok_record(&row, Some(store.last_durability().as_str())).pretty()
                );
                let _ = std::io::stdout().flush();
                sleep(Duration::from_millis(ms));
            }
            Ok(ok_record(&row, Some(store.last_durability().as_str())))
        }
        "attach" => {
            let (id, opts) = first_positional(rest)?;
            let asset = opts
                .get("asset")
                .ok_or_else(|| CoreError::new("USAGE", "attach 需要 --asset <路径>"))?;
            let photo = store.attach_photo(
                &id,
                std::path::Path::new(asset),
                opts.get("caption").unwrap_or(""),
                opts.get("media-type"),
            )?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("photo", photo.to_json()),
                ("durability", Json::str(store.last_durability().as_str())),
            ]))
        }
        "commit" => {
            let (id, opts) = first_positional(rest)?;
            let expected_base_revision = match opts.get("expect-base") {
                Some(value) => value
                    .parse::<u32>()
                    .map_err(|_| CoreError::new("USAGE", "--expect-base 需要 u32 版本号"))?,
                None if opts.has("expect-base") => {
                    return Err(CoreError::new("USAGE", "--expect-base 需要 u32 版本号"));
                }
                None => store.row(&id)?.base_revision,
            };
            let outcome = store.commit(&id, expected_base_revision)?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("recordId", Json::str(outcome.record_id)),
                (
                    "contentRevision",
                    Json::Num(outcome.content_revision as i64),
                ),
                ("committedAt", Json::str(outcome.committed_at)),
                ("durability", Json::str(outcome.durability.as_str())),
            ]))
        }
        "list" => {
            let records = store
                .list_formal()
                .into_iter()
                .map(|row| formal_view(&store, row))
                .collect();
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("count", Json::Num(store.list_formal().len() as i64)),
                ("records", Json::Arr(records)),
            ]))
        }
        "get" => {
            let (id, _) = first_positional(rest)?;
            let row = store.row(&id)?.clone();
            Ok(ok_record(&row, None))
        }
        "dump" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("state", store.state_json()),
        ])),
        "assets" => {
            let assets = store
                .assets_on_disk()?
                .into_iter()
                .map(|a| {
                    Json::obj(vec![
                        ("assetId", Json::str(a.asset_id)),
                        ("file", Json::str(a.file)),
                        ("sha256", Json::str(a.sha256)),
                        ("bytes", Json::Num(a.bytes as i64)),
                    ])
                })
                .collect();
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("assets", Json::Arr(assets)),
            ]))
        }
        "ensure-previews" => {
            let created = store.ensure_previews()?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                (
                    "created",
                    Json::Arr(created.into_iter().map(Json::str).collect()),
                ),
            ]))
        }
        "clear-previews" => {
            let removed = store.clear_previews()?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                (
                    "removed",
                    Json::Arr(removed.into_iter().map(Json::str).collect()),
                ),
            ]))
        }
        "manifest" => {
            let opts = Options::parse(rest)?;
            let out = opts
                .get("out")
                .ok_or_else(|| CoreError::new("USAGE", "manifest 需要 --out <路径>"))?;
            let mut versions = Vec::new();
            for key in ["rustc", "node", "npm", "tauri", "desktop", "android"] {
                if let Some(value) = opts.get(key) {
                    versions.push((key.to_string(), value.to_string()));
                }
            }
            let manifest = store.manifest_json(&versions)?;
            std::fs::write(out, manifest.pretty())?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("out", Json::str(out)),
                ("records", Json::Num(store.list_formal().len() as i64)),
            ]))
        }
        "fixture" => {
            let opts = Options::parse(rest)?;
            let out = opts
                .get("out")
                .ok_or_else(|| CoreError::new("USAGE", "fixture 需要 --out <路径>"))?;
            let seed = opts.get("seed").unwrap_or("synthetic");
            let bytes = preview::preview_bytes(seed);
            if let Some(parent) = std::path::Path::new(out).parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(out, &bytes)?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("out", Json::str(out)),
                (
                    "sha256",
                    Json::str(shiguang_core::sha256::hex_digest(&bytes)),
                ),
                ("bytes", Json::Num(bytes.len() as i64)),
            ]))
        }
        "sleep" => {
            let opts = Options::parse(rest)?;
            let ms: u64 = opts
                .get("ms")
                .and_then(|v| v.parse().ok())
                .unwrap_or(60_000);
            sleep(Duration::from_millis(ms));
            Ok(Json::obj(vec![("ok", Json::Bool(true))]))
        }
        other => Err(CoreError::new(
            "USAGE",
            format!("未知命令：{other}\n{}", usage()),
        )),
    }
}

fn ok_record(row: &RecordRow, durability: Option<&str>) -> Json {
    let mut entries = vec![
        ("ok", Json::Bool(true)),
        ("record", row.to_json()),
        (
            "draftContentHash",
            match &row.draft {
                Some(d) => Json::str(d.content_hash()),
                None => Json::Null,
            },
        ),
        (
            "formalContentHash",
            match &row.formal {
                Some(f) => Json::str(f.content_hash()),
                None => Json::Null,
            },
        ),
    ];
    if let Some(formal) = &row.formal {
        entries.push(("formalEventDate", Json::str(formal.event_date.clone())));
        entries.push((
            "formalEventTime",
            match &formal.event_time {
                Some(v) => Json::str(v.clone()),
                None => Json::Null,
            },
        ));
    }
    if let Some(durability) = durability {
        entries.push(("durability", Json::str(durability)));
    }
    Json::obj(entries)
}

fn formal_view(store: &Store, row: &RecordRow) -> Json {
    let formal = row.formal.as_ref().expect("formal row");
    Json::obj(vec![
        ("recordId", Json::str(row.record_id.clone())),
        ("contentRevision", Json::Num(row.content_revision as i64)),
        ("title", Json::str(formal.title.clone())),
        ("body", Json::str(formal.body.clone())),
        ("eventDate", Json::str(formal.event_date.clone())),
        (
            "eventTime",
            match &formal.event_time {
                Some(v) => Json::str(v.clone()),
                None => Json::Null,
            },
        ),
        (
            "bodySha256",
            Json::str(shiguang_core::sha256::hex_digest(formal.body.as_bytes())),
        ),
        (
            "photos",
            Json::Arr(formal.photos.iter().map(|p| p.to_json()).collect()),
        ),
        ("hasPendingDraft", Json::Bool(row.draft.is_some())),
        (
            "previewExists",
            Json::Bool(
                formal
                    .photos
                    .iter()
                    .all(|p| store.preview_path(&p.asset_id).exists()),
            ),
        ),
    ])
}

fn first_positional(args: &[String]) -> Result<(String, Options), CoreError> {
    let mut id = None;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg.starts_with("--") {
            rest.push(arg.clone());
            if let Some(next) = args.get(index + 1) {
                if !next.starts_with("--") {
                    rest.push(next.clone());
                    index += 1;
                }
            }
        } else if id.is_none() {
            id = Some(arg.clone());
        } else {
            rest.push(arg.clone());
        }
        index += 1;
    }
    let opts = Options::parse(&rest)?;
    let id = id.ok_or_else(|| CoreError::new("USAGE", "缺少记录 ID"))?;
    Ok((id, opts))
}

struct Options {
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, CoreError> {
        let mut values = Vec::new();
        let mut flags = Vec::new();
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            if let Some(key) = arg.strip_prefix("--") {
                if let Some(next) = args.get(index + 1).filter(|v| !v.starts_with("--")) {
                    values.push((key.to_string(), next.clone()));
                    index += 2;
                } else {
                    flags.push(key.to_string());
                    index += 1;
                }
            } else {
                index += 1;
            }
        }
        Ok(Options { values, flags })
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn has(&self, key: &str) -> bool {
        self.flags.iter().any(|f| f == key)
    }
}

fn usage() -> String {
    [
        "用法: shiguang [--data-dir DIR] <命令> [参数]",
        "",
        "命令:",
        "  init                                    初始化数据目录",
        "  export-backup <dest> [--encrypt] [--kdf-fast] [--password-stdin] / verify-backup <file> [--password-stdin] / restore-backup <file> --yes [--password-stdin]",
        "  plan-merge <file> [--password-stdin] / merge-backup <file> --yes [--password-stdin]",
        "  trash ID / restore ID / purge ID / empty-trash / list-trash",
        "  reconcile / resolve-conflict ID --choice keepMine|keepFormal / list-conflicts",
        "  restore-conflict-copy ID",
        "  hold-lock <ms> [--kind instance|write]   持锁测试驱动（stdout ready 后才持锁成功）",
        "  create-draft [--count N] [--start-file FILE]  并发测试驱动",
        "  draft-new [--title T] [--body B] [--date YYYY-MM-DD] [--time HH:MM] [--base REC]",
        "  draft-save ID [--title T] [--body B] [--date D] [--time T] [--clear-time]",
        "  attach ID --asset FILE [--caption C] [--media-type M]",
        "  commit ID [--expect-base N]             存入时光（默认使用草稿基线版本）",
        "  list                                    正式列表（不含草稿）",
        "  get ID                                  读取记录（含草稿）",
        "  dump                                    原始状态",
        "  assets                                  原图清单（SHA-256）",
        "  ensure-previews / clear-previews        重建 / 删除派生预览",
        "  manifest --out FILE [--rustc V] [--node V] [--tauri STATUS]",
        "  fixture --out FILE [--seed S]           生成合成 PNG 测试图",
        "  sleep --ms N                            用于强杀演练",
        "  draft-save ... --hold-ms N              落盘后保持进程（强杀演练）",
        "",
        "环境: SHIGUANG_DATA_DIR, SHIGUANG_SEED(默认 20261109), SHIGUANG_CLOCK(固定时间), SHIGUANG_BACKUP_PASSWORD(备份口令)",
    ]
    .join("\n")
}

fn backup_command(
    root: &std::path::Path,
    command: &str,
    args: &[String],
) -> Result<Json, CoreError> {
    use shiguang_core::backup::{self, BackupPassword, KdfParams};
    let file = args
        .first()
        .filter(|s| !s.starts_with("--"))
        .ok_or_else(|| CoreError::new("USAGE", "备份命令需要文件路径"))?;
    let mut encrypt = false;
    let mut stdin = false;
    let mut yes = false;
    let mut fast = false;
    for flag in &args[1..] {
        match flag.as_str() {
            "--encrypt" if command == "export-backup" => encrypt = true,
            "--kdf-fast" if command == "export-backup" => fast = true,
            "--password-stdin" => stdin = true,
            "--yes" if command == "merge-backup" || command == "restore-backup" => yes = true,
            _ => {
                return Err(CoreError::new(
                    "USAGE",
                    "备份命令参数无效；口令仅支持环境变量或 --password-stdin",
                ))
            }
        }
    }
    if (command == "restore-backup" || command == "merge-backup") && !yes {
        return Err(CoreError::new("USAGE", "请显式使用 --yes 确认恢复或合并"));
    }
    if fast && !encrypt {
        return Err(CoreError::new("USAGE", "--kdf-fast 需要 --encrypt"));
    }
    let path = std::path::Path::new(file);
    let password = if encrypt || (command != "export-backup" && backup::is_encrypted(path)) {
        Some(BackupPassword::read(stdin)?)
    } else {
        None
    };
    if command == "verify-backup" {
        return Ok(match password {
            Some(ref p) => backup::verify_backup_with_password(path, p.as_str())?,
            None => backup::verify_backup(path)?,
        }
        .to_json());
    }
    let mut store = if command == "export-backup" {
        Store::open(root)?
    } else {
        Store::open_exclusive(root)?
    };
    let secret = password.as_ref().map(BackupPassword::as_str);
    match command {
        "export-backup" => Ok(if let Some(p) = secret {
            store.export_backup_encrypted(
                path,
                env!("CARGO_PKG_VERSION"),
                p,
                if fast {
                    KdfParams::fast()
                } else {
                    KdfParams::default()
                },
            )?
        } else {
            store.export_backup(path, env!("CARGO_PKG_VERSION"))?
        }
        .to_json()),
        "plan-merge" => Ok(if let Some(p) = secret {
            store.plan_merge_with_password(path, p)?
        } else {
            store.plan_merge(path)?
        }
        .to_json()),
        "merge-backup" => Ok(if let Some(p) = secret {
            store.merge_backup_with_password(path, p)?
        } else {
            store.merge_backup(path)?
        }
        .to_json()),
        "restore-backup" => Ok(if let Some(p) = secret {
            store.restore_backup_overwrite_with_password(path, p)?
        } else {
            store.restore_backup_overwrite(path)?
        }
        .to_json()),
        _ => unreachable!(),
    }
}
