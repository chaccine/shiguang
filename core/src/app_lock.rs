//! Optional UI gate only. No disk encryption, recovery code or secret diagnostics.
use crate::{
    json::Json, persist::Durability, settings::AppLock, store::write_lock, CoreError, Settings,
    Store, ThemePreference,
};
use argon2::{Algorithm, Argon2, Params, Version};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppLockStatus {
    pub enabled: bool,
    pub failed_attempts: u32,
    pub retry_after_ms: u64,
}
impl AppLockStatus {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("enabled", Json::Bool(self.enabled)),
            ("failedAttempts", Json::Num(self.failed_attempts as i64)),
            ("retryAfterMs", Json::Num(self.retry_after_ms as i64)),
        ])
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppSettings {
    pub theme: ThemePreference,
    pub app_lock: AppLockStatus,
}
impl AppSettings {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("theme", Json::str(self.theme.as_str())),
            ("appLock", self.app_lock.to_json()),
        ])
    }
}
#[derive(Clone, Debug)]
pub struct SettingsOutcome {
    pub settings: AppSettings,
    pub durability: Durability,
}
impl SettingsOutcome {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("settings", self.settings.to_json()),
            ("durability", Json::str(self.durability.as_str())),
        ])
    }
}
fn clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis().min(i64::MAX as u128) as u64)
        .unwrap_or(0)
}
fn view(settings: &Settings, now: u64) -> AppSettings {
    let lock = settings.app_lock.as_ref();
    AppSettings {
        theme: settings.theme,
        app_lock: AppLockStatus {
            enabled: lock.is_some(),
            failed_attempts: lock.map(|l| l.failures).unwrap_or(0),
            retry_after_ms: lock
                .map(|l| l.blocked_until_ms.saturating_sub(now))
                .unwrap_or(0),
        },
    }
}
fn valid_passcode(value: &str) -> bool {
    (4..=8).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
}
fn invalid() -> CoreError {
    CoreError::new("APP_LOCK_CODE_INVALID", "应用锁密码须为 4–8 位数字")
}
fn crypto_error() -> CoreError {
    CoreError::new("APP_LOCK_CRYPTO_FAILED", "应用锁操作未完成，请重试")
}
fn derive(passcode: &str, lock: &AppLock) -> Result<Zeroizing<[u8; 32]>, CoreError> {
    let secret = Zeroizing::new(passcode.as_bytes().to_vec());
    let mut out = Zeroizing::new([0; 32]);
    let params = Params::new(lock.m, lock.t, lock.p, Some(32)).map_err(|_| crypto_error())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(&secret, &lock.salt, out.as_mut())
        .map_err(|_| crypto_error())?;
    Ok(out)
}
fn new_lock(passcode: &str) -> Result<AppLock, CoreError> {
    if !valid_passcode(passcode) {
        return Err(invalid());
    }
    let mut lock = AppLock {
        salt: [0; 16],
        hash: [0; 32],
        m: 65536,
        t: 3,
        p: 1,
        failures: 0,
        blocked_until_ms: 0,
    };
    getrandom::getrandom(&mut lock.salt).map_err(|_| crypto_error())?;
    lock.hash = *derive(passcode, &lock)?;
    Ok(lock)
}
fn matches(passcode: &str, lock: &AppLock) -> Result<bool, CoreError> {
    if !valid_passcode(passcode) {
        return Ok(false);
    }
    // Fixed-length result comparison from RustCrypto subtle; no early-byte exit.
    Ok(bool::from(
        derive(passcode, lock)?
            .as_slice()
            .ct_eq(lock.hash.as_slice()),
    ))
}
fn delay_ms(failures: u32) -> u64 {
    if failures < 3 {
        0
    } else {
        (1000u64 << failures.saturating_sub(3).min(12)).min(3_600_000)
    }
}

