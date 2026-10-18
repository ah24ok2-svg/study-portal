/**
 * 授業の予定（spec §15）。
 * 保存するのは「毎週の授業」（lesson_rules）と、その上に重ねる個別の変更（lesson_changes）だけ。
 * 個別の変更は 2 種類: extra（イレギュラーで足した授業）と cancel（毎週の授業のうちその日だけ休み）。
 * 日付ごとの一覧は docs/lessons.js が端末で展開する。毎週の時間を変えたときに、作っておいた一覧を直して回らなくて済むため
 */

const LESSON_RULES_PER_STUDENT_MAX = 7;
const LESSON_NOTE_MAX = 40;
const LESSON_AHEAD_DAYS_MAX = 366;
// 講師が過ぎた日の授業を直せる範囲。支払い期限が翌月末なので、先々月までの実施の有無を請求前に直せるようにする（spec §16）
const LESSON_PAST_DAYS_MAX = 92;
const TIME_KEY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 授業の予定は暦どおりの日付で扱う（計画のような朝6時の切り替えはしない） */
function lessonToday() {
  return Utilities.formatDate(new Date(Date.now()), "Asia/Tokyo", "yyyy-MM-dd");
}

/** 列を書式なしテキストにしていても、手で触ると時刻型になることがあるので必ず "HH:MM" に直す */
function toTimeKey(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return isNaN(value.getTime()) ? null : Utilities.formatDate(value, "Asia/Tokyo", "HH:mm");
  }
  // 手入力の "9:00" も読めるようにする
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const key = (m[1].length === 1 ? "0" : "") + m[1] + ":" + m[2];
  return TIME_KEY_PATTERN.test(key) ? key : null;
}

function ensureLessonSheets() {
  ensureSheets([SHEET.LESSON_RULES, SHEET.LESSON_CHANGES]);
}

function rowToRule(r) {
  const weekday = Number(r.values[2]);
  return {
    ruleId: String(r.values[0]),
    studentId: String(r.values[1]),
    weekday: weekday,
    startTime: toTimeKey(r.values[3]),
    endTime: toTimeKey(r.values[4]),
    startDate: toDateKey(r.values[5]),
    endDate: toDateKey(r.values[6]),
    rowNumber: r.rowNumber
  };
}

function isUsableRule(rule) {
  return Number.isInteger(rule.weekday) && rule.weekday >= 0 && rule.weekday <= 6 &&
    rule.startTime && rule.endTime && rule.startDate;
}

function rowToChange(r) {
  return {
    changeId: String(r.values[0]),
    studentId: String(r.values[1]),
    kind: String(r.values[2]),
    date: toDateKey(r.values[3]),
    startTime: toTimeKey(r.values[4]),
    endTime: toTimeKey(r.values[5]),
    ruleId: String(r.values[6] || ""),
    note: String(r.values[7] || ""),
    rowNumber: r.rowNumber
  };
}

function readRules(studentId) {
  return readRows(SHEET.LESSON_RULES)
    .map(rowToRule)
    .filter(function (x) { return x.studentId === studentId && isUsableRule(x); });
}

function readChanges(studentId) {
  return readRows(SHEET.LESSON_CHANGES)
    .map(rowToChange)
    .filter(function (c) { return c.studentId === studentId && c.date; });
}

function lessonsPayload(studentId) {
  const today = lessonToday();
  // 過ぎた日の変更も、請求の計算（spec §16）で使う範囲は返す
  const since = new Date(new Date(today + "T00:00:00Z").getTime() - LESSON_PAST_DAYS_MAX * 86400000).toISOString().slice(0, 10);
  const rules = readRules(studentId);
  const ruleIds = {};
  rules.forEach(function (x) { ruleIds[x.ruleId] = true; });
  const changes = readChanges(studentId)
    .filter(function (c) { return c.date >= since; })
    .filter(function (c) {
      if (c.kind === "extra") return c.startTime && c.endTime;
      return c.kind === "cancel" && ruleIds[c.ruleId];
    })
    .map(function (c) {
      return c.kind === "extra"
        ? { kind: "extra", lessonId: c.changeId, date: c.date, startTime: c.startTime, endTime: c.endTime, note: c.note }
        : { kind: "cancel", ruleId: c.ruleId, date: c.date };
    });
  return {
    rules: rules.map(function (x) {
      return { ruleId: x.ruleId, weekday: x.weekday, startTime: x.startTime, endTime: x.endTime, startDate: x.startDate, endDate: x.endDate };
    }),
    changes: changes,
    today: today
  };
}

// ---------------------------------------------------------------------------
// 生徒向け

function handleGetLessons(req) {
  const student = authenticate(req.token);
  ensureLessonSheets();
  return ok(lessonsPayload(student.studentId));
}

// ---------------------------------------------------------------------------
// 講師向け

