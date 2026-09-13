/**
 * エントリポイントと共通ユーティリティ。
 * 各 action の処理は auth.js / messages.js / upload.js にある。
 */

const SHEET = {
  STUDENTS: "students",
  MESSAGES: "messages",
  SUBMISSIONS: "submissions"
};

const HEADERS = {
  students: ["student_id", "name", "name_slug", "token_hash", "folder_id", "active", "created_at"],
  messages: ["message_id", "student_id", "sender", "body", "created_at", "read_by_student", "read_by_tutor"],
  submissions: ["submission_id", "student_id", "file_id", "file_name", "mime_type", "size_bytes", "note", "created_at"]
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
      tutorRegisterPush: handleTutorRegisterPush,
      tutorUnregisterPush: handleTutorUnregisterPush,
      tutorTestPush: handleTutorTestPush
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
