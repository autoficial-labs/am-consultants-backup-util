//! When is the next complete backup due?

use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone};

use crate::model::FullPolicy;

fn at_time(day: chrono::NaiveDate, time: NaiveTime) -> DateTime<Local> {
    let naive = day.and_time(time);
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t,
        chrono::LocalResult::Ambiguous(a, _) => a,
        // Daylight-saving gap: use the first valid moment after it.
        chrono::LocalResult::None => Local.from_local_datetime(&(naive + Duration::hours(1))).earliest().unwrap_or_else(Local::now),
    }
}

fn parse_time(s: &str) -> NaiveTime {
    NaiveTime::parse_from_str(s, "%H:%M").unwrap_or_else(|_| NaiveTime::from_hms_opt(20, 0, 0).expect("valid time"))
}

/// The most recent scheduled moment at or before `now`.
fn last_slot(p: &FullPolicy, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let time = parse_time(&p.time);
    match p.schedule.as_str() {
        "daily" => {
            let today = at_time(now.date_naive(), time);
            Some(if now >= today { today } else { at_time(now.date_naive() - Duration::days(1), time) })
        }
        "weekly" => {
            let today_wd = now.weekday().num_days_from_sunday() as i64;
            let back = (today_wd - p.weekday as i64).rem_euclid(7);
            let slot = at_time(now.date_naive() - Duration::days(back), time);
            Some(if slot <= now { slot } else { at_time(now.date_naive() - Duration::days(back + 7), time) })
        }
        _ => None,
    }
}

pub fn is_due(p: &FullPolicy, last_full: Option<i64>, now: DateTime<Local>) -> bool {
    match p.schedule.as_str() {
        "off" => false,
        "hours" => last_full.is_none_or(|t| now.timestamp_millis() - t >= p.every_hours.max(1) * 3_600_000),
        _ => match (last_slot(p, now), last_full) {
            (Some(_), None) => true,
            (Some(slot), Some(t)) => t < slot.timestamp_millis(),
            (None, _) => false,
        },
    }
}

/// Next time a complete backup will start (now if it is already due).
pub fn next_due(p: &FullPolicy, last_full: Option<i64>, now: DateTime<Local>) -> Option<i64> {
    if p.schedule == "off" {
        return None;
    }
    if is_due(p, last_full, now) {
        return Some(now.timestamp_millis());
    }
    match p.schedule.as_str() {
        "hours" => last_full.map(|t| t + p.every_hours.max(1) * 3_600_000),
        "daily" => last_slot(p, now).map(|s| at_time(s.date_naive() + Duration::days(1), parse_time(&p.time)).timestamp_millis()),
        "weekly" => last_slot(p, now).map(|s| at_time(s.date_naive() + Duration::days(7), parse_time(&p.time)).timestamp_millis()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(schedule: &str) -> FullPolicy {
        FullPolicy { schedule: schedule.into(), time: "20:00".into(), every_hours: 6, weekday: 5, level: "maximum".into(), keep: 5 }
    }
    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).single().unwrap()
    }

    #[test]
    fn daily() {
        let p = policy("daily");
        let now = local(2026, 11, 20, 21, 0);
        assert!(is_due(&p, None, now));
        assert!(!is_due(&p, Some(local(2026, 11, 20, 20, 5).timestamp_millis()), now));
        assert!(is_due(&p, Some(local(2026, 11, 20, 19, 0).timestamp_millis()), now));
        // Before today's slot, yesterday's slot counts.
        let morning = local(2026, 11, 21, 9, 0);
        assert!(!is_due(&p, Some(local(2026, 11, 20, 20, 5).timestamp_millis()), morning));
        assert_eq!(next_due(&p, Some(local(2026, 11, 20, 20, 5).timestamp_millis()), morning), Some(local(2026, 11, 21, 20, 0).timestamp_millis()));
    }

    #[test]
    fn weekly() {
        let p = policy("weekly"); // Friday 20:00
        let sat = local(2026, 11, 21, 10, 0); // Saturday
        assert!(is_due(&p, Some(local(2026, 11, 13, 21, 0).timestamp_millis()), sat));
        assert!(!is_due(&p, Some(local(2026, 11, 20, 21, 0).timestamp_millis()), sat));
        assert_eq!(next_due(&p, Some(local(2026, 11, 20, 21, 0).timestamp_millis()), sat), Some(local(2026, 11, 27, 20, 0).timestamp_millis()));
    }

    #[test]
    fn hours_and_off() {
        let p = policy("hours");
        let now = local(2026, 11, 21, 12, 0);
        assert!(!is_due(&p, Some(local(2026, 11, 21, 7, 0).timestamp_millis()), now));
        assert!(is_due(&p, Some(local(2026, 11, 21, 5, 59).timestamp_millis()), now));
        assert!(!is_due(&policy("off"), None, now));
        assert_eq!(next_due(&policy("off"), None, now), None);
    }
}
