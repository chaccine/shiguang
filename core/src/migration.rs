//! Locked schema upgrade with verified preimage, rollback and commit witness.

use crate::CoreError;
use std::{fs, io, path::Path};

const PENDING: &str = ".state-migration-pending.json";
const CLEARING: &str = ".state-migration-clearing.json";
const SYNCED: &str = ".state-migration-synced.json";
const NAMES: [&str; 3] = [PENDING, CLEARING, SYNCED];

pub(crate) fn reserved(name: &str) -> bool {
    NAMES.contains(&name)
}

fn present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Called after acquiring .write.lock, including by already-open Store handles.
pub(crate) fn require_idle(root: &Path) -> Result<(), CoreError> {
    for name in NAMES {
        if present(&root.join(name))? {
            return Err(CoreError::new(
                "MIGRATION_PENDING",
                "状态迁移尚未确认，请先恢复再写入",
            ));
        }
    }
    Ok(())
}

pub(crate) mod candidate {
    use super::*;
    use crate::{
        backup::{self, hash_file, no_link},
        fault::{self, FaultPoint},
        json::Json,
        persist::{self, Durability},
        schema, sha256,
    };
    use std::{io::Write, path::PathBuf};

    fn invalid(message: impl Into<String>) -> CoreError {
        CoreError::new("MIGRATION_FAILED", message)
    }

    #[cfg(all(test, feature = "fault-injection"))]
    std::thread_local! {
        pub(super) static ON_SYNC_FAILURE: std::cell::Cell<Option<Box<dyn FnOnce()>>> =
            const { std::cell::Cell::new(None) };
    }

    fn durable(result: Durability) -> Result<(), CoreError> {
        match result {
            Durability::Durable => Ok(()),
            other => {
                #[cfg(all(test, feature = "fault-injection"))]
                if let Some(action) = ON_SYNC_FAILURE.take() {
                    action();
                }
                Err(invalid(format!("迁移需要已确认的目录同步：{other:?}")))
            }
        }
    }

    fn regular(path: &Path) -> Result<(), CoreError> {
        if !fs::symlink_metadata(path)?.is_file() {
            return Err(invalid("迁移需要普通文件"));
        }
        Ok(())
    }

    fn read_json(path: &Path) -> Result<(Json, String), CoreError> {
        regular(path)?;
        let text = fs::read_to_string(path)?;
        let value = backup::parse_document(&text).map_err(invalid)?;
        Ok((value, sha256::hex_digest(text.as_bytes())))
    }

    fn candidate_version(value: &Json) -> Result<(), CoreError> {
        if value.get("version") == Some(&Json::Num(2))
            && value.get("schemaVersion") == Some(&Json::Num(6))
        {
            Ok(())
        } else {
            Err(invalid("候选状态版本不符"))
        }
    }

    fn sync_file(path: &Path) -> io::Result<()> {
        // FlushFileBuffers on Windows requires a handle with write access.
        fs::OpenOptions::new()
            .read(true)
            .write(cfg!(windows))
            .open(path)?
            .sync_all()
    }

    fn digest(path: &Path) -> Result<String, CoreError> {
        regular(path)?;
        Ok(hash_file(path)?.1)
    }

    struct Pending {
        backup: String,
        old: String,
        new: String,
    }

    impl Pending {
        fn encode(&self, confirmed: bool) -> String {
            Json::obj(vec![
                ("backup", Json::str(&self.backup)),
                ("oldSha256", Json::str(&self.old)),
                ("newSha256", Json::str(&self.new)),
                ("confirmed", Json::Num(i64::from(confirmed))),
            ])
            .dump()
        }

