/**
 * 講師アプリ用の認証と API（spec §13）
 */

const TUTOR_TOKEN_PATTERN = /^[a-z0-9]{32}$/;
const TUTOR_SESSION_DAYS = 30;
const TUTOR_SESSION_PREFIX = "tutor_session_";
const TUTOR_THREAD_LIMIT = 200;

/**
 * Google の ID トークンを検証して講師セッションを発行する。
 * ID トークンは1時間で切れ、iOS のホーム画面アプリで毎回ログインさせるのは酷なので、
 * 検証後は30日有効な独自トークンに置き換える
 */
function handleTutorLogin(req) {
  const cache = CacheService.getScriptCache();
  if (cache.get("auth_lock")) {
    throw new AppError("RATE_LIMITED", "しばらく時間をおいてからお試しください");
  }
  if (typeof req.idToken !== "string" || typeof req.nonce !== "string" || req.idToken.length > 4096 || req.nonce.length < 16) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "ログインできませんでした");
  }

  const info = fetchTokenInfo(req.idToken);
  const tutorEmail = getProp("TUTOR_EMAIL").trim().toLowerCase();
  const valid = info &&
    info.aud === getProp("GOOGLE_CLIENT_ID") &&
    String(info.email || "").toLowerCase() === tutorEmail &&
    String(info.email_verified) === "true" &&
    Number(info.exp) * 1000 > Date.now() &&
    // nonce を照合しないと、盗まれた ID トークンを別のログインに流用できてしまう
    info.nonce === req.nonce;
  if (!valid) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "このGoogleアカウントでは講師としてログインできません");
  }

  const tutorToken = createRandomToken() + createRandomToken();
  const expiresAt = Date.now() + TUTOR_SESSION_DAYS * 24 * 60 * 60 * 1000;
  const props = PropertiesService.getScriptProperties();
  removeExpiredTutorSessions(props);
  props.setProperty(TUTOR_SESSION_PREFIX + hashToken(tutorToken), String(expiresAt));

  return ok({ tutorToken: tutorToken, email: tutorEmail, expiresAt: new Date(expiresAt).toISOString() });
}

function fetchTokenInfo(idToken) {
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), {
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  try {
    return JSON.parse(res.getContentText());
  } catch (_) {
    return null;
  }
}

function removeExpiredTutorSessions(props) {
  const all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(TUTOR_SESSION_PREFIX) === 0 && Number(all[key]) < Date.now()) {
      props.deleteProperty(key);
    }
  });
}

/** 講師 API の入口。生徒の token では通らないよう、別フィールドの tutorToken だけを見る */
function authenticateTutor(tutorToken) {
  const cache = CacheService.getScriptCache();
  if (cache.get("auth_lock")) {
    throw new AppError("RATE_LIMITED", "しばらく時間をおいてからお試しください");
  }
  if (typeof tutorToken !== "string" || !TUTOR_TOKEN_PATTERN.test(tutorToken)) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "もう一度ログインしてください");
  }
  const tokenHash = hashToken(tutorToken);
  enforceRateLimit(cache, tokenHash);
  const expiresAt = Number(PropertiesService.getScriptProperties().getProperty(TUTOR_SESSION_PREFIX + tokenHash));
  if (!expiresAt || expiresAt < Date.now()) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "もう一度ログインしてください");
  }
  return { tokenHash: tokenHash };
}

function handleTutorLogout(req) {
  const session = authenticateTutor(req.tutorToken);
  PropertiesService.getScriptProperties().deleteProperty(TUTOR_SESSION_PREFIX + session.tokenHash);
  return ok({});
}

/** 空欄は既読扱い。read_by_tutor 列を追加する前のメッセージを未読として大量に出さないため */
function isUnreadByTutor(values) {
  return values[2] === "student" && (values[6] === false || String(values[6]).toUpperCase() === "FALSE");
}

