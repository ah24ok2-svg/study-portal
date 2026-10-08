// 提出・メッセージ・講師アプリ・通知の主要な流れ（spec §6, §13）
const { createMock } = require("./mockgas");

module.exports = function (t) {
  const m = createMock();
  const { call, sheets } = m;
  const pdf = (s) => Buffer.from("%PDF-1.4\n" + s + " padding-bytes").toString("base64");
  const a = m.gas.generateToken("テスト生徒A", "test-a");
  const b = m.gas.generateToken("テスト生徒B", "test-b");

  t("token hashed", !JSON.stringify(sheets.students.data).includes(a.token));
  t("student login", call({ action: "login", token: a.token }).data.name === "テスト生徒A");
  t("bad login", call({ action: "login", token: "aaaaaaaaaaaaaaaa" }).error.code === "INVALID_TOKEN");
  t("unknown action", call({ action: "nope", token: a.token }).error.code === "VALIDATION_ERROR");
  t("send message", call({ action: "sendMessage", token: a.token, body: "質問です" }).ok);
  t("message length", call({ action: "sendMessage", token: a.token, body: "a".repeat(1001) }).error.code === "VALIDATION_ERROR");
  t("get messages", call({ action: "getMessages", token: a.token }).data.messages.at(-1).body === "質問です");

  let r = call({ action: "upload", token: a.token, fileName: "答案.pdf", mimeType: "application/pdf", dataBase64: pdf("v1"), pageCount: 2 });
  t("upload", r.ok && /_test-a_答案\.pdf$/.test(r.data.fileName), r);
  const subId = r.data.submissionId;
  t("dedupe name", /_2\.pdf$/.test(call({ action: "upload", token: a.token, fileName: "答案.pdf", mimeType: "application/pdf", dataBase64: pdf("v2") }).data.fileName));
  t("magic check", call({ action: "upload", token: a.token, fileName: "x.pdf", mimeType: "application/pdf", dataBase64: Buffer.alloc(40, 1).toString("base64") }).error.code === "UNSUPPORTED_TYPE");
  t("ext check", call({ action: "upload", token: a.token, fileName: "x.png", mimeType: "application/pdf", dataBase64: pdf("v3") }).error.code === "UNSUPPORTED_TYPE");
  t("submissions", call({ action: "getSubmissions", token: a.token }).data.submissions.length === 2);
  t("open own file", call({ action: "getSubmissionFile", token: a.token, submissionId: subId }).ok);
  t("cannot open other's file", call({ action: "getSubmissionFile", token: b.token, submissionId: subId }).error.code === "VALIDATION_ERROR");

  const tt = m.tutorLogin();
  t("tutor login", /^[a-z0-9]{32}$/.test(tt));
  t("tutor login wrong email", call({ action: "tutorLogin", idToken: "mock|evil@example.com|" + "n".repeat(20) + "|" + m.CLIENT_ID, nonce: "n".repeat(20) }).error.code === "INVALID_TOKEN");
  r = call({ action: "tutorListStudents", tutorToken: tt });
  t("tutor list + unread", r.ok && r.data.students.find((s) => s.name === "テスト生徒A").unreadCount === 3, r);
  r = call({ action: "tutorGetThread", tutorToken: tt, studentId: a.studentId });
  t("tutor thread", r.ok && r.data.messages.length === 3 && r.data.submissions.length === 2);
  t("tutor reply", call({ action: "tutorSendMessage", tutorToken: tt, studentId: a.studentId, body: "見ました" }).ok);
  t("reply visible", call({ action: "getMessages", token: a.token }).data.messages.at(-1).body === "見ました");
  t("student token on tutor api", call({ action: "tutorListStudents", tutorToken: a.token }).error.code === "INVALID_TOKEN");

  t("register push", call({ action: "tutorRegisterPush", tutorToken: tt, fcmToken: "tok_" + "x".repeat(100) }).ok);
  t("message triggers push", call({ action: "sendMessage", token: a.token, body: "通知テスト" }).ok && m.fetchLog.some((f) => f.url.includes("fcm.googleapis.com")));
};
