//! Persisted v4 settings. Portable backups omit the device-specific UI lock.
use crate::{
    json::Json,
    model::{req_str, req_u32, req_u64},
    CoreError,
};
use std::fmt;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThemePreference {
    Light,
    Dark,
    #[default]
    System,
}
impl ThemePreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        match s {
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            "system" => Ok(Self::System),
            _ => Err(CoreError::new(
                "THEME_INVALID",
                "主题必须为 light、dark 或 system",
            )),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settings {
    pub theme: ThemePreference,
    pub(crate) app_lock: Option<AppLock>,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct AppLock {
    pub salt: [u8; 16],
    pub hash: [u8; 32],
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub failures: u32,
    pub blocked_until_ms: u64,
}
impl fmt::Debug for AppLock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AppLock([REDACTED])")
    }
}
impl AppLock {
    pub(crate) fn to_json(&self) -> Json {
        Json::obj(vec![
            ("algorithm", Json::str("argon2id")),
            ("version", Json::Num(19)),
            ("salt", Json::str(crate::sha256::hex(&self.salt))),
            ("hash", Json::str(crate::sha256::hex(&self.hash))),
            ("m", Json::Num(self.m as i64)),
            ("t", Json::Num(self.t as i64)),
            ("p", Json::Num(self.p as i64)),
            ("failures", Json::Num(self.failures as i64)),
            ("blockedUntilMs", Json::Num(self.blocked_until_ms as i64)),
        ])
    }
    fn from_json(v: &Json) -> Result<Self, String> {
        fn hex<const N: usize>(v: &Json, key: &str) -> Result<[u8; N], String> {
            let s = req_str(v, key)?;
            if s.len() != N * 2
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("应用锁凭据格式无效".into());
            }
            let mut out = [0; N];
            for (i, b) in out.iter_mut().enumerate() {
                *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
                    .map_err(|_| "应用锁凭据格式无效")?;
            }
            Ok(out)
        }
        if req_str(v, "algorithm")? != "argon2id" || req_u32(v, "version")? != 19 {
            return Err("应用锁算法不支持".into());
        }
        let lock = Self {
            salt: hex(v, "salt")?,
            hash: hex(v, "hash")?,
            m: req_u32(v, "m")?,
            t: req_u32(v, "t")?,
            p: req_u32(v, "p")?,
            failures: req_u32(v, "failures")?,
            blocked_until_ms: req_u64(v, "blockedUntilMs")?,
        };
        if !(19456..=65536).contains(&lock.m)
            || !(2..=6).contains(&lock.t)
            || !(1..=4).contains(&lock.p)
            || lock.m < 8 * lock.p
            || (lock.failures < 3 && lock.blocked_until_ms != 0)
        {
            return Err("应用锁参数无效".into());
        }
        Ok(lock)
    }
}
impl Settings {
    pub fn to_json(&self) -> Json {
        Json::obj(vec![
            ("theme", Json::str(self.theme.as_str())),
            (
                "appLock",
                self.app_lock
                    .as_ref()
                    .map(AppLock::to_json)
                    .unwrap_or(Json::Null),
            ),
        ])
    }
    pub(crate) fn from_json(v: &Json) -> Result<Self, CoreError> {
        let parse = || -> Result<Self, String> {
            Ok(Self {
                theme: ThemePreference::parse(&req_str(v, "theme")?).map_err(|e| e.message)?,
                app_lock: match v.get("appLock") {
                    Some(Json::Null) => None,
                    Some(v) => Some(AppLock::from_json(v)?),
                    None => return Err("settings 缺少 appLock".into()),
                },
            })
        };
        parse().map_err(|_| CoreError::new("STATE_CORRUPT", "偏好或应用锁状态无效"))
    }
}