function handleTutorGetLessons(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  return ok(lessonsPayload(student.studentId));
}

function validateLessonTimes(startTime, endTime) {
  if (typeof startTime !== "string" || typeof endTime !== "string" || !TIME_KEY_PATTERN.test(startTime) || !TIME_KEY_PATTERN.test(endTime)) {
    throw new AppError("VALIDATION_ERROR", "開始と終了の時刻を入力してください");
  }
  // 日付をまたぐ授業は想定しない。"HH:MM" は文字列のまま大小を比べられる
  if (endTime <= startTime) throw new AppError("VALIDATION_ERROR", "終了の時刻は開始より後にしてください");
}

/** 3か月前から1年先までの日付か。それより前は請求が済んでいるので直させない */
function validateLessonDate(date, label) {
  if (!isValidDateKey(date)) throw new AppError("VALIDATION_ERROR", label + "を入力してください");
  const today = lessonToday();
  if (daysBetween(date, today) > LESSON_PAST_DAYS_MAX) throw new AppError("VALIDATION_ERROR", "3か月より前の日は変更できません");
  if (daysBetween(today, date) > LESSON_AHEAD_DAYS_MAX) throw new AppError("VALIDATION_ERROR", "1年以内の日付にしてください");
}

function validateRuleInput(input) {
  if (!input || typeof input !== "object") throw new AppError("VALIDATION_ERROR", "毎週の授業の内容が正しくありません");
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new AppError("VALIDATION_ERROR", "曜日を選んでください");
  }
  validateLessonTimes(input.startTime, input.endTime);
  if (!isValidDateKey(input.startDate)) throw new AppError("VALIDATION_ERROR", "いつからの授業かを入力してください");
  const endDate = input.endDate === null || input.endDate === undefined || input.endDate === "" ? null : input.endDate;
  if (endDate !== null) {
    if (!isValidDateKey(endDate)) throw new AppError("VALIDATION_ERROR", "最後の日が正しくありません");
    if (endDate < input.startDate) throw new AppError("VALIDATION_ERROR", "最後の日は始める日以降にしてください");
  }
  return { weekday: input.weekday, startTime: input.startTime, endTime: input.endTime, startDate: input.startDate, endDate: endDate };
}

function handleTutorSaveLessonRule(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  const rule = validateRuleInput(req.rule);
  const ruleId = req.rule && typeof req.rule.ruleId === "string" && req.rule.ruleId ? req.rule.ruleId : null;
  const now = nowIso();
  const values = [rule.weekday, rule.startTime, rule.endTime, rule.startDate, rule.endDate || ""];

  const savedId = withLock(function () {
    const sheet = getSheet(SHEET.LESSON_RULES);
    const rules = readRows(SHEET.LESSON_RULES).map(rowToRule).filter(function (x) { return x.studentId === student.studentId; });
    if (ruleId) {
      const existing = rules.find(function (x) { return x.ruleId === ruleId; });
      if (!existing) throw new AppError("VALIDATION_ERROR", "毎週の授業が見つかりません。画面を開き直してください");
      sheet.getRange(existing.rowNumber, 3, 1, values.length).setValues([values]);
      sheet.getRange(existing.rowNumber, 9).setValue(now);
      return ruleId;
    }
    if (rules.length >= LESSON_RULES_PER_STUDENT_MAX) {
      throw new AppError("VALIDATION_ERROR", "毎週の授業は1人" + LESSON_RULES_PER_STUDENT_MAX + "件までです");
    }
    const id = newId("rule_");
    sheet.appendRow([id, student.studentId].concat(values).concat([now, now]));
    return id;
  });
  return ok({ ruleId: savedId });
}

/** 行を消すと下の行が繰り上がるので、下から消す */
function deleteRowsDescending(sheet, rowNumbers) {
  rowNumbers.slice().sort(function (a, b) { return b - a; }).forEach(function (n) { sheet.deleteRow(n); });
}

function handleTutorDeleteLessonRule(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  withLock(function () {
    const rule = readRows(SHEET.LESSON_RULES).map(rowToRule).find(function (x) {
      return x.ruleId === req.ruleId && x.studentId === student.studentId;
    });
    if (!rule) throw new AppError("VALIDATION_ERROR", "毎週の授業が見つかりません。画面を開き直してください");
    getSheet(SHEET.LESSON_RULES).deleteRow(rule.rowNumber);
    // この枠の「休み」は意味が無くなるので一緒に消す。振替で足した授業（extra）は別の授業として残す
    const cancels = readRows(SHEET.LESSON_CHANGES).map(rowToChange).filter(function (c) {
      return c.kind === "cancel" && c.ruleId === rule.ruleId;
    });
    deleteRowsDescending(getSheet(SHEET.LESSON_CHANGES), cancels.map(function (c) { return c.rowNumber; }));
  });
  return ok({});
}

