// 学習計画の API（gas/plan.js、spec §14.3〜14.5）
const { createMock } = require("./mockgas");

module.exports = function (t) {
  const m = createMock();
  const { call, sheets } = m;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() - 6 * 3600 * 1000));
  const add = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
  const a = m.gas.generateToken("テスト生徒A", "test-a");
  const b = m.gas.generateToken("テスト生徒B", "test-b");
  const tt = m.tutorLogin();
  const goal = (o) => Object.assign({ title: "テキスト", startPage: 31, endPage: 130, startDate: today, dueDate: add(today, 9), restWeekdays: [0], restDates: [add(today, 3)] }, o);

  t("sheets created", sheets.goals && sheets.goal_progress && sheets.plan_photos);

  // 目標の作成と検証
  let r = call({ action: "tutorSaveGoal", tutorToken: tt, studentId: a.studentId, goal: goal() });
  t("create goal", r.ok && r.data.goalId.startsWith("goal_"), r);
  const gid = r.data.goalId;
  t("stored as json", sheets.goals.data[1][7] === "[0]");
  t("needs tutor", call({ action: "tutorSaveGoal", tutorToken: a.token, studentId: a.studentId, goal: goal() }).error?.code === "INVALID_TOKEN");
  const bad = (o, name) => t("reject " + name, call({ action: "tutorSaveGoal", tutorToken: tt, studentId: a.studentId, goal: goal(o) }).error?.code === "VALIDATION_ERROR");
  bad({ title: "" }, "empty title");
  bad({ title: "あ".repeat(41) }, "long title");
  bad({ startPage: 0 }, "page 0");
  bad({ startPage: 50, endPage: 40 }, "end<start");
  bad({ startPage: "1" }, "string page");
  bad({ dueDate: add(today, -1) }, "due<start");
  bad({ dueDate: add(today, 400) }, "too long");
  bad({ dueDate: "2026-02-30" }, "invalid date");
  bad({ restWeekdays: [0, 1, 2, 3, 4, 5, 6] }, "all weekdays rest");
  bad({ dueDate: today, restDates: [today] }, "no study day");

  // 取得
  r = call({ action: "getPlan", token: a.token });
  t("student get plan", r.ok && r.data.goals.length === 1 && r.data.today === today && Array.isArray(r.data.photos), r);
  t("no internal fields", !("rowNumber" in r.data.goals[0]) && !("studentId" in r.data.goals[0]));
  t("other student sees nothing", call({ action: "getPlan", token: b.token }).data.goals.length === 0);
  t("tutor get plan", call({ action: "tutorGetPlan", tutorToken: tt, studentId: a.studentId }).data.goals[0].goalId === gid);

  // 進捗の記録
  const sp = (o) => call(Object.assign({ action: "setProgress", token: a.token, goalId: gid, studyDate: today, throughPage: 40 }, o));
  t("check today", sp().ok);
  t("upsert same day", sp({ throughPage: 45 }).ok && sheets.goal_progress.data.length === 2);
  t("future (前倒し)", sp({ studyDate: add(today, 1), throughPage: 60 }).ok);
  t("uncheck future", sp({ studyDate: add(today, 1), throughPage: null }).ok && sheets.goal_progress.data.length === 2);
  t("past rejected", sp({ studyDate: add(today, -1) }).error?.code === "VALIDATION_ERROR");
  t("after due rejected", sp({ studyDate: add(today, 20) }).error?.code === "VALIDATION_ERROR");
  t("page out of range", sp({ throughPage: 29 }).error?.code === "VALIDATION_ERROR" && sp({ throughPage: 131 }).error?.code === "VALIDATION_ERROR");
  t("non-integer page", sp({ throughPage: 40.5 }).error?.code === "VALIDATION_ERROR");
  t("other student's goal", call({ action: "setProgress", token: b.token, goalId: gid, studyDate: today, throughPage: 40 }).error?.code === "VALIDATION_ERROR");

  // シートが日付型に変換してしまっても読める
  sheets.goal_progress.data[1][3] = new m.CtxDate(today + "T00:00:00+09:00");
  t("date cell normalized", call({ action: "getPlan", token: a.token }).data.progress[0].studyDate === today);

  // 外すのは後の日から順番に（spec §14.3）
  m.cache.clear();
  t("order: tomorrow 50", sp({ studyDate: add(today, 1), throughPage: 50 }).ok);
  t("order: increase earlier ok", sp({ throughPage: 46 }).ok);
  t("order: decrease earlier rejected", /後の日/.test(sp({ throughPage: 40 }).error?.message || ""));
  t("order: delete earlier rejected", sp({ throughPage: null }).error?.code === "VALIDATION_ERROR");
  t("order: later first then earlier", sp({ studyDate: add(today, 1), throughPage: null }).ok && sp({ throughPage: null }).ok);

  // 編集と削除
  r = call({ action: "tutorSaveGoal", tutorToken: tt, studentId: a.studentId, goal: goal({ goalId: gid, title: "テキストII", endPage: 150 }) });
  t("edit", r.ok && sheets.goals.data[1][2] === "テキストII" && sheets.goals.data[1][4] === 150);
  t("edit other student's goal rejected", call({ action: "tutorSaveGoal", tutorToken: tt, studentId: b.studentId, goal: goal({ goalId: gid }) }).error?.code === "VALIDATION_ERROR");
  t("delete", call({ action: "tutorDeleteGoal", tutorToken: tt, goalId: gid }).ok && sheets.goals.data[1][9] === false);
  t("deleted hidden", call({ action: "getPlan", token: a.token }).data.goals.length === 0);
  t("progress on deleted goal rejected", sp().error?.code === "VALIDATION_ERROR");

  // 上限
  m.cache.clear();
  for (let i = 0; i < 10; i++) call({ action: "tutorSaveGoal", tutorToken: tt, studentId: b.studentId, goal: goal({ title: "t" + i }) });
  t("max 10 goals", call({ action: "tutorSaveGoal", tutorToken: tt, studentId: b.studentId, goal: goal({ title: "11" }) }).error?.code === "VALIDATION_ERROR");

  // シートが無くても最初の利用で作られる
  const m2 = createMock();
  delete m2.sheets.goals; delete m2.sheets.goal_progress; delete m2.sheets.plan_photos;
  const c = m2.gas.generateToken("テスト生徒C", "test-c");
  t("auto-create sheets", m2.call({ action: "getPlan", token: c.token }).ok && m2.sheets.goals && m2.sheets.plan_photos);

  // 朝6時を過ぎて日付が変わると、前の日は変更不可になる
  const m3 = createMock();
  const s3 = m3.gas.generateToken("テスト生徒D", "test-d");
  const g3 = m3.call({ action: "tutorSaveGoal", tutorToken: m3.tutorLogin(), studentId: s3.studentId, goal: goal({ restWeekdays: [], restDates: [] }) }).data.goalId;
  t("before shift ok", m3.call({ action: "setProgress", token: s3.token, goalId: g3, studyDate: today, throughPage: 33 }).ok);
  m3.shiftDays(1);
  t("server today advanced", m3.call({ action: "getPlan", token: s3.token }).data.today === add(today, 1));
  t("yesterday now locked", m3.call({ action: "setProgress", token: s3.token, goalId: g3, studyDate: today, throughPage: 35 }).error?.code === "VALIDATION_ERROR");
};
