// 割り振り計算（docs/plan.js、spec §14.2）
const P = require("../docs/plan.js");

module.exports = function (t) {
  const G = (o) => Object.assign({ goalId: "g1", title: "テキスト", startPage: 1, endPage: 100, startDate: "2026-10-01", dueDate: "2026-10-10", restWeekdays: [], restDates: [] }, o);

  // 朝6時の切り替え
  t("05:59 JST is previous day", P.studyDateNow(new Date("2026-10-01T20:59:00Z")) === "2026-10-01");
  t("06:00 JST is new day", P.studyDateNow(new Date("2026-10-01T21:00:00Z")) === "2026-10-02");
  t("weekday", P.weekday("2026-10-04") === 0);

  // 基本: 100ページを10日 → 毎日10ページ
  let p = P.computeGoal(G(), [], "2026-10-01");
  t("even split", Object.values(p.days).every((e) => e.pages === 10) && Object.keys(p.days).length === 10);
  t("today", p.today.from === 1 && p.today.to === 10 && p.today.status === "todo");
  t("next7", p.next7 === 70);
  t("not behind", !p.behind);

  // 割り切れないときは前半に寄せる
  p = P.computeGoal(G({ endPage: 10, dueDate: "2026-10-03" }), [], "2026-10-01");
  t("ceil front-load", JSON.stringify(Object.values(p.days).map((e) => e.pages)) === "[4,3,3]");

  // 休み
  p = P.computeGoal(G({ restWeekdays: [0], restDates: ["2026-10-07"] }), [], "2026-10-01");
  t("rest days skipped", !p.days["2026-10-04"] && !p.days["2026-10-07"] && Object.keys(p.days).length === 8);
  t("rest pages", p.today.pages === 13);

  // 前日の分が6時までに終わっていない → 組み替え
  p = P.computeGoal(G(), [], "2026-10-02");
  t("missed day status", p.days["2026-10-01"].status === "missed");
  t("rescheduled today", p.today.from === 1 && p.today.to === 12);
  t("behind (missed)", p.behind && p.missedLast);
  t("still finishes by due", Object.values(p.days).filter((e) => e.date >= "2026-10-02").reduce((s, e) => s + e.pages, 0) === 100);

  // チェックしても今日の割り当ては変わらない
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 10 }], "2026-10-01");
  t("today unchanged after check", p.today.from === 1 && p.today.to === 10 && p.today.status === "done");
  t("tomorrow continues", p.days["2026-10-02"].from === 11);

  // 途中まで
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 6 }], "2026-10-02");
  t("partial status", p.days["2026-10-01"].status === "partial" && p.days["2026-10-01"].record === 6);
  t("partial reschedule", p.today.from === 7 && p.today.to === 17);
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 6 }], "2026-10-01");
  t("partial today keeps today's range", p.today.from === 1 && p.today.to === 10 && p.today.status === "partial");

  // 先取り・前倒し
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 30 }], "2026-10-01");
  t("ahead shrinks future", p.days["2026-10-02"].from === 31 && p.days["2026-10-02"].pages === 8);
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 10 }, { goalId: "g1", studyDate: "2026-10-02", throughPage: 20 }], "2026-10-01");
  t("future check counts", p.days["2026-10-02"].status === "done" && p.days["2026-10-03"].from === 21);
  t("past not editable", P.computeGoal(G(), [], "2026-10-02").days["2026-10-01"].editable === false);

  // 完了・期限超過・開始前
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-01", throughPage: 100 }], "2026-10-02");
  t("finished", p.finished && !p.today);
  p = P.computeGoal(G(), [{ goalId: "g1", studyDate: "2026-10-05", throughPage: 50 }], "2026-10-12");
  t("overdue", p.overdue && p.today.from === 51 && p.today.to === 100 && p.today.overdue);
  p = P.computeGoal(G({ restDates: ["2026-10-09", "2026-10-10"] }), [{ goalId: "g1", studyDate: "2026-10-08", throughPage: 80 }], "2026-10-09");
  t("no study day ahead -> overdue today", p.overdue && p.today && p.today.from === 81);
  p = P.computeGoal(G({ startDate: "2026-10-05" }), [], "2026-10-01");
  t("before start", !p.today && p.days["2026-10-05"].from === 1);
  t("pace up", P.computeGoal(G(), [], "2026-10-06").paceUp);

  // 複数目標・年またぎ
  const plans = P.computePlan([G(), G({ goalId: "g2", startPage: 201, endPage: 230, dueDate: "2026-10-03" })], [{ goalId: "g2", studyDate: "2026-10-01", throughPage: 210 }], "2026-10-01");
  t("independent goals", plans[0].today.from === 1 && plans[1].today.status === "done");
  t("entriesOn", P.entriesOn(plans, "2026-10-01").length === 2 && P.entriesOn(plans, "2026-10-05").length === 1);
  p = P.computeGoal(G({ startDate: "2026-12-30", dueDate: "2027-01-02", endPage: 8 }), [], "2026-12-30");
  t("year boundary", Object.keys(p.days).join(",") === "2026-12-30,2026-12-31,2027-01-01,2027-01-02");

  // 見開きの区切り（spec §14.7）
  const sp = (from, to) => JSON.stringify(P.spreadsOf({ from, to }).map((s) => [s.from, s.to]));
  t("spreads even start", sp(50, 54) === "[[50,51],[52,53],[54,54]]", sp(50, 54));
  t("spreads odd start", sp(31, 39) === "[[31,31],[32,33],[34,35],[36,37],[38,39]]", sp(31, 39));
  t("spreads single page", sp(7, 7) === "[[7,7]]" && sp(8, 8) === "[[8,8]]");
  t("spreads cover all pages", P.spreadsOf({ from: 3, to: 98 }).reduce((n, s) => n + s.to - s.from + 1, 0) === 96);
};
