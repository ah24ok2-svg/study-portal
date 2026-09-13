/**
 * メッセージの取得・送信（spec §6.2, §6.3）
 */

const MESSAGE_MAX_LENGTH = 1000;
const MESSAGE_DEFAULT_LIMIT = 50;
// since 指定時でも、長期間開いていなかった端末で巨大なレスポンスにならないよう上限を設ける
const MESSAGE_SINCE_LIMIT = 200;
const UPLOAD_MESSAGE_PREFIX = "アップロード完了 ✅ ";

function handleGetMessages(req) {
  const student = authenticate(req.token);

  let since = null;
  if (req.since !== undefined && req.since !== null && req.since !== "") {
    since = toIso(req.since);
    if (!since) throw new AppError("VALIDATION_ERROR", "不正なリクエストです");
  }

  const mine = [];
  readRows(SHEET.MESSAGES).forEach(function (r) {
    if (r.values[1] !== student.studentId) return;
    const createdAt = toIso(r.values[4]);
    const sender = r.values[2];
    const body = String(r.values[3] || "");
    // 講師の手入力ミス（日時が空など）の行は、生徒側を壊さないよう読み飛ばす
    if (!createdAt || (sender !== "student" && sender !== "tutor") || body === "") return;
    mine.push({
      rowNumber: r.rowNumber,
      readByStudent: isTrue(r.values[5]),
      message: {
        // 講師が手で追加した行は message_id が空のことがあるので、行番号で代用する
        id: String(r.values[0] || "msg_row" + r.rowNumber),
        sender: sender,
        body: body,
        createdAt: createdAt,
        system: sender === "student" && body.indexOf(UPLOAD_MESSAGE_PREFIX) === 0
      }
    });
  });

  mine.sort(function (a, b) {
    return a.message.createdAt < b.message.createdAt ? -1 : a.message.createdAt > b.message.createdAt ? 1 : 0;
  });

  let result;
  if (since) {
    result = mine.filter(function (m) { return m.message.createdAt > since; }).slice(-MESSAGE_SINCE_LIMIT);
  } else {
    result = mine.slice(-MESSAGE_DEFAULT_LIMIT);
  }

  markTutorMessagesRead(result);

  return ok({ messages: result.map(function (m) { return m.message; }) });
}

/** 講師がシートで既読状況を確認できるようにする。未読が無ければ書き込まない（ポーリングのたびにロックを取らないため） */
function markTutorMessagesRead(items) {
  const unread = items.filter(function (m) { return m.message.sender === "tutor" && !m.readByStudent; });
  if (unread.length === 0) return;
  withLock(function () {
    const sheet = getSheet(SHEET.MESSAGES);
    unread.forEach(function (m) {
      // ロック取得までの間に行が消されている可能性があるので、IDが一致するときだけ更新する
      const current = sheet.getRange(m.rowNumber, 1, 1, 2).getValues()[0];
      const idMatches = String(current[0] || "msg_row" + m.rowNumber) === m.message.id;
      if (idMatches) sheet.getRange(m.rowNumber, 6).setValue(true);
    });
  });
}

function handleSendMessage(req) {
  const student = authenticate(req.token);
  if (typeof req.body !== "string") {
    throw new AppError("VALIDATION_ERROR", "メッセージを入力してください");
  }
  const body = req.body.trim();
  if (body === "") throw new AppError("VALIDATION_ERROR", "メッセージを入力してください");
  if (body.length > MESSAGE_MAX_LENGTH) {
    throw new AppError("VALIDATION_ERROR", "メッセージは" + MESSAGE_MAX_LENGTH + "文字以内で入力してください");
  }
  const saved = appendMessage(student.studentId, "student", body);
  notifyTutorSafely({ title: student.name + "さん", body: body, studentId: student.studentId });
  return ok({ id: saved.id, createdAt: saved.createdAt });
}

function appendMessage(studentId, sender, body) {
  const id = newId("msg_");
  const createdAt = nowIso();
  withLock(function () {
    // 自分が書いたメッセージは自分側では既読にしておく
    getSheet(SHEET.MESSAGES).appendRow([id, studentId, sender, body, createdAt, sender === "student", sender === "tutor"]);
  });
  return { id: id, createdAt: createdAt };
}
