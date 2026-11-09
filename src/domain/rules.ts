import type { FieldIssue, Snapshot } from "./types.ts";

/**
 * 与 Rust 核心同一套提交底线：
 * - eventDate 必填且为真实 YYYY-MM-DD
 * - 正文非空 或 至少 1 张照片
 * - 仅标题拒绝
 * - eventTime 可空，但有值必须是合法 HH:MM
 */
export function validateForCommit(snapshot: Snapshot): FieldIssue | null {
  const date = snapshot.eventDate.trim();
  if (date.length === 0) {
    return {
      code: "MISSING_EVENT_DATE",
      message: "缺少事件日期：eventDate 为必填项（YYYY-MM-DD）",
    };
  }
  if (!isValidDate(date)) {
    return {
      code: "INVALID_EVENT_DATE",
      message: `事件日期无效：${snapshot.eventDate}（需为真实的 YYYY-MM-DD）`,
    };
  }
  if (snapshot.eventTime !== null && snapshot.eventTime.trim().length > 0 && !isValidTime(snapshot.eventTime)) {
    return {
      code: "INVALID_EVENT_TIME",
      message: `事件时刻无效：${snapshot.eventTime}（需为 HH:MM，可留空）`,
    };
  }
  if (snapshot.body.trim().length === 0 && snapshot.photos.length === 0) {
    return {
      code: "EMPTY_CONTENT",
      message: "缺少正文或照片，无法存入时光（仅标题不能提交）",
    };
  }
  return null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export function isValidDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function isValidTime(text: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(text)) return false;
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(3, 5));
  return hour < 24 && minute < 60;
}
