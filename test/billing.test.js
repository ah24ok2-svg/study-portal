// 保護者アプリと授業料（docs/billing.js と gas/billing.js、spec §16）
const { createMock } = require("./mockgas");
const B = require("../docs/billing.js");

module.exports = function (t) {
  // ---- 計算（docs/billing.js）
  const at = (s) => new Date(s + "+09:00");
  t("school year", B.schoolYear("2026-04-01") === 2026 && B.schoolYear("2027-03-31") === 2026 && B.schoolYear("2027-04-01") === 2027);
  t("grade advances in april", B.gradeOn("2026:中2", "2026-10-01").label === "中2" && B.gradeOn("2026:中2", "2027-04-01").label === "中3");
  t("grade beyond 高3", B.gradeOn("2024:高3", "2026-10-01").label === "高校卒業後" && B.rateForGrade(B.gradeOn("2024:高3", "2026-10-01")) === 3000);
  t("rates", B.rateForGrade(B.gradeOn("2026:中1", "2026-10-01")) === 2000 && B.rateForGrade(B.gradeOn("2026:中2", "2026-10-01")) === 2000 &&
    B.rateForGrade(B.gradeOn("2026:中3", "2026-10-01")) === 3000 && B.rateForGrade(B.gradeOn("2026:高1", "2026-10-01")) === 3000 && B.rateForGrade(B.gradeOn("2026:小6", "2026-10-01")) === 2000);
  t("unset grade", B.gradeOn("", "2026-10-01") === null && B.gradeOn("中1", "2026-10-01") === null);
  t("due date = end of next month", B.dueDate("2026-10") === "2026-11-30" && B.dueDate("2026-12") === "2027-01-31" && B.dueDate("2027-01") === "2027-02-28");
  t("month end", B.monthEnd("2028-02") === "2028-02-29");

  // 2026-10 は木曜が 1,8,15,22,29。今は 10/19（月）
  const lessons = { rules: [{ ruleId: "r1", weekday: 4, startTime: "19:00", endTime: "20:30", startDate: "2026-09-01", endDate: null }], changes: [
    { kind: "cancel", ruleId: "r1", date: "2026-10-08" },
    { kind: "extra", lessonId: "x1", date: "2026-10-10", startTime: "10:00", endTime: "11:00", note: "振替" }
  ] };
  let b = B.monthBilling(lessons, "2026:中2", "2026-10", at("2026-10-19T12:00:00"));
  t("done lessons", b.doneCount === 3 && b.items.filter((x) => x.done).map((x) => x.date).join() === "2026-10-01,2026-10-10,2026-10-15", b.items);
  t("cancelled kept but not counted", b.items.some((x) => x.date === "2026-10-08" && x.cancelled && !x.done));
  t("planned lessons", b.plannedCount === 2 && b.amountDone === 6000 && b.amountPlanned === 4000 && b.amountTotal === 10000);
  t("not closed", !b.closed && b.dueDate === "2026-11-30");
  b = B.monthBilling(lessons, "2026:中3", "2026-09", at("2026-10-19T12:00:00"));
  t("closed month, senior rate", b.closed && b.doneCount === 4 && b.amountTotal === 12000 && b.plannedCount === 0);
  // 授業中は未実施、終わった時刻から実施
  t("ongoing not done", B.monthBilling(lessons, "2026:中2", "2026-10", at("2026-10-22T20:00:00")).doneCount === 3);
  t("ended is done", B.monthBilling(lessons, "2026:中2", "2026-10", at("2026-10-22T20:30:00")).doneCount === 4);
  t("no grade → no amount", B.monthBilling(lessons, "", "2026-10", at("2026-10-19T12:00:00")).amountTotal === 0);
  t("months to show", B.monthsToShow([{ month: "2026-03" }], at("2026-10-19T12:00:00")).join() === "2026-10,2026-09,2026-08,2026-07,2026-03");
  t("labels", B.yen(12000) === "¥12,000" && B.monthLabel("2026-10") === "2026年10月分");

  // ---- API（gas/billing.js）
  const m = createMock();
  const { call, sheets } = m;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const month = today.slice(0, 7);
  const a = m.gas.generateToken("テスト生徒A", "test-a");
  const b2 = m.gas.generateToken("テスト生徒B", "test-b");
  const tt = m.tutorLogin();

  t("students headers extended", sheets.students.data[0].length === 9 && sheets.students.data[0][8] === "parent_token_hash");

  // 学年
  let r = call({ action: "tutorSetGrade", tutorToken: tt, studentId: a.studentId, grade: "中2" });
  t("set grade", r.ok && /^\d{4}:中2$/.test(r.data.gradeBase) && sheets.students.data[1][7] === r.data.gradeBase, r);
  t("bad grade", call({ action: "tutorSetGrade", tutorToken: tt, studentId: a.studentId, grade: "中4" }).error?.code === "VALIDATION_ERROR");
  t("grade needs tutor", call({ action: "tutorSetGrade", tutorToken: a.token, studentId: a.studentId, grade: "中2" }).error?.code === "INVALID_TOKEN");

  // 保護者の合言葉
  r = call({ action: "tutorIssueParentToken", tutorToken: tt, studentId: a.studentId });
  t("issue parent token", r.ok && /^[a-z0-9]{16}$/.test(r.data.parentToken), r);
  const pt = r.data.parentToken;
  t("parent token hashed", !JSON.stringify(sheets.students.data).includes(pt) && sheets.students.data[1][8].length === 64);
  t("parent login", call({ action: "parentLogin", parentToken: pt }).data.name === "テスト生徒A");
  t("student token is not a parent token", call({ action: "parentLogin", parentToken: a.token }).error?.code === "INVALID_TOKEN");
  t("parent token is not a student token", call({ action: "login", token: pt }).error?.code === "INVALID_TOKEN");
  t("parent cannot read messages", call({ action: "getMessages", token: pt }).error?.code === "INVALID_TOKEN" && call({ action: "getMessages", parentToken: pt }).error?.code === "INVALID_TOKEN");
  t("parent cannot call tutor api", call({ action: "tutorListStudents", tutorToken: pt }).error?.code === "INVALID_TOKEN");

  // まとめて取得
  m.cache.clear();
  m.props.TUTOR_NAME = "テスト講師";
  m.props.PAYPAY_LINK = "https://qr.paypay.ne.jp/example";
  call({ action: "tutorSaveLessonRule", tutorToken: tt, studentId: a.studentId, rule: { weekday: new Date(today + "T00:00:00Z").getUTCDay(), startTime: "00:05", endTime: "00:10", startDate: today, endDate: null } });
  r = call({ action: "parentGetSummary", parentToken: pt });
  t("summary", r.ok && r.data.student.name === "テスト生徒A" && r.data.student.gradeBase.endsWith(":中2") && Array.isArray(r.data.plan.goals) &&
    r.data.lessons.rules.length === 1 && r.data.payments.length === 0 && r.data.tutorName === "テスト講師" && r.data.paypayLink.includes("paypay") && r.data.today === today, r);
  t("summary has no messages/submissions/photos", !("messages" in r.data) && !("submissions" in r.data) && r.data.plan.photos.length === 0);
  t("sheets created", !!sheets.payments);

  // 入金
  const pay = (o) => call(Object.assign({ action: "tutorConfirmPayment", tutorToken: tt, studentId: a.studentId, payment: Object.assign({ month: month, amount: 6000, lessonDates: [today], recipient: "" }, o) }));
  r = pay();
  t("confirm payment", r.ok && /^\d{6}-0001$/.test(r.data.receiptNo), r);
  const pid = r.data.paymentId;
  t("duplicate month rejected", pay().error?.code === "VALIDATION_ERROR");
  t("bad amount", pay({ month: "2026-01", amount: -1 }).error?.code === "VALIDATION_ERROR" && pay({ month: "2026-01", amount: 1.5 }).error?.code === "VALIDATION_ERROR");
  t("bad month", pay({ month: "2026-13" }).error?.code === "VALIDATION_ERROR");
  t("date outside month", pay({ month: "2026-01", lessonDates: [today] }).error?.code === "VALIDATION_ERROR");
  t("future paidAt", pay({ month: "2026-01", lessonDates: [], paidAt: "2999-01-01" }).error?.code === "VALIDATION_ERROR");
  t("payment needs tutor", call({ action: "tutorConfirmPayment", tutorToken: pt, studentId: a.studentId, payment: { month: "2026-01", amount: 0, lessonDates: [] } }).error?.code === "INVALID_TOKEN");
  m.cache.clear();
  r = call({ action: "parentGetSummary", parentToken: pt });
  t("parent sees payment", r.data.payments.length === 1 && r.data.payments[0].receiptNo.endsWith("-0001") && r.data.payments[0].paidAt === today && r.data.payments[0].amount === 6000 && !("rowNumber" in r.data.payments[0]));
  t("other student sees nothing", call({ action: "tutorGetLessons", tutorToken: tt, studentId: b2.studentId }).data.rules.length === 0);
  r = pay({ month: "2026-01", lessonDates: ["2026-01-08"] });
  t("receipt numbers increase", r.data.receiptNo === "202601-0002");
  t("cancel payment", call({ action: "tutorCancelPayment", tutorToken: tt, studentId: a.studentId, paymentId: pid }).ok && sheets.payments.data.length === 2);
  t("cancel other student's payment", call({ action: "tutorCancelPayment", tutorToken: tt, studentId: b2.studentId, paymentId: r.data.paymentId }).error?.code === "VALIDATION_ERROR");
  t("numbers not reused", pay({ month: "2026-02", lessonDates: [] }).data.receiptNo === "202602-0003");

  // 講師アプリの請求画面
  m.cache.clear();
  r = call({ action: "tutorGetBilling", tutorToken: tt, studentId: a.studentId });
  t("tutor billing", r.ok && r.data.gradeBase.endsWith(":中2") && r.data.parentTokenIssued === true && r.data.payments.length === 2 && r.data.paypayLinkSet === true && r.data.lessons.rules.length === 1, r);
  t("tutor billing other student", call({ action: "tutorGetBilling", tutorToken: tt, studentId: b2.studentId }).data.parentTokenIssued === false);
  t("tutor billing needs tutor", call({ action: "tutorGetBilling", tutorToken: pt, studentId: a.studentId }).error?.code === "INVALID_TOKEN");

  // 再発行で前の合言葉は無効
  m.cache.clear();
  const pt2 = call({ action: "tutorIssueParentToken", tutorToken: tt, studentId: a.studentId }).data.parentToken;
  t("reissue invalidates old", call({ action: "parentLogin", parentToken: pt }).error?.code === "INVALID_TOKEN" && call({ action: "parentLogin", parentToken: pt2 }).ok);

  // 過ぎた日の授業を直せる（3か月まで）
  const add = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
  m.cache.clear();
  t("past extra within 3 months ok", call({ action: "tutorSaveLesson", tutorToken: tt, studentId: a.studentId, lesson: { date: add(today, -30), startTime: "10:00", endTime: "11:00" } }).ok);
  t("past extra beyond 3 months rejected", call({ action: "tutorSaveLesson", tutorToken: tt, studentId: a.studentId, lesson: { date: add(today, -100), startTime: "10:00", endTime: "11:00" } }).error?.code === "VALIDATION_ERROR");
  t("past changes returned", call({ action: "tutorGetLessons", tutorToken: tt, studentId: a.studentId }).data.changes.some((c) => c.date === add(today, -30)));
};