function handleTutorListStudents(req) {
  authenticateTutor(req.tutorToken);

  const summary = {};
  readRows(SHEET.MESSAGES).forEach(function (r) {
    const sid = r.values[1];
    const createdAt = toIso(r.values[4]);
    if (!createdAt) return;
    const s = summary[sid] || (summary[sid] = { unreadCount: 0, lastActivityAt: null, lastMessage: "" });
    if (isUnreadByTutor(r.values)) s.unreadCount++;
    if (!s.lastActivityAt || createdAt > s.lastActivityAt) {
      s.lastActivityAt = createdAt;
      s.lastMessage = String(r.values[3] || "").slice(0, 60);
    }
  });

  const students = readRows(SHEET.STUDENTS)
    .filter(function (r) { return isTrue(r.values[5]); })
    .map(function (r) {
      const s = summary[r.values[0]] || { unreadCount: 0, lastActivityAt: null, lastMessage: "" };
      return {
        studentId: String(r.values[0]),
        name: String(r.values[1]),
        unreadCount: s.unreadCount,
        lastActivityAt: s.lastActivityAt,
        lastMessage: s.lastMessage
      };
    });
  students.sort(function (a, b) {
    return (b.lastActivityAt || "").localeCompare(a.lastActivityAt || "");
  });
  return ok({ students: students });
}

function findActiveStudent(studentId) {
  if (typeof studentId !== "string") throw new AppError("VALIDATION_ERROR", "生徒が見つかりません");
  const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[0] === studentId; });
  if (!row) throw new AppError("VALIDATION_ERROR", "生徒が見つかりません");
  return { studentId: String(row.values[0]), name: String(row.values[1]), folderId: String(row.values[4] || "") };
}

function handleTutorGetThread(req) {
  authenticateTutor(req.tutorToken);
  const student = findActiveStudent(req.studentId);

  const unreadRows = [];
  const messages = [];
  readRows(SHEET.MESSAGES).forEach(function (r) {
    if (r.values[1] !== student.studentId) return;
    const createdAt = toIso(r.values[4]);
    const sender = r.values[2];
    const body = String(r.values[3] || "");
    if (!createdAt || (sender !== "student" && sender !== "tutor") || body === "") return;
    if (isUnreadByTutor(r.values)) unreadRows.push(r.rowNumber);
    messages.push({
      id: String(r.values[0] || "msg_row" + r.rowNumber),
      sender: sender,
      body: body,
      createdAt: createdAt,
      system: sender === "student" && body.indexOf(UPLOAD_MESSAGE_PREFIX) === 0
    });
  });
  messages.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });

  if (unreadRows.length > 0) {
    withLock(function () {
      const sheet = getSheet(SHEET.MESSAGES);
      unreadRows.forEach(function (rowNumber) {
        // ロック待ちの間に行が並べ替えられていないか確認してから既読にする
        const current = sheet.getRange(rowNumber, 2, 1, 2).getValues()[0];
        if (current[0] === student.studentId && current[1] === "student") sheet.getRange(rowNumber, 7).setValue(true);
      });
    });
  }

  const fileStates = readFolderFileStates(student.folderId);
  const submissions = readRows(SHEET.SUBMISSIONS)
    .filter(function (r) { return r.values[1] === student.studentId; })
    .map(function (r) {
      const fileId = String(r.values[2]);
      const createdAt = toIso(r.values[7]) || "";
      const state = describeSubmissionFile(fileStates, fileId, createdAt);
      return {
        id: String(r.values[0]),
        fileName: String(r.values[3]),
        sizeBytes: Number(r.values[5]) || 0,
        note: String(r.values[6] || ""),
        createdAt: createdAt,
        available: state.available,
        annotated: state.annotated
      };
    });
  submissions.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });

  return ok({
    student: { studentId: student.studentId, name: student.name },
    messages: messages.slice(-TUTOR_THREAD_LIMIT),
    submissions: submissions.slice(0, SUBMISSIONS_LIMIT)
  });
}

function handleTutorSendMessage(req) {
  authenticateTutor(req.tutorToken);
  const student = findActiveStudent(req.studentId);
  if (typeof req.body !== "string" || req.body.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "メッセージを入力してください");
  }
  const body = req.body.trim();
  if (body.length > MESSAGE_MAX_LENGTH) {
    throw new AppError("VALIDATION_ERROR", "メッセージは" + MESSAGE_MAX_LENGTH + "文字以内で入力してください");
  }
  const saved = appendMessage(student.studentId, "tutor", body);
  return ok({ id: saved.id, createdAt: saved.createdAt });
}
