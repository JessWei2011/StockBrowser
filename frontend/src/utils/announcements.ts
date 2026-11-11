import type { StockAnnouncement } from '../types';

/**
 * 解析公告日期字串為 Date 物件（支援 YYYY-MM-DD 或民國格式 1151109 等）
 */
export function parseAnnouncementDate(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const str = dateStr.trim();
  // 1. 民國格式 (e.g. 1151108 -> 2026-11-08)
  if (/^\d{7}$/.test(str)) {
    const y = parseInt(str.substring(0, 3), 10) + 1911;
    const m = parseInt(str.substring(3, 5), 10) - 1;
    const d = parseInt(str.substring(5, 7), 10);
    return new Date(y, m, d);
  }
  // 2. 西元 8 碼 (e.g. 20261108)
  if (/^\d{8}$/.test(str)) {
    const y = parseInt(str.substring(0, 4), 10);
    const m = parseInt(str.substring(4, 6), 10) - 1;
    const d = parseInt(str.substring(6, 8), 10);
    return new Date(y, m, d);
  }
  // 3. ISO / 標準字串 (e.g. 2026-11-08)
  const dt = new Date(str.includes('T') ? str : `${str}T00:00:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * 判斷公告是否已過期：
 * 1. 自結 (revenue): 在次月營收公布前均保留有效（45 天寬限期，避免月中報表交接期過早失效）
 * 2. 重訊 (news): 發布日超過 3 天過期取消
 * 3. 法說會 (briefing) 與 財報 (earnings): 召開/公布日超過 5 天過期取消（事前正常顯示預告，事後保留 5 天）
 * 4. 除權除息 (exdividend): 除權息基準日過後過期取消
 */
export function isAnnouncementExpired(ann: StockAnnouncement, now: Date = new Date()): boolean {
  if (!ann.date) return false;
  const targetDate = parseAnnouncementDate(ann.date);
  if (!targetDate) return false;

  // 取得基準日期（去除時間，以日為單位計算天數差）
  const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDateOnly = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const diffDays = Math.floor((nowDateOnly.getTime() - targetDateOnly.getTime()) / (1000 * 60 * 60 * 24));

  if (ann.category === 'revenue') {
    // 依使用者規則 (選項 A)：在 N 月 (例如 11 月)，只顯示 N-1 月 (10 月) 自結；舊月份 (9 月或更早) 一律過期取消
    // 尚未公布或非當期目標月份者，直接不顯示標籤
    const targetMonth = now.getMonth() === 0 ? 12 : now.getMonth();
    const tagMatch = ann.tag?.match(/(\d{1,2})月/) || ann.title?.match(/(\d{1,2})月/);
    if (tagMatch) {
      const annMonth = parseInt(tagMatch[1], 10);
      if (annMonth !== targetMonth) {
        return true; // 舊月份營收強制過期取消！
      }
    } else {
      return true; // 無法識別為當期目標月份者強制不顯示
    }
    return diffDays > 35;
  }
  if (ann.category === 'news') {
    return diffDays > 3;
  }
  if (ann.category === 'briefing' || ann.category === 'earnings') {
    return diffDays > 5;
  }
  if (ann.category === 'exdividend') {
    return diffDays > 0;
  }
  return false;
}

/**
 * 過濾個股的公告清單，排除已過期之標籤
 */
export function filterActiveAnnouncements(announcements: StockAnnouncement[] = [], now: Date = new Date()): StockAnnouncement[] {
  return announcements.filter((ann) => !isAnnouncementExpired(ann, now));
}
