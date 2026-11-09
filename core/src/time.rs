//! 时间与日期：不引入 chrono，自行换算 UTC 日历日期。
//!
//! eventTime 保持可空，任何展示层都不得为缺失时刻伪造时间。

use std::time::{SystemTime, UNIX_EPOCH};

/// 支持 SHIGUANG_CLOCK 固定时间，便于验收脚本得到可重复输出。
pub fn now_rfc3339() -> String {
    if let Ok(value) = std::env::var("SHIGUANG_CLOCK") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format_rfc3339(SystemTime::now())
}

pub fn format_rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 days->civil 算法（1970-01-01 起的天数）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 严格校验 YYYY-MM-DD（含真实日历，拒绝 2026-02-30）。
pub fn is_valid_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year: i64 = match text[0..4].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let month: u32 = match text[5..7].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let day: u32 = match text[8..10].parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    day <= days_in_month(year, month)
}

/// 校验 HH:MM（24 小时制）。
pub fn is_valid_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(i, b)| i == 2 || b.is_ascii_digit())
    {
        return false;
    }
    let hour: u32 = text[0..2].parse().unwrap_or(99);
    let minute: u32 = text[3..5].parse().unwrap_or(99);
    hour < 24 && minute < 60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_known_dates() {
        assert_eq!(
            format_rfc3339(UNIX_EPOCH),
            "1970-01-01T00:00:00Z"
        );
        assert_eq!(
            format_rfc3339(UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000)),
            "2023-11-14T22:13:20Z"
        );
    }

    #[test]
    fn date_validation() {
        assert!(is_valid_date("2026-11-09"));
        assert!(is_valid_date("2024-02-29"));
        assert!(!is_valid_date("2026-02-29"));
        assert!(!is_valid_date("2026-02-30"));
        assert!(!is_valid_date("2026-13-01"));
        assert!(!is_valid_date("2026-1-9"));
        assert!(!is_valid_date(""));
    }

    #[test]
    fn time_validation() {
        assert!(is_valid_time("00:00"));
        assert!(is_valid_time("23:59"));
        assert!(!is_valid_time("24:00"));
        assert!(!is_valid_time("9:30"));
        assert!(!is_valid_time("12:60"));
    }
}