        fn read(path: &Path) -> Result<(Self, bool), CoreError> {
            regular(path)?;
            if fs::metadata(path)?.len() > 1024 {
                return Err(invalid("迁移日志过大"));
            }
            let value = backup::parse_document(&fs::read_to_string(path)?).map_err(invalid)?;
            let field = |key| crate::model::req_str(&value, key).map_err(invalid);
            let record = Self {
                backup: field("backup")?,
                old: field("oldSha256")?,
                new: field("newSha256")?,
            };
            let Json::Obj(fields) = &value else {
                return Err(invalid("迁移日志格式无效"));
            };
            let confirmed = match (fields.len(), value.get("confirmed")) {
                (4, Some(Json::Num(0))) => false,
                (4, Some(Json::Num(1))) if path.ends_with(SYNCED) => true,
                // Older pending/clearing records also require rollback. An old
                // synced record cannot distinguish the two histories. Keep it fenced.
                (3, None) if !path.ends_with(SYNCED) => false,
                _ => return Err(invalid("迁移日志的确认标记或位置无效")),
            };
            if !backup::digest_valid(&record.old)
                || !backup::digest_valid(&record.new)
                || record.old == record.new
                || !(1..=5).any(|v| record.backup == backup_name(v, &record.old))
            {
                return Err(invalid("迁移日志字段、摘要或备份名称无效"));
            }
            Ok((record, confirmed))
        }

        fn preimage(&self, root: &Path) -> Result<PathBuf, CoreError> {
            let backups = root.join("backups");
            no_link(&backups)?;
            let path = backups.join(&self.backup);
            let (value, hash) = read_json(&path)?;
            let from = schema::version(&value)?;
            if from > 5 || hash != self.old || self.backup != backup_name(from, &hash) {
                return Err(invalid("迁移备份摘要或版本不符"));
            }
            crate::State::from_json(&schema::migrate(value)?)?;
            Ok(path)
        }
    }

    fn backup_name(schema: i64, old: &str) -> String {
        format!("state.schema-v{schema}.{old}.json")
    }

    fn finish(root: &Path, record: &Pending) -> Result<(), CoreError> {
        let clearing = root.join(CLEARING);
        fs::rename(root.join(PENDING), &clearing)?;
        durable(persist::parent_sync(root))?;
        let synced = root.join(SYNCED);
        fs::rename(&clearing, &synced)?;
        if let Err(error) = durable(persist::parent_sync(root)) {
            // Either surviving name still holds confirmed=0.
            fs::rename(synced, clearing)?;
            return Err(error);
        }
        // Only the installing owner can publish the witness, after the synced
        // name and candidate are durable. The two encodings differ by one digit.
        // Updating the existing inode keeps the already-synced directory entry.
        {
            let mut receipt = fs::OpenOptions::new().write(true).open(&synced)?;
            fault::hit(FaultPoint::MigrationWitnessWrite)?;
            receipt.write_all(record.encode(true).as_bytes())?;
            fault::hit(FaultPoint::MigrationWitnessSync)?;
            receipt.sync_all()?;
        }
        fault::hit(FaultPoint::MigrationAfterCommit)?;
        fs::remove_file(synced)?;
        Ok(())
    }

