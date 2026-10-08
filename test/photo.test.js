// 取り組んだページの写真（gas/plan.js、spec §14.7）
const { createMock } = require("./mockgas");

module.exports = function (t) {
  const m = createMock();
  const { call, sheets, files } = m;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() - 6 * 3600 * 1000));
  const add = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
  const a = m.gas.generateToken("テスト生徒A", "test-a");
  const b = m.gas.generateToken("テスト生徒B", "test-b");
  const tt = m.tutorLogin();
  const gid = call({ action: "tutorSaveGoal", tutorToken: tt, studentId: a.studentId, goal: { title: "テキスト/数学", startPage: 50, endPage: 99, startDate: today, dueDate: add(today, 9), restWeekdays: [], restDates: [] } }).data.goalId;
  const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("dummy-jpeg-" + tag + "-padding")]).toString("base64");
  const up = (o) => call(Object.assign({ action: "uploadPlanPhoto", token: a.token, goalId: gid, studyDate: today, fromPage: 50, toPage: 51, dataBase64: jpeg("1") }, o));

  let r = up();
  t("upload", r.ok && r.data.photoId.startsWith("photo_"), r);
  const pid = r.data.photoId;
  t("row stored", sheets.plan_photos.data.length === 2 && sheets.plan_photos.data[1][3] === today && sheets.plan_photos.data[1][4] === 50);
  const saved = Object.values(files).find((x) => x.f.id === sheets.plan_photos.data[1][6]).f;
  t("file in 計画の写真 folder", m.folders[saved.folder].folder.name === "計画の写真");
  t("file name", /^\d{8}_test-a_テキスト数学_p50-51\.jpg$/.test(saved.name), saved.name);
  t("listed in getPlan", call({ action: "getPlan", token: a.token }).data.photos.some((p) => p.photoId === pid && p.fromPage === 50 && p.toPage === 51));
  t("listed for tutor", call({ action: "tutorGetPlan", tutorToken: tt, studentId: a.studentId }).data.photos.length === 1);
  t("no file id leaked", !JSON.stringify(call({ action: "getPlan", token: a.token })).includes("file"));

  // 撮り直し: 同じ枠は置き換え、前のファイルはゴミ箱
  r = up({ dataBase64: jpeg("2") });
  t("retake keeps id", r.ok && r.data.photoId === pid && sheets.plan_photos.data.length === 2);
  t("old file trashed", saved.trashed === true);
  t("single page spread", up({ fromPage: 52, toPage: 52 }).ok && sheets.plan_photos.data.length === 3);

  // 検証
  t("reject 3 pages", up({ fromPage: 50, toPage: 52 }).error?.code === "VALIDATION_ERROR");
  t("reject reversed", up({ fromPage: 51, toPage: 50 }).error?.code === "VALIDATION_ERROR");
  t("reject out of range", up({ fromPage: 49, toPage: 50 }).error?.code === "VALIDATION_ERROR" && up({ fromPage: 99, toPage: 100 }).error?.code === "VALIDATION_ERROR");
  t("reject non-jpeg", up({ dataBase64: Buffer.from("%PDF-1.4 not a photo at all").toString("base64") }).error?.code === "UNSUPPORTED_TYPE");
  t("reject past day", up({ studyDate: add(today, -1) }).error?.code === "VALIDATION_ERROR");
  t("future day ok (前倒し)", up({ studyDate: add(today, 1), fromPage: 56, toPage: 57 }).ok);
  t("reject other student's goal", call({ action: "uploadPlanPhoto", token: b.token, goalId: gid, studyDate: today, fromPage: 50, toPage: 51, dataBase64: jpeg("x") }).error?.code === "VALIDATION_ERROR");
  t("reject too large", up({ dataBase64: "A".repeat(Math.ceil((10 * 1024 * 1024 + 10) / 3) * 4) }).error?.code === "FILE_TOO_LARGE");

  // 表示
  r = call({ action: "getPlanPhoto", token: a.token, photoId: pid });
  t("student view own", r.ok && r.data.mimeType === "image/jpeg" && Buffer.from(r.data.dataBase64, "base64").toString().includes("dummy-jpeg-2"));
  t("other student cannot view", call({ action: "getPlanPhoto", token: b.token, photoId: pid }).error?.code === "VALIDATION_ERROR");
  t("tutor view", call({ action: "tutorGetPlanPhoto", tutorToken: tt, photoId: pid }).ok);
  t("student token cannot use tutor api", call({ action: "tutorGetPlanPhoto", tutorToken: a.token, photoId: pid }).error?.code === "INVALID_TOKEN");

  // 削除
  t("other student cannot delete", call({ action: "deletePlanPhoto", token: b.token, photoId: pid }).error?.code === "VALIDATION_ERROR");
  const current = Object.values(files).find((x) => x.f.id === sheets.plan_photos.data.find((row) => row[0] === pid)[6]).f;
  t("delete", call({ action: "deletePlanPhoto", token: a.token, photoId: pid }).ok && !sheets.plan_photos.data.some((row) => row[0] === pid));
  t("deleted file trashed", current.trashed === true);

  // 日付が変わると前の日の写真は消せない
  const p2 = up({ fromPage: 54, toPage: 55 }).data.photoId;
  m.shiftDays(1);
  m.cache.clear();
  t("past photo delete rejected", call({ action: "deletePlanPhoto", token: a.token, photoId: p2 }).error?.code === "VALIDATION_ERROR");
  t("past photo still viewable", call({ action: "getPlanPhoto", token: a.token, photoId: p2 }).ok);

  // 目標を消すと写真も返さない
  m.cache.clear();
  call({ action: "tutorDeleteGoal", tutorToken: tt, goalId: gid });
  t("deleted goal hides photos", call({ action: "getPlan", token: a.token }).data.photos.length === 0);
};
