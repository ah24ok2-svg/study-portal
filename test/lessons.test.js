// 授業の予定（gas/lessons.js と docs/lessons.js、spec §15）
const { createMock } = require("./mockgas");
const L = require("../docs/lessons.js");

module.exports = function (t) {
  // ---- 展開（docs/lessons.js）。2026-10-12 は月曜
  const at = (s) => new Date(s + "+09:00");
  const rules = [{ ruleId: "r1", weekday: 4, startTime: "19:00", endTime: "20:30", startDate: "2026-10-01", endDate: null }];
  let items = L.upcoming({ rules, changes: [] }, at("2026-10-12T10:00:00"), { days: 21 });
  t("weekly expands", items.map((x) => x.date).join() === "2026-10-15,2026-10-22,2026-10-29", items);
  t("next lesson", L.nextLesson(items).date === "2026-10-15");

  items = L.upcoming({ rules, changes: [
    { kind: "cancel", ruleId: "r1", date: "2026-10-15" },
    { kind: "extra", lessonId: "x1", date: "2026-10-16", startTime: "18:00", endTime: "19:30", note: "振替" }
  ] }, at("2026-10-12T10:00:00"), { days: 21 });
  t("cancel kept as cancelled", items[0].date === "2026-10-15" && items[0].cancelled);
  t("extra inserted in order", items[1].kind === "extra" && items[1].date === "2026-10-16" && items[1].note === "振替");
  t("next skips cancelled", L.nextLesson(items).lessonId === "x1");

  // 授業中は残り、終わったら消える
  items = L.upcoming({ rules, changes: [] }, at("2026-10-15T19:30:00"), { days: 7 });
  t("ongoing", items[0].date === "2026-10-15" && items[0].ongoing);
  items = L.upcoming({ rules, changes: [] }, at("2026-10-15T20:30:00"), { days: 7 });
  t("finished dropped", items.length === 0 || items[0].date !== "2026-10-15");

  // 期間
  const ranged = [{ ruleId: "r2", weekday: 1, startTime: "17:00", endTime: "18:00", startDate: "2026-10-19", endDate: "2026-10-26" }];
  items = L.upcoming({ rules: ranged, changes: [] }, at("2026-10-12T09:00:00"), { days: 60 });
  t("start/end date respected", items.map((x) => x.date).join() === "2026-10-19,2026-10-26", items);
  t("far extra shown beyond range", L.upcoming({ rules: [], changes: [{ kind: "extra", lessonId: "y", date: "2027-03-01", startTime: "10:00", endTime: "11:00" }] }, at("2026-10-12T09:00:00"), { days: 7 }).length === 1);
  // 日付が変わる直前・直後（日本時間で数える）
  t("tokyo date", L.nowInTokyo(new Date("2026-10-14T15:30:00Z")).date === "2026-10-15");
  t("labels", L.shortDate("2026-10-15") === "10/15(木)" && L.timeRange({ startTime: "09:00", endTime: "10:30" }) === "9:00〜10:30");
  t("relative", L.relativeDay("2026-10-13", at("2026-10-12T23:00:00")) === "明日" && L.relativeDay("2026-10-15", at("2026-10-12T23:00:00")) === "3日後");

  // ---- API（gas/lessons.js）
  const m = createMock();
  const { call, sheets } = m;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const add = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
  const wd = (d) => new Date(d + "T00:00:00Z").getUTCDay();
  const a = m.gas.generateToken("テスト生徒A", "test-a");
  const b = m.gas.generateToken("テスト生徒B", "test-b");
  const tt = m.tutorLogin();
  const rule = (o) => Object.assign({ weekday: wd(add(today, 3)), startTime: "19:00", endTime: "20:30", startDate: today, endDate: null }, o);

  t("sheets created", sheets.lesson_rules && sheets.lesson_changes);
  let r = call({ action: "getLessons", token: a.token });
  t("empty", r.ok && r.data.rules.length === 0 && r.data.changes.length === 0 && r.data.today === today, r);

  r = call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: a.studentId, rule: rule() });
  t("create rule", r.ok && r.data.ruleId.startsWith("rule_"), r);
  const rid = r.data.ruleId;
  t("needs tutor", call({ action: "tutorSaveLessonRule", tutorToken: a.token, studentId: a.studentId, rule: rule() }).error?.code === "INVALID_TOKEN");
  const bad = (o, name) => t("reject " + name, call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: a.studentId, rule: rule(o) }).error?.code === "VALIDATION_ERROR");
  bad({ weekday: 7 }, "weekday 7");
  bad({ weekday: "1" }, "weekday string");
  bad({ startTime: "25:00" }, "bad time");
  bad({ startTime: "9:00" }, "unpadded time");
  bad({ endTime: "19:00" }, "end == start");
  bad({ startDate: "2026-02-30" }, "bad date");
  bad({ endDate: add(today, -1) }, "end < start");

  r = call({ action: "getLessons", token: a.token });
  t("student sees rule", r.data.rules.length === 1 && r.data.rules[0].startTime === "19:00" && !("rowNumber" in r.data.rules[0]) && !("studentId" in r.data.rules[0]));
  t("other student sees nothing", call({ action: "getLessons", token: b.token }).data.rules.length === 0);
  t("tutor sees", call({ action: "tutorGetLessons", tutorToken: tt, studentId: a.studentId }).data.rules[0].ruleId === rid);

  // 時刻がシートで時刻型・"9:00" になっていても読める
  sheets.lesson_rules.data[1][4] = "9:30";
  t("unpadded cell normalized", call({ action: "getLessons", token: a.token }).data.rules[0].endTime === "09:30");

  r = call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: a.studentId, rule: rule({ ruleId: rid, startTime: "18:00", endTime: "19:30" }) });
  t("edit rule", r.ok && sheets.lesson_rules.data[1][3] === "18:00" && sheets.lesson_rules.data.length === 2);
  t("edit other student's rule rejected", call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: b.studentId, rule: rule({ ruleId: rid }) }).error?.code === "VALIDATION_ERROR");

  // 休み
  const day = add(today, 3);
  const cancel = (o) => call(Object.assign({ action: "tutorSetLessonCancelled", tutorToken: tt, studentId: a.studentId, ruleId: rid, date: day, cancelled: true }, o));
  m.cache.clear();
  t("cancel", cancel().ok);
  t("cancel idempotent", cancel().ok && sheets.lesson_changes.data.length === 2);
  t("cancel visible", call({ action: "getLessons", token: a.token }).data.changes[0].kind === "cancel");
  t("cancel wrong weekday", cancel({ date: add(day, 1) }).error?.code === "VALIDATION_ERROR");
  t("cancel past beyond 3 months", cancel({ date: add(day, -98) }).error?.code === "VALIDATION_ERROR");
  t("cancel other student's rule", cancel({ studentId: b.studentId }).error?.code === "VALIDATION_ERROR");
  t("uncancel", cancel({ cancelled: false }).ok && sheets.lesson_changes.data.length === 1);

  // イレギュラーの授業
  const save = (lesson, extra) => call(Object.assign({ action: "tutorSaveLesson", tutorToken: tt, studentId: a.studentId, lesson: Object.assign({ date: add(today, 1), startTime: "10:00", endTime: "11:00", note: "" }, lesson) }, extra));
  m.cache.clear();
  r = save({ note: "テスト前" });
  t("add extra", r.ok && r.data.lessonId.startsWith("lesson_"), r);
  const lid = r.data.lessonId;
  t("extra past beyond 3 months rejected", save({ date: add(today, -100) }).error?.code === "VALIDATION_ERROR");
  t("extra too far", save({ date: add(today, 400) }).error?.code === "VALIDATION_ERROR");
  t("extra bad time", save({ endTime: "09:00" }).error?.code === "VALIDATION_ERROR");
  t("note too long", save({ note: "あ".repeat(41) }).error?.code === "VALIDATION_ERROR");
  r = save({ lessonId: lid, date: add(today, 2), startTime: "13:00", endTime: "14:00", note: "変更" });
  t("edit extra", r.ok && r.data.lessonId === lid && sheets.lesson_changes.data.length === 2 && sheets.lesson_changes.data[1][3] === add(today, 2) && sheets.lesson_changes.data[1][7] === "変更");
  t("edit other student's extra", call({ action: "tutorSaveLesson", tutorToken: tt, studentId: b.studentId, lesson: { lessonId: lid, date: add(today, 2), startTime: "13:00", endTime: "14:00" } }).error?.code === "VALIDATION_ERROR");

  // 振替: 追加と休みを1回で
  m.cache.clear();
  r = save({ date: add(day, 1), startTime: "19:00", endTime: "20:30", note: "振替" }, { replaces: { ruleId: rid, date: day } });
  t("move", r.ok, r);
  let data = call({ action: "getLessons", token: a.token }).data;
  t("move creates cancel + extra", data.changes.filter((c) => c.kind === "cancel" && c.date === day).length === 1 && data.changes.filter((c) => c.kind === "extra").length === 2);
  t("move to bad occurrence rejected", save({}, { replaces: { ruleId: rid, date: add(day, 2) } }).error?.code === "VALIDATION_ERROR");

  t("delete extra", call({ action: "tutorDeleteLesson", tutorToken: tt, studentId: a.studentId, lessonId: lid }).ok);
  t("delete extra twice", call({ action: "tutorDeleteLesson", tutorToken: tt, studentId: a.studentId, lessonId: lid }).error?.code === "VALIDATION_ERROR");

  // 毎週の授業を消すと、その休みも消える。振替の授業は残る
  m.cache.clear();
  t("delete rule", call({ action: "tutorDeleteLessonRule", tutorToken: tt, studentId: a.studentId, ruleId: rid }).ok);
  data = call({ action: "getLessons", token: a.token }).data;
  t("rule + its cancels gone, extra stays", data.rules.length === 0 && data.changes.length === 1 && data.changes[0].kind === "extra");

  // 上限
  for (let i = 0; i < 7; i++) call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: b.studentId, rule: rule({ weekday: i }) });
  m.cache.clear();
  t("max 7 rules", call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: b.studentId, rule: rule() }).error?.code === "VALIDATION_ERROR");

  // 過ぎた日の変更は返さない
  const m2 = createMock();
  const c = m2.gas.generateToken("テスト生徒C", "test-c");
  const t2 = m2.tutorLogin();
  m2.call({ action: "tutorSaveLesson", tutorToken: t2, studentId: c.studentId, lesson: { date: add(today, 1), startTime: "10:00", endTime: "11:00" } });
  m2.shiftDays(100);
  t("extra older than 3 months hidden", m2.call({ action: "getLessons", token: c.token }).data.changes.length === 0);

  // シートが無くても最初の利用で作られる
  const m3 = createMock();
  delete m3.sheets.lesson_rules; delete m3.sheets.lesson_changes;
  const d = m3.gas.generateToken("テスト生徒D", "test-d");
  t("auto-create sheets", m3.call({ action: "getLessons", token: d.token }).ok && m3.sheets.lesson_rules && m3.sheets.lesson_changes);
};
