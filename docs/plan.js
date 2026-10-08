/**
 * 学習計画の割り振り計算（spec §14.2）。生徒アプリと講師アプリで共有する。
 * 日付はすべて "YYYY-MM-DD" の文字列で扱い、タイムゾーンのずれが入らないよう UTC の日付として数える
 */
(function (root) {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  // 1日の切り替わり。夜中に勉強した分を前日の扱いにするため（spec §14.1）
  const DAY_START_HOUR = 6;
  const TIME_ZONE = "Asia/Tokyo";

  const keyFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

  /** 今の「勉強の日付」。朝6時より前は前日 */
  function studyDateNow(now) {
    const ms = (now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.now())) - DAY_START_HOUR * 60 * 60 * 1000;
    return keyFormatter.format(new Date(ms));
  }

  function toUtc(key) {
    const p = key.split("-");
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function fromUtc(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function addDays(key, n) {
    return fromUtc(toUtc(key) + n * DAY_MS);
  }

  function weekday(key) {
    return new Date(toUtc(key)).getUTCDay();
  }

  function isRestDay(goal, key) {
    return goal.restWeekdays.indexOf(weekday(key)) !== -1 || goal.restDates.indexOf(key) !== -1;
  }

  /**
   * 1つの目標の日ごとの割り当てを計算する。
   * progress は { goalId, studyDate, throughPage } の配列（他の目標の分が混ざっていてもよい）
   */
  function computeGoal(goal, progress, today) {
    const records = progress
      .filter(function (r) { return r.goalId === goal.goalId; })
      .map(function (r) { return { date: r.studyDate, through: Number(r.throughPage) }; });

    // 日付ごとの記録（1日1件）と、「その日より前の記録の最大到達ページ」を引けるようにする
    const recordByDate = {};
    records.forEach(function (r) { recordByDate[r.date] = r.through; });
    const sortedDates = Object.keys(recordByDate).sort();
    const floor = goal.startPage - 1;

    function doneBefore(date) {
      let max = floor;
      for (let i = 0; i < sortedDates.length && sortedDates[i] < date; i++) {
        max = Math.max(max, recordByDate[sortedDates[i]]);
      }
      return max;
    }

    const doneThrough = sortedDates.reduce(function (m, d) { return Math.max(m, recordByDate[d]); }, floor);
    const total = goal.endPage - goal.startPage + 1;

    // 勉強日の一覧（休みを除く）
    const studyDays = [];
    for (let d = goal.startDate; d <= goal.dueDate; d = addDays(d, 1)) {
      if (!isRestDay(goal, d)) studyDays.push(d);
    }

    const days = {};
    let prevPlannedEnd = floor;
    let overdue = false;

    for (let i = 0; i < studyDays.length; i++) {
      const d = studyDays[i];
      const actual = doneBefore(d);
      const cursor = d <= today ? actual : Math.max(actual, prevPlannedEnd);
      const remaining = goal.endPage - cursor;
      if (remaining <= 0) {
        prevPlannedEnd = cursor;
        continue;
      }
      const daysLeft = studyDays.length - i;
      const pages = Math.ceil(remaining / daysLeft);
      const from = cursor + 1;
      const to = Math.min(goal.endPage, cursor + pages);
      days[d] = describeDay(goal, d, from, to, recordByDate[d], today, false);
      prevPlannedEnd = to;
    }

    // 期限を過ぎた、または今日から期限までに勉強日が無いのに残りがある: 残り全部を今日に置く
    const actualToday = doneBefore(today);
    const hasStudyDayAhead = studyDays.some(function (d) { return d >= today; });
    if (today >= goal.startDate && actualToday < goal.endPage && !hasStudyDayAhead) {
      overdue = true;
      days[today] = describeDay(goal, today, actualToday + 1, goal.endPage, recordByDate[today], today, true);
    }

    // これから7日間（今日を含む）の合計ページ
    let next7 = 0;
    for (let k = 0; k < 7; k++) {
      const entry = days[addDays(today, k)];
      if (entry) next7 += entry.pages;
    }

    // 遅れの判定（spec §14.6）
    const originalPace = studyDays.length ? Math.ceil(total / studyDays.length) : total;
    const todayEntry = days[today] || null;
    const lastStudyDay = studyDays.filter(function (d) { return d < today; }).pop();
    const missedLast = !!(lastStudyDay && days[lastStudyDay] && days[lastStudyDay].status !== "done");
    const paceUp = !!(todayEntry && todayEntry.pages > originalPace * 1.25);

    return {
      goal: goal,
      days: days,
      total: total,
      doneThrough: doneThrough,
      donePages: Math.max(0, doneThrough - floor),
      today: todayEntry,
      next7: next7,
      originalPace: originalPace,
      overdue: overdue,
      finished: doneThrough >= goal.endPage,
      behind: overdue || missedLast || paceUp,
      missedLast: missedLast,
      paceUp: paceUp
    };
  }

  function describeDay(goal, date, from, to, record, today, overdue) {
    let status;
    if (record !== undefined && record >= to) status = "done";
    else if (record !== undefined && record >= from) status = "partial";
    else status = date < today ? "missed" : "todo";
    return {
      goalId: goal.goalId,
      date: date,
      from: from,
      to: to,
      pages: to - from + 1,
      record: record === undefined ? null : record,
      status: status,
      overdue: overdue,
      // 過ぎた日は記録を変えられない（spec §14.3）
      editable: date >= today
    };
  }

  /**
   * その日の範囲を見開きごとに分ける（spec §14.7）。組み方はテキストによって違う。
   * spreadStart が "even" なら p.31〜39 は [31] [32-33] … [38-39]、"odd" なら [31-32] … [39]
   */
  function spreadsOf(entry, spreadStart) {
    const startParity = spreadStart === "odd" ? 1 : 0;
    const spreads = [];
    for (let p = entry.from; p <= entry.to; ) {
      const end = Math.min(entry.to, p % 2 === startParity ? p + 1 : p);
      spreads.push({ from: p, to: end });
      p = end + 1;
    }
    return spreads;
  }

  /** 全目標ぶんをまとめて計算する */
  function computePlan(goals, progress, today) {
    return goals.map(function (g) { return computeGoal(g, progress, today); });
  }

  /** ある日付の割り当てを、目標の並び順で返す */
  function entriesOn(plans, date) {
    return plans
      .map(function (p) { return p.days[date] ? { plan: p, entry: p.days[date] } : null; })
      .filter(Boolean);
  }

  const api = {
    studyDateNow: studyDateNow,
    addDays: addDays,
    weekday: weekday,
    isRestDay: isRestDay,
    computeGoal: computeGoal,
    computePlan: computePlan,
    entriesOn: entriesOn,
    spreadsOf: spreadsOf
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StudyPlan = api;
})(typeof self !== "undefined" ? self : this);
