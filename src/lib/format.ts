import type { BookFormat, ContentType } from "../types";
import { clampUnit } from "./number";

export function labelForFormat(format: BookFormat) {
  if (format === "image-folder") return "图片文件夹";
  return format.toUpperCase();
}

export function labelForContentType(type: ContentType) {
  return type === "comic" ? "漫画" : "小说";
}

export function formatPercent(value: number) {
  const percent = clampUnit(value);
  return `${Math.round(percent * 100)}%`;
}

export function formatRelativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = minute * 60;
  const day = hour * 24;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