/** 毎週の授業のうち、その日に本当に授業がある枠か。存在しない日を「休み」にできないようにする */
function findRuleOccurrence(studentId, ruleId, date) {
  const rule = typeof ruleId === "string"
    ? readRules(studentId).find(function (x) { return x.ruleId === ruleId; })
    : null;
  if (!rule) throw new AppError("VALIDATION_ERROR", "毎週の授業が見つかりません。画面を開き直してください");
  validateLessonDate(date, "日付");
  const weekday = new Date(date + "T00:00:00Z").getUTCDay();
  if (weekday !== rule.weekday || date < rule.startDate || (rule.endDate && date > rule.endDate)) {
    throw new AppError("VALIDATION_ERROR", "この日は毎週の授業の日ではありません。画面を開き直してください");
  }
  return rule;
}

function findCancelRows(studentId, ruleId, date) {
  return readRows(SHEET.LESSON_CHANGES).map(rowToChange).filter(function (c) {
    return c.studentId === studentId && c.kind === "cancel" && c.ruleId === ruleId && c.date === date;
  });
}

/**
 * イレギュラーの授業を足す・直す。
 * replaces を付けると、その毎週の授業を同時に休みにする（振替）。別々に呼ぶと片方だけ失敗したときに授業が二重になるため、1回で行う
 */
function handleTutorSaveLesson(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  const input = req.lesson;
  if (!input || typeof input !== "object") throw new AppError("VALIDATION_ERROR", "授業の内容が正しくありません");
  validateLessonDate(input.date, "日付");
  validateLessonTimes(input.startTime, input.endTime);
  const note = (typeof input.note === "string" ? input.note : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (Array.from(note).length > LESSON_NOTE_MAX) throw new AppError("VALIDATION_ERROR", "メモは" + LESSON_NOTE_MAX + "文字以内にしてください");
  const lessonId = typeof input.lessonId === "string" && input.lessonId ? input.lessonId : null;
  const replaces = req.replaces && typeof req.replaces === "object" ? req.replaces : null;
  if (replaces) findRuleOccurrence(student.studentId, replaces.ruleId, replaces.date);

  const now = nowIso();
  const savedId = withLock(function () {
    const sheet = getSheet(SHEET.LESSON_CHANGES);
    let id = lessonId;
    if (lessonId) {
      const existing = readRows(SHEET.LESSON_CHANGES).map(rowToChange).find(function (c) {
        return c.changeId === lessonId && c.studentId === student.studentId && c.kind === "extra";
      });
      if (!existing) throw new AppError("VALIDATION_ERROR", "授業が見つかりません。画面を開き直してください");
      sheet.getRange(existing.rowNumber, 4, 1, 3).setValues([[input.date, input.startTime, input.endTime]]);
      sheet.getRange(existing.rowNumber, 8).setValue(note);
      sheet.getRange(existing.rowNumber, 10).setValue(now);
    } else {
      id = newId("lesson_");
      sheet.appendRow([id, student.studentId, "extra", input.date, input.startTime, input.endTime, "", note, now, now]);
    }
    if (replaces && findCancelRows(student.studentId, replaces.ruleId, replaces.date).length === 0) {
      sheet.appendRow([newId("cancel_"), student.studentId, "cancel", replaces.date, "", "", replaces.ruleId, "", now, now]);
    }
    return id;
  });
  return ok({ lessonId: savedId });
}

function handleTutorDeleteLesson(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  withLock(function () {
    const lesson = readRows(SHEET.LESSON_CHANGES).map(rowToChange).find(function (c) {
      return c.changeId === req.lessonId && c.studentId === student.studentId && c.kind === "extra";
    });
    if (!lesson) throw new AppError("VALIDATION_ERROR", "授業が見つかりません。画面を開き直してください");
    getSheet(SHEET.LESSON_CHANGES).deleteRow(lesson.rowNumber);
  });
  return ok({});
}

/** 毎週の授業のうち、その日だけ休みにする／休みを取り消す */
function handleTutorSetLessonCancelled(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  const student = findActiveStudent(req.studentId);
  if (typeof req.cancelled !== "boolean") throw new AppError("VALIDATION_ERROR", "不正なリクエストです");
  const rule = findRuleOccurrence(student.studentId, req.ruleId, req.date);
  withLock(function () {
    const sheet = getSheet(SHEET.LESSON_CHANGES);
    const existing = findCancelRows(student.studentId, rule.ruleId, req.date);
    if (req.cancelled && existing.length === 0) {
      const now = nowIso();
      sheet.appendRow([newId("cancel_"), student.studentId, "cancel", req.date, "", "", rule.ruleId, "", now, now]);
    }
    if (!req.cancelled) deleteRowsDescending(sheet, existing.map(function (c) { return c.rowNumber; }));
  });
  return ok({});
}
