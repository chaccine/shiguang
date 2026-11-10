//! 仅启用 fault-injection 时保留线程局部故障计划。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultPoint {
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
    static PLAN: std::cell::Cell<Option<FaultPoint>> = const { std::cell::Cell::new(None) };
}

#[cfg(feature = "fault-injection")]
pub fn set(point: FaultPoint) {
    PLAN.with(|plan| plan.set(Some(point)));
}

#[cfg(feature = "fault-injection")]
pub fn clear() {
    PLAN.with(|plan| plan.set(None));
}

#[cfg(feature = "fault-injection")]
pub(crate) fn hit(point: FaultPoint) -> std::io::Result<()> {
    if PLAN.with(|plan| plan.get() == Some(point)) {
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