    // Never choose between contradictory intents, or follow a path from one.
    pub(crate) fn location(root: &Path) -> Result<Option<&'static str>, CoreError> {
        let mut found = None;
        for name in NAMES {
            if present(&root.join(name))? {
                if found.is_some() {
                    return Err(invalid("迁移日志位置不唯一"));
                }
                found = Some(name);
            }
        }
        Ok(found)
    }

    #[cfg(test)]
    pub(super) fn recover(root: &Path) -> Result<(), CoreError> {
        no_link(root)?;
        let _owner = crate::store::instance_lock(root)?;
        let _writer = crate::store::acquire_write_lock(root)?;
        recover_locked(root)
    }

    pub(crate) fn recover_locked(root: &Path) -> Result<(), CoreError> {
        let Some(location) = location(root)? else {
            return Ok(());
        };
        if backup::import_pending(root)? {
            return Err(invalid("迁移与导入日志同时存在"));
        }
        let path = root.join(location);
        let (record, confirmed) = Pending::read(&path)?;
        let backup = record.preimage(root)?;
        let state = root.join("state.json");
        let (value, current) = read_json(&state)?;
        if current == record.new {
            candidate_version(&value)?;
        }
        if current != record.old && current != record.new {
            return Err(invalid("恢复时状态摘要不符"));
        }
        if confirmed {
            if current != record.new {
                return Err(invalid("已确认的迁移收据与活动状态不符"));
            }
            // The witness proves the installer's sync. Flush the observed
            // witness itself before unlink, in case its writer died mid-flush.
            sync_file(&path)?;
        } else {
            if current == record.new {
                durable(persist::write_atomic_restore(&state, &backup)?)?;
            }
            if digest(&state)? != record.old {
                return Err(invalid("迁移回滚校验失败"));
            }
            sync_file(&state)?;
        }
        durable(persist::parent_sync(root))?;
        fs::remove_file(path)?;
        Ok(())
    }

    /// Build from the exact locked preimage. The caller validates the decoded
    /// on-disk representation against that source before anything can install it.
    #[cfg(test)]
    pub(super) fn install(
        root: &Path,
        build: impl FnOnce(&Json) -> Result<Json, CoreError>,
        validate: impl FnOnce(&Json, &Json) -> Result<(), CoreError>,
    ) -> Result<(), CoreError> {
        no_link(root)?;
        let _owner = crate::store::instance_lock(root)?;
        let _writer = crate::store::acquire_write_lock(root)?;
        install_locked(root, build, validate)
    }

    pub(crate) fn install_locked(
        root: &Path,
        build: impl FnOnce(&Json) -> Result<Json, CoreError>,
        validate: impl FnOnce(&Json, &Json) -> Result<(), CoreError>,
    ) -> Result<(), CoreError> {
        no_link(root)?;
        require_idle(root)?;
        let state = root.join("state.json");
        // Preflight before import recovery, which can itself switch state.
        let (mut source, mut old) = read_json(&state)?;
        let mut from = schema::version(&source)?;
        if backup::import_pending(root)? {
            backup::recover(root)?;
            backup::recover_merge(root)?;
            (source, old) = read_json(&state)?;
            from = schema::version(&source)?;
        }
        if from >= schema::CURRENT_SCHEMA_VERSION {
            return Err(invalid("迁移源必须是旧版本"));
        }
        fault::hit(FaultPoint::MigrationBackup).map_err(|e| {
            CoreError::with_stage("MIGRATION_BACKUP_FAILED", "migration_backup", e.to_string())
        })?;
        let name = backup_name(from, &old);
        let backups = root.join("backups");
        no_link(&backups)?;
        fs::create_dir_all(&backups)?;
        let dest = backups.join(&name);
        if !present(&dest)? {
            backup::copy_checked(&state, &dest)?;
        }
        fault::hit(FaultPoint::MigrationBackupVerify)?;
        if digest(&dest)? != old {
            return Err(invalid("迁移备份摘要不符"));
        }
        // Also sync a verified copy left by an interrupted previous attempt.
        sync_file(&dest)?;
        durable(persist::parent_sync(&backups))?;
        durable(persist::parent_sync(root))?;

        let candidate = build(&source)?;
        let bytes = candidate.pretty();
        let decoded = backup::parse_document(&bytes).map_err(invalid)?;
        candidate_version(&decoded)?;
        if decoded != candidate {
            return Err(invalid("候选状态编码往返不一致"));
        }
        validate(&source, &decoded)?;
        let record = Pending {
            backup: name,
            old,
            new: sha256::hex_digest(bytes.as_bytes()),
        };
        record.preimage(root)?;
        if digest(&state)? != record.old {
            return Err(invalid("迁移前状态摘要已改变"));
        }
        durable(persist::write_atomic(
            &root.join(PENDING),
            record.encode(false).as_bytes(),
        )?)?;
        fault::hit(FaultPoint::MigrationWrite).map_err(|e| {
            CoreError::with_stage("MIGRATION_FAILED", "migration_write", e.to_string())
        })?;
        durable(persist::write_atomic(&state, bytes.as_bytes())?)?;
        fault::hit(FaultPoint::MigrationAfterInstall)?;
        if digest(&state)? != record.new {
            return Err(invalid("迁移后状态摘要不符"));
        }
        finish(root, &record)
    }
}

#[cfg(test)]
mod tests;
