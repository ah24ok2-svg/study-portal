/**
 * 授業の予定の展開（spec §15）。生徒アプリと講師アプリで共有する。
 * サーバーは「毎週の授業」と個別の変更（追加・休み）だけを返すので、これからの日付と時間の一覧はここで作る
 */
(function (root) {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const TIME_ZONE = "Asia/Tokyo";
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  // 毎週の授業を何日先まで並べるか。イレギュラーの授業はこれより先でも出す
  const DEFAULT_DAYS = 56;

  const nowFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  /** 日本時間の今の日付と時刻 */
  function nowInTokyo(now) {
    const date = now instanceof Date ? now : new Date(typeof now === "number" ? now : Date.now());
    const parts = {};
    nowFormatter.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
    return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute };
  }

  function toUtc(key) {
    const p = key.split("-");
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(key, n) {
    return new Date(toUtc(key) + n * DAY_MS).toISOString().slice(0, 10);
  }

  function weekday(key) {
    return new Date(toUtc(key)).getUTCDay();
  }

  /**
   * これからの授業の一覧。終わった授業は含めない（授業中のものは含める）。
   * 毎週の授業を休みにした日も cancelled: true で残す。生徒が「今週は休み」と分かるようにするため
   */
  function upcoming(data, now, options) {
    const days = (options && options.days) || DEFAULT_DAYS;
    const n = nowInTokyo(now);
    const rules = (data && data.rules) || [];
    const changes = (data && data.changes) || [];
    const cancelled = {};
    changes.forEach(function (c) { if (c.kind === "cancel") cancelled[c.ruleId + "|" + c.date] = true; });

    const items = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(n.date, i);
      const wd = weekday(d);
      rules.forEach(function (r) {
        if (r.weekday !== wd || d < r.startDate || (r.endDate && d > r.endDate)) return;
        items.push({
          kind: "weekly", ruleId: r.ruleId, date: d, startTime: r.startTime, endTime: r.endTime,
          note: "", cancelled: !!cancelled[r.ruleId + "|" + d]
        });
      });
    }
    changes.forEach(function (c) {
      if (c.kind !== "extra") return;
      items.push({ kind: "extra", lessonId: c.lessonId, date: c.date, startTime: c.startTime, endTime: c.endTime, note: c.note || "", cancelled: false });
    });

    return items
      .filter(function (x) { return x.date > n.date || (x.date === n.date && x.endTime > n.time); })
      .map(function (x) {
        x.ongoing = !x.cancelled && x.date === n.date && x.startTime <= n.time;
        return x;
      })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
        return a.kind === b.kind ? 0 : a.kind === "weekly" ? -1 : 1;
      });
  }

  /** 次に実際に行う授業（休みは飛ばす） */
  function nextLesson(items) {
    return items.find(function (x) { return !x.cancelled; }) || null;
  }

  /** "10/15(木)" */
  function shortDate(key) {
    const p = key.split("-");
    return Number(p[1]) + "/" + Number(p[2]) + "(" + WEEKDAYS[weekday(key)] + ")";
  }

  /** "10月15日(木)" */
  function longDate(key) {
    const p = key.split("-");
    return Number(p[1]) + "月" + Number(p[2]) + "日(" + WEEKDAYS[weekday(key)] + ")";
  }

  /** "9:00" のように時の頭の0を落とす。"09:00〜" より読みやすいため */
  function time(t) {
    return t.charAt(0) === "0" ? t.slice(1) : t;
  }

  function timeRange(item) {
    return time(item.startTime) + "〜" + time(item.endTime);
  }

  /** 今日・明日・あさって・N日後 */
  function relativeDay(key, now) {
    const today = nowInTokyo(now).date;
    const diff = Math.round((toUtc(key) - toUtc(today)) / DAY_MS);
    if (diff <= 0) return "今日";
    if (diff === 1) return "明日";
    if (diff === 2) return "あさって";
    return diff + "日後";
  }

  /** 毎週の授業の説明。"毎週 木曜 19:00〜20:30" */
  function describeRule(rule) {
    return "毎週 " + WEEKDAYS[rule.weekday] + "曜 " + timeRange(rule);
  }

  const api = {
    WEEKDAYS: WEEKDAYS,
    nowInTokyo: nowInTokyo,
    addDays: addDays,
    weekday: weekday,
    upcoming: upcoming,
    nextLesson: nextLesson,
    shortDate: shortDate,
    longDate: longDate,
    time: time,
    timeRange: timeRange,
    relativeDay: relativeDay,
    describeRule: describeRule
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Lessons = api;
})(typeof self !== "undefined" ? self : this);
