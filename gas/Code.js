/**
 * エントリポイントと共通ユーティリティ。
 * 各 action の処理は auth.js / messages.js / upload.js / tutor.js / push.js / plan.js / lessons.js / billing.js にある。
 */

const SHEET = {
  STUDENTS: "students",
  MESSAGES: "messages",
  SUBMISSIONS: "submissions",
  GOALS: "goals",
  GOAL_PROGRESS: "goal_progress",
  PLAN_PHOTOS: "plan_photos",
  LESSON_RULES: "lesson_rules",
  LESSON_CHANGES: "lesson_changes",
  PAYMENTS: "payments"
};

const HEADERS = {
  students: ["student_id", "name", "name_slug", "token_hash", "folder_id", "active", "created_at", "grade_base", "parent_token_hash"],
  messages: ["message_id", "student_id", "sender", "body", "created_at", "read_by_student", "read_by_tutor"],
  submissions: ["submission_id", "student_id", "file_id", "file_name", "mime_type", "size_bytes", "note", "created_at"],
  goals: ["goal_id", "student_id", "title", "start_page", "end_page", "start_date", "due_date", "rest_weekdays", "rest_dates", "active", "created_at", "updated_at", "spread_start"],
  goal_progress: ["progress_id", "goal_id", "student_id", "study_date", "through_page", "updated_at"],
  plan_photos: ["photo_id", "goal_id", "student_id", "study_date", "from_page", "to_page", "file_id", "created_at"],
  lesson_rules: ["rule_id", "student_id", "weekday", "start_time", "end_time", "start_date", "end_date", "created_at", "updated_at"],
  lesson_changes: ["change_id", "student_id", "kind", "date", "start_time", "end_time", "rule_id", "note", "created_at", "updated_at"],
  payments: ["payment_id", "student_id", "month", "amount", "lesson_count", "lesson_dates", "receipt_no", "recipient", "paid_at", "created_at"]
};

// Sheets が "2026-10-01" を日付型に、"[0,6]" 以外の値を数値に変えないよう、書式なしテキストにする列（spec §14.4）
const TEXT_COLUMNS = {
  goals: ["F:F", "G:G", "H:H", "I:I"],
  goal_progress: ["D:D"],
  plan_photos: ["D:D"],
  // "19:00" も時刻型に変えられてしまう
  lesson_rules: ["D:D", "E:E", "F:F", "G:G"],
  lesson_changes: ["D:D", "E:E", "F:F"],
  // "2026-10" も日付型に変えられてしまう
  payments: ["C:C", "G:G"]
};

const LOCK_TIMEOUT_MS = 10 * 1000;

function doPost(e) {
  try {
    const req = parseRequest(e);
    const handlers = {
      login: handleLogin,
      getMessages: handleGetMessages,
      sendMessage: handleSendMessage,
      upload: handleUpload,
      getSubmissions: handleGetSubmissions,
      getSubmissionFile: handleGetSubmissionFile,
      tutorLogin: handleTutorLogin,
      tutorLogout: handleTutorLogout,
      tutorListStudents: handleTutorListStudents,
      tutorGetThread: handleTutorGetThread,
      tutorSendMessage: handleTutorSendMessage,
      tutorGetSubmissionFile: handleTutorGetSubmissionFile,
      tutorRegisterPush: handleTutorRegisterPush,
      tutorUnregisterPush: handleTutorUnregisterPush,
      tutorTestPush: handleTutorTestPush,
      getPlan: handleGetPlan,
      setProgress: handleSetProgress,
      tutorGetPlan: handleTutorGetPlan,
      tutorSaveGoal: handleTutorSaveGoal,
      tutorDeleteGoal: handleTutorDeleteGoal,
      uploadPlanPhoto: handleUploadPlanPhoto,
      deletePlanPhoto: handleDeletePlanPhoto,
      getPlanPhoto: handleGetPlanPhoto,
      tutorGetPlanPhoto: handleTutorGetPlanPhoto,
      getLessons: handleGetLessons,
      tutorGetLessons: handleTutorGetLessons,
      tutorSaveLessonRule: handleTutorSaveLessonRule,
      tutorDeleteLessonRule: handleTutorDeleteLessonRule,
      tutorSaveLesson: handleTutorSaveLesson,
      tutorDeleteLesson: handleTutorDeleteLesson,
      tutorSetLessonCancelled: handleTutorSetLessonCancelled,
      parentLogin: handleParentLogin,
      parentGetSummary: handleParentGetSummary,
      tutorGetBilling: handleTutorGetBilling,
      tutorSaveBillingSettings: handleTutorSaveBillingSettings,
      tutorSetGrade: handleTutorSetGrade,
      tutorIssueParentToken: handleTutorIssueParentToken,
      tutorConfirmPayment: handleTutorConfirmPayment,
      tutorCancelPayment: handleTutorCancelPayment
    };
    const handler = Object.prototype.hasOwnProperty.call(handlers, req.action) ? handlers[req.action] : null;
    if (!handler) return json(fail("VALIDATION_ERROR", "不正なリクエストです"));
    return json(handler(req));
  } catch (err) {
    if (err instanceof AppError) {
      return json(fail(err.code, err.message));
    }
    // 詳細はログにだけ残し、レスポンスには含めない（spec §10-6）
    console.error(err && err.stack ? err.stack : err);
    return json(fail("INTERNAL_ERROR", "エラーが発生しました"));
  }
}

