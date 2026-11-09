//! 拾光 Unit-0 CLI：供验收脚本驱动领域核心（仅合成数据）。
//!
//! 每次调用都是独立进程 —— 因而天然覆盖“杀进程/重启后读回”的持久化路径。

use shiguang_core::json::Json;
use shiguang_core::model::RecordRow;
use shiguang_core::{preview, CoreError, Store};
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
            let value = args.get(i + 1).ok_or_else(|| {
                CoreError::new("USAGE", "--data-dir 需要目录参数")
            })?;
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
    let mut store = Store::open(root)?;
    let rest = &args[1..];

    match command.as_str() {
        "init" => Ok(Json::obj(vec![
            ("ok", Json::Bool(true)),
            ("dataDir", Json::str(store.root().display().to_string())),
            ("seed", Json::str(store.seed())),
        ])),
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
            let (id, _) = first_positional(rest)?;
            let outcome = store.commit(&id)?;
            Ok(Json::obj(vec![
                ("ok", Json::Bool(true)),
                ("recordId", Json::str(outcome.record_id)),
                ("contentRevision", Json::Num(outcome.content_revision as i64)),
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
                ("sha256", Json::str(shiguang_core::sha256::hex_digest(&bytes))),
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
        entries.push(("formalEventTime", match &formal.event_time {
            Some(v) => Json::str(v.clone()),
            None => Json::Null,
        }));
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
        ("eventTime", match &formal.event_time {
            Some(v) => Json::str(v.clone()),
            None => Json::Null,
        }),
        ("bodySha256", Json::str(shiguang_core::sha256::hex_digest(formal.body.as_bytes()))),
        (
            "photos",
            Json::Arr(formal.photos.iter().map(|p| p.to_json()).collect()),
        ),
        ("hasPendingDraft", Json::Bool(row.draft.is_some())),
        ("previewExists", Json::Bool(formal.photos.iter().all(|p| {
            store.preview_path(&p.asset_id).exists()
        }))),
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
        "  draft-new [--title T] [--body B] [--date YYYY-MM-DD] [--time HH:MM] [--base REC]",
        "  draft-save ID [--title T] [--body B] [--date D] [--time T] [--clear-time]",
        "  attach ID --asset FILE [--caption C] [--media-type M]",
        "  commit ID                               存入时光（正式提交）",
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
        "环境: SHIGUANG_DATA_DIR, SHIGUANG_SEED(默认 20261109), SHIGUANG_CLOCK(固定时间)",
    ]
    .join("\n")
}
