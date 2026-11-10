//! The CLI is the caller supplying the local calendar date to the timezone-free core.
use shiguang_core::CoreError;

pub fn today() -> Result<String, CoreError> {
    if let Ok(clock) = std::env::var("SHIGUANG_CLOCK") {
        if let Some(date) = clock
            .trim()
            .get(..10)
            .filter(|d| shiguang_core::time::is_valid_date(d))
        {
            return Ok(date.to_owned());
        }
    }
    platform_today()
}
fn unavailable() -> CoreError {
    CoreError::new(
        "INVALID_EVENT_DATE",
        "无法取得本地日期，请使用 --today YYYY-MM-DD 指定今天",
    )
}

#[cfg(unix)]
fn platform_today() -> Result<String, CoreError> {
    use std::{
        ffi::{c_char, c_void},
        mem::MaybeUninit,
    };
    #[cfg(any(target_env = "musl", target_arch = "riscv32"))]
    type PosixTime = i64;
    #[cfg(not(any(target_env = "musl", target_arch = "riscv32")))]
    type PosixTime = std::ffi::c_long;
    // Native time_t: Android/Apple/glibc use long; musl 1.2 and riscv32 use i64.
    // tm is opaque here: reserve aligned storage larger than every platform tm,
    // and use strftime rather than interpreting its platform-specific trailing fields.
    #[repr(C, align(16))]
    struct TmStorage([u8; 256]);
    unsafe extern "C" {
        #[cfg_attr(
            all(target_env = "musl", target_pointer_width = "32"),
            link_name = "__time64"
        )]
        fn time(out: *mut PosixTime) -> PosixTime;
        #[cfg_attr(
            all(target_env = "musl", target_pointer_width = "32"),
            link_name = "__localtime64_r"
        )]
        fn localtime_r(seconds: *const PosixTime, out: *mut c_void) -> *mut c_void;
        fn strftime(
            out: *mut c_char,
            max: usize,
            format: *const c_char,
            tm: *const c_void,
        ) -> usize;
    }
    let mut tm = MaybeUninit::<TmStorage>::uninit();
    let mut out = [0u8; 32];
    // The platform functions synchronously initialize only tm storage and out;
    // no pointer escapes and localtime_r provides thread-local conversion storage.
    let len = unsafe {
        let seconds = time(std::ptr::null_mut());
        let ptr = localtime_r(&seconds, tm.as_mut_ptr().cast());
        if ptr.is_null() {
            return Err(unavailable());
        }
        strftime(
            out.as_mut_ptr().cast(),
            out.len(),
            c"%Y-%m-%d".as_ptr(),
            ptr,
        )
    };
    let date = std::str::from_utf8(&out[..len]).map_err(|_| unavailable())?;
    if !shiguang_core::time::is_valid_date(date) {
        return Err(unavailable());
    }
    Ok(date.into())
}
#[cfg(windows)]
fn platform_today() -> Result<String, CoreError> {
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        weekday: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLocalTime(out: *mut SystemTime);
    }
    let mut out = SystemTime::default();
    // GetLocalTime writes one SYSTEMTIME to valid, aligned stack storage.
    unsafe {
        GetLocalTime(&mut out);
    }
    let date = format!("{:04}-{:02}-{:02}", out.year, out.month, out.day);
    if !shiguang_core::time::is_valid_date(&date) {
        return Err(unavailable());
    }
    Ok(date)
}
#[cfg(not(any(unix, windows)))]
fn platform_today() -> Result<String, CoreError> {
    Err(unavailable())
}
