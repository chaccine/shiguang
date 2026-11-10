//! 仅启用 fault-injection 时保留线程局部故障计划。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultPoint {
    TagTxnWrite,
    MergeStage,
    MergeMediaWrite,
    MergeStateWrite,
    CrashAfterMergeMedia,
    MergeAfterCommit,
    EncryptChunk,
    DecryptChunk,
    BackupWrite,
    BackupFinalize,
    RestoreStage,
    RestoreSafety,
    RestoreSwitchMedia,
    RestoreSwitchState,
    RestoreAfterCommit,
    CrashAfterMediaSwap,
    MigrationBackup,
    MigrationWrite,
    AfterMediaWrite,
    TempCreate,
    TempWrite,
    TempSync,
    Replace,
    ParentSync,
}

#[cfg(feature = "fault-injection")]
std::thread_local! {
    static PLAN: std::cell::Cell<Option<(FaultPoint, usize)>> = const { std::cell::Cell::new(None) };
}

#[cfg(feature = "fault-injection")]
pub fn set(point: FaultPoint) {
    set_after(point, 1);
}

/// Fail on the kth visit, and every subsequent visit, on this thread only.
#[cfg(feature = "fault-injection")]
pub fn set_after(point: FaultPoint, kth: usize) {
    PLAN.with(|plan| plan.set(Some((point, kth.max(1)))));
}

#[cfg(feature = "fault-injection")]
pub fn clear() {
    PLAN.with(|plan| plan.set(None));
}

#[cfg(feature = "fault-injection")]
pub(crate) fn hit(point: FaultPoint) -> std::io::Result<()> {
    if PLAN.with(|plan| match plan.get() {
        Some((target, left)) if target == point => {
            if left > 1 {
                plan.set(Some((target, left - 1)));
                false
            } else {
                true
            }
        }
        _ => false,
    }) {
        Err(std::io::Error::other("injected fault"))
    } else {
        Ok(())
    }
}

#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
pub(crate) fn hit(_point: FaultPoint) -> std::io::Result<()> {
    Ok(())
}