// ブラウザで URL を開いたときに生存確認できるようにする。情報は何も返さない
function doGet() {
  return json({ ok: true, data: {} });
}

function parseRequest(e) {
  if (!e || !e.postData || typeof e.postData.contents !== "string") {
    throw new AppError("VALIDATION_ERROR", "不正なリクエストです");
  }
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (_) {
    throw new AppError("VALIDATION_ERROR", "不正なリクエストです");
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    throw new AppError("VALIDATION_ERROR", "不正なリクエストです");
  }
  return req;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok(data) {
  return { ok: true, data: data };
}

function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

/** 生徒に見せてよいメッセージだけを持つ例外。これ以外の例外は INTERNAL_ERROR に丸める */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 未設定なら空文字。領収書の発行者名や PayPay のリンクなど、無くても他の機能が止まらない設定用 */
function getOptionalProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

function getProp(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error("Script Property " + key + " が未設定です");
  return value;
}

function getSheet(name) {
  const sheet = SpreadsheetApp.openById(getProp("SPREADSHEET_ID")).getSheetByName(name);
  if (!sheet) throw new Error("シート " + name + " がありません");
  return sheet;
}

/**
 * 後から足したシートが無ければ作る。追加したときに setup を実行し忘れても、
 * 生徒や講師の画面がエラーにならないようにするため
 */
function ensureSheets(names) {
  const ss = SpreadsheetApp.openById(getProp("SPREADSHEET_ID"));
  if (names.every(function (n) { return ss.getSheetByName(n); })) return;
  withLock(function () {
    names.forEach(function (name) {
      if (ss.getSheetByName(name)) return;
      const sheet = ss.insertSheet(name);
      sheet.setFrozenRows(1);
      (TEXT_COLUMNS[name] || []).forEach(function (a1) { sheet.getRange(a1).setNumberFormat("@"); });
      sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
    });
  });
}

/** ヘッダー行を除いた全行。行番号(1始まり)も併せて返す */
function readRows(sheetName) {
  const values = getSheet(sheetName).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({ rowNumber: i + 1, values: values[i] });
  }
  return rows;
}

/** 同時提出で行がずれないよう、シートへの書き込みは必ずこの中で行う（spec §4） */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new AppError("INTERNAL_ERROR", "混み合っています。少し待ってからもう一度お試しください");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 講師がシートに手入力した日時は Date 型になっていることがあるため、
 * 読み出し時に必ず ISO 文字列へ正規化する。解釈できなければ null
 */
function toIso(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value.trim());
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function isTrue(value) {
  return value === true || String(value).toUpperCase() === "TRUE";
}

function newId(prefix) {
  return prefix + Utilities.getUuid();
}