// Deliberately no Debug/Display: never format submitted secrets.
enum Action<'a> {
    Set(&'a str),
    Verify(&'a str),
    Change(&'a str, &'a str),
    Disable(&'a str),
}
impl Store {
    /// Safe IPC view: contains status and preferences, never a salt or verifier.
    pub fn settings(&self) -> Result<AppSettings, CoreError> {
        Ok(view(&self.candidate_state()?.settings, clock_ms()))
    }
    pub fn set_theme(&mut self, theme: ThemePreference) -> Result<SettingsOutcome, CoreError> {
        let (_, durability) = self.transact(|state| {
            state.settings.theme = theme;
            Ok(())
        })?;
        Ok(SettingsOutcome {
            settings: view(&self.state.settings, clock_ms()),
            durability,
        })
    }
    pub fn set_app_lock(&mut self, passcode: &str) -> Result<SettingsOutcome, CoreError> {
        self.lock_action(Action::Set(passcode), clock_ms())
    }
    pub fn verify_app_lock(&mut self, passcode: &str) -> Result<SettingsOutcome, CoreError> {
        self.lock_action(Action::Verify(passcode), clock_ms())
    }
    pub fn change_app_lock(
        &mut self,
        current: &str,
        new: &str,
    ) -> Result<SettingsOutcome, CoreError> {
        self.lock_action(Action::Change(current, new), clock_ms())
    }
    pub fn disable_app_lock(&mut self, current: &str) -> Result<SettingsOutcome, CoreError> {
        self.lock_action(Action::Disable(current), clock_ms())
    }

    // The clock is private; production callers cannot choose a time or bypass backoff.
    fn lock_action(&mut self, action: Action<'_>, now: u64) -> Result<SettingsOutcome, CoreError> {
        let _guard = write_lock(self.root())?;
        let mut candidate = self.candidate_state()?;
        if let Action::Set(passcode) = action {
            if candidate.settings.app_lock.is_some() {
                return Err(CoreError::new(
                    "APP_LOCK_ALREADY_SET",
                    "应用锁已启用，更改密码需要当前密码",
                ));
            }
            candidate.settings.app_lock = Some(new_lock(passcode)?);
        } else {
            let lock = candidate
                .settings
                .app_lock
                .as_mut()
                .ok_or_else(|| CoreError::new("APP_LOCK_NOT_SET", "应用锁尚未启用"))?;
            if now < lock.blocked_until_ms {
                return Err(CoreError::new(
                    "APP_LOCK_THROTTLED",
                    "尝试次数过多，请等待后再试",
                ));
            }
            let current = match action {
                Action::Verify(v) | Action::Disable(v) | Action::Change(v, _) => v,
                Action::Set(_) => unreachable!(),
            };
            if !matches(current, lock)? {
                lock.failures = lock.failures.saturating_add(1);
                let delay = delay_ms(lock.failures);
                lock.blocked_until_ms = if delay == 0 {
                    0
                } else {
                    now.saturating_add(delay).min(i64::MAX as u64)
                };
                // Wrong-code outcome is returned only AFTER its counter is persisted.
                self.apply_candidate(candidate)?;
                return Err(CoreError::new("APP_LOCK_WRONG", "应用锁密码不正确"));
            }
            match action {
                Action::Verify(_) => {
                    lock.failures = 0;
                    lock.blocked_until_ms = 0;
                }
                Action::Change(_, new) => {
                    candidate.settings.app_lock = Some(new_lock(new)?);
                }
                Action::Disable(_) => {
                    candidate.settings.app_lock = None;
                }
                Action::Set(_) => unreachable!(),
            }
        }
        let settings = view(&candidate.settings, now);
        let durability = self.apply_candidate(candidate)?;
        Ok(SettingsOutcome {
            settings,
            durability,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "sg-u010-lock-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exponential_backoff_is_persisted_and_correct_code_waits_then_resets() {
        let t = Temp::new();
        let mut s = Store::open(&t.0).unwrap();
        let mut now = 1_000_000;
        s.lock_action(Action::Set("482615"), now).unwrap();
        for failure in 1..=20 {
            assert_eq!(
                s.lock_action(Action::Verify("invalid"), now)
                    .unwrap_err()
                    .code,
                "APP_LOCK_WRONG"
            );
            let expected = delay_ms(failure);
            assert_eq!(
                view(&s.state.settings, now).app_lock.retry_after_ms,
                expected
            );
            drop(s);
            s = Store::open(&t.0).unwrap();
            assert_eq!(
                view(&s.state.settings, now).app_lock.failed_attempts,
                failure
            );
            if expected > 0 {
                let before = fs::read(t.0.join("state.json")).unwrap();
                for action in [
                    Action::Verify("482615"),
                    Action::Change("482615", "123456"),
                    Action::Disable("482615"),
                ] {
                    assert_eq!(
                        s.lock_action(action, now + expected - 1).unwrap_err().code,
                        "APP_LOCK_THROTTLED"
                    );
                }
                assert_eq!(fs::read(t.0.join("state.json")).unwrap(), before);
            }
            now += expected;
        }
        assert_eq!(delay_ms(u32::MAX), 3_600_000);
        let result = s.lock_action(Action::Verify("482615"), now).unwrap();
        assert_eq!(result.settings.app_lock.failed_attempts, 0);
        assert_eq!(result.settings.app_lock.retry_after_ms, 0);
    }
    #[test]
    fn diagnostics_redact_codes_salts_hashes_and_success_payloads() {
        let t = Temp::new();
        let mut s = Store::open(&t.0).unwrap();
        let code = "482615";
        let result = s.set_app_lock(code).unwrap();
        let lock = s.state.settings.app_lock.as_ref().unwrap().clone();
        let secrets = [
            code.to_owned(),
            crate::sha256::hex(&lock.hash),
            crate::sha256::hex(&lock.salt),
        ];
        let mut output = format!(
            "{result:?} {} {:?}",
            result.to_json().dump(),
            s.state.settings
        );
        for e in [
            s.set_app_lock(code).unwrap_err(),
            s.verify_app_lock("wrong-synthetic").unwrap_err(),
            s.change_app_lock("wrong-synthetic", code).unwrap_err(),
            invalid(),
            crypto_error(),
        ] {
            output.push_str(&format!("{e} {e:?} {}", e.to_json().dump()));
        }
        for secret in secrets {
            assert!(!output.contains(&secret));
        }
        // Source-level grep guards prevent adding logging or derived credential Debug.
        let production = include_str!("app_lock.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for pattern in ["println!", "eprintln!", "dbg!", "log::", "tracing::"] {
            assert!(!production.contains(pattern));
        }
        assert_eq!(format!("{lock:?}"), "AppLock([REDACTED])");
    }
}
