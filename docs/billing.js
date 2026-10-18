/**
 * 授業料の計算（spec §16）。保護者アプリと講師アプリで共有する。
 * 月ごとの金額は保存しない。授業の予定（docs/lessons.js）と学年から、表示のたびに計算する。
 * 保存するのは「入金を確認した」記録（payments）だけで、領収書はその記録の金額で出す
 */
(function (root) {
  "use strict";

  const L = typeof module !== "undefined" && module.exports ? require("./lessons.js") : root.Lessons;

  const GRADES = ["小1", "小2", "小3", "小4", "小5", "小6", "中1", "中2", "中3", "高1", "高2", "高3"];
  // 中3以上は3,000円、それ以外（中2まで）は2,000円
  const RATE_SENIOR = 3000;
  const RATE_JUNIOR = 2000;
  const SENIOR_FROM = GRADES.indexOf("中3");
  // 何か月前まで請求を表示するか（支払い期限が翌月末なので、先々月までは未払いがありうる）
  const MONTHS_BACK = 3;

  /** 年度（4月始まり）。2027-03 は 2026 年度 */
  function schoolYear(dateKey) {
    const p = dateKey.split("-");
    const y = Number(p[0]);
    return Number(p[1]) >= 4 ? y : y - 1;
  }

  /**
   * 学年は "2026:中1"（2026年度に中1）の形で保存し、4月になったら自動で1つ上がる。
   * 毎年の更新を忘れても請求が狂わないようにするため
   */
  function parseGradeBase(gradeBase) {
    const m = /^(\d{4}):(.+)$/.exec(String(gradeBase || ""));
    if (!m) return null;
    const idx = GRADES.indexOf(m[2]);
    if (idx === -1) return null;
    return { year: Number(m[1]), index: idx };
  }

  /** その日の学年。{ label, index } を返す。学年が未設定なら null */
  function gradeOn(gradeBase, dateKey) {
    const base = parseGradeBase(gradeBase);
    if (!base) return null;
    const index = base.index + (schoolYear(dateKey) - base.year);
    if (index < 0) return { label: GRADES[0], index: 0 };
    if (index >= GRADES.length) return { label: "高校卒業後", index: GRADES.length };
    return { label: GRADES[index], index: index };
  }

  function rateForGrade(grade) {
    return grade.index >= SENIOR_FROM ? RATE_SENIOR : RATE_JUNIOR;
  }

  function monthOf(dateKey) {
    return dateKey.slice(0, 7);
  }

  function addMonths(month, n) {
    const p = month.split("-");
    const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }

  function monthStart(month) {
    return month + "-01";
  }

  function monthEnd(month) {
    const p = month.split("-");
    // 翌月0日 = その月の末日
    return new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).toISOString().slice(0, 10);
  }

  /** 支払い期限は翌月末。10月分なら 11/30 */
  function dueDate(month) {
    return monthEnd(addMonths(month, 1));
  }

  /**
   * ある月の請求。
   * lessons は getLessons / parentGetSummary の { rules, changes }、gradeBase は "2026:中1"。
   * 実施済み（終わった授業）と、これから（まだ終わっていない予定）を分けて数える
   */
  function monthBilling(lessons, gradeBase, month, now) {
    const n = L.nowInTokyo(now);
    const items = L.occurrences(lessons, monthStart(month), monthEnd(month))
      .map(function (x) {
        const grade = gradeOn(gradeBase, x.date);
        return {
          date: x.date, startTime: x.startTime, endTime: x.endTime, kind: x.kind,
          ruleId: x.ruleId, lessonId: x.lessonId, note: x.note,
          cancelled: x.cancelled,
          done: !x.cancelled && L.isOver(x, n),
          rate: grade ? rateForGrade(grade) : null
        };
      });
    const done = items.filter(function (x) { return x.done; });
    const planned = items.filter(function (x) { return !x.cancelled && !x.done; });
    const sum = function (list) { return list.reduce(function (s, x) { return s + (x.rate || 0); }, 0); };
    const grade = gradeOn(gradeBase, monthStart(month));
    return {
      month: month,
      grade: grade,
      items: items,
      doneCount: done.length,
      plannedCount: planned.length,
      amountDone: sum(done),
      amountPlanned: sum(planned),
      amountTotal: sum(done) + sum(planned),
      dueDate: dueDate(month),
      // 月が終わると金額が確定する
      closed: monthEnd(month) < n.date
    };
  }

  /** 表示する月。今月から MONTHS_BACK か月前まで（新しい順）。入金記録のある月はそれより前でも出す */
  function monthsToShow(payments, now) {
    const current = monthOf(L.nowInTokyo(now).date);
    const months = [];
    for (let i = 0; i <= MONTHS_BACK; i++) months.push(addMonths(current, -i));
    (payments || []).forEach(function (p) { if (months.indexOf(p.month) === -1) months.push(p.month); });
    return months.sort().reverse();
  }

  function yen(amount) {
    return "¥" + Number(amount || 0).toLocaleString("ja-JP");
  }

  /** "2026年10月分" */
  function monthLabel(month) {
    const p = month.split("-");
    return p[0] + "年" + Number(p[1]) + "月分";
  }

  const api = {
    GRADES: GRADES,
    RATE_JUNIOR: RATE_JUNIOR,
    RATE_SENIOR: RATE_SENIOR,
    schoolYear: schoolYear,
    parseGradeBase: parseGradeBase,
    gradeOn: gradeOn,
    rateForGrade: rateForGrade,
    monthOf: monthOf,
    addMonths: addMonths,
    monthEnd: monthEnd,
    dueDate: dueDate,
    monthBilling: monthBilling,
    monthsToShow: monthsToShow,
    yen: yen,
    monthLabel: monthLabel
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Billing = api;
})(typeof self !== "undefined" ? self : this);
