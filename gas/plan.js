/**
 * 学習計画（spec §14）。
 * 日ごとの割り当てはサーバーでは計算しない（docs/plan.js が端末で計算する）。ここは目標と進捗の保存だけを担う
 */

const PLAN_DAY_START_HOUR = 6;
const GOAL_TITLE_MAX = 40;
const GOAL_PAGE_MAX = 10000;
const GOAL_MAX_DAYS = 366;
const GOAL_REST_DATES_MAX = 100;
const GOALS_PER_STUDENT_MAX = 10;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 朝6時で切り替わる「勉強の日付」。端末の時計がずれていても、記録の可否はこの日付で判断する */
function planToday() {
  return Utilities.formatDate(new Date(Date.now() - PLAN_DAY_START_HOUR * 60 * 60 * 1000), "Asia/Tokyo", "yyyy-MM-dd");
}

/** 列を書式なしテキストにしていても、手で触ると日付型になることがあるので必ず文字列に直す */
function toDateKey(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return isNaN(value.getTime()) ? null : Utilities.formatDate(value, "Asia/Tokyo", "yyyy-MM-dd");
  }
  const s = String(value || "").trim();
  return isValidDateKey(s) ? s : null;
}

function isValidDateKey(s) {
  if (typeof s !== "string" || !DATE_KEY_PATTERN.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}

function parseJsonArray(value) {
  try {
    const v = JSON.parse(String(value || "[]"));
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function rowToGoal(r) {
  return {
    goalId: String(r.values[0]),
    studentId: String(r.values[1]),
    title: String(r.values[2] || ""),
    startPage: Number(r.values[3]),
    endPage: Number(r.values[4]),
    startDate: toDateKey(r.values[5]),
    dueDate: toDateKey(r.values[6]),
    restWeekdays: parseJsonArray(r.values[7]).filter(function (n) { return Number.isInteger(n) && n >= 0 && n <= 6; }),
    restDates: parseJsonArray(r.values[8]).filter(isValidDateKey),
    active: isTrue(r.values[9]),
    rowNumber: r.rowNumber
  };
}

/** 生徒に返す形。行番号などの内部情報は落とす */
function publicGoal(g) {
  return {
    goalId: g.goalId, title: g.title, startPage: g.startPage, endPage: g.endPage,
    startDate: g.startDate, dueDate: g.dueDate, restWeekdays: g.restWeekdays, restDates: g.restDates
  };
}

/**
 * 計画用のシートが無ければ作る。追加したときに setup を実行し忘れても、
 * 生徒や講師の画面がエラーにならないようにするため
 */
function ensurePlanSheets() {
  const ss = SpreadsheetApp.openById(getProp("SPREADSHEET_ID"));
  const names = [SHEET.GOALS, SHEET.GOAL_PROGRESS, SHEET.PLAN_PHOTOS];
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

function readGoals(studentId) {
  return readRows(SHEET.GOALS)
    .map(rowToGoal)
    .filter(function (g) { return g.studentId === studentId && g.active && g.startDate && g.dueDate; });
}

function readProgress(studentId) {
  return readRows(SHEET.GOAL_PROGRESS)
    .filter(function (r) { return r.values[2] === studentId; })
    .map(function (r) {
      return { goalId: String(r.values[1]), studyDate: toDateKey(r.values[3]), throughPage: Number(r.values[4]) };
    })
    .filter(function (p) { return p.studyDate && Number.isFinite(p.throughPage); });
}

function planPayload(studentId) {
  const goals = readGoals(studentId);
  const ids = {};
  goals.forEach(function (g) { ids[g.goalId] = true; });
  return {
    goals: goals.map(publicGoal),
    // 削除した目標の記録は返さない（記録自体は消さずに残す）
    progress: readProgress(studentId).filter(function (p) { return ids[p.goalId]; }),
    photos: readPhotos(studentId)
      .filter(function (p) { return ids[p.goalId]; })
      .map(function (p) { return { photoId: p.photoId, goalId: p.goalId, studyDate: p.studyDate, fromPage: p.fromPage, toPage: p.toPage }; }),
    today: planToday()
  };
}

// ---------------------------------------------------------------------------
// 生徒向け

function handleGetPlan(req) {
  const student = authenticate(req.token);
  ensurePlanSheets();
  return ok(planPayload(student.studentId));
}

/**
 * 生徒が記録（チェック・写真）を変えてよい目標と日付かを確かめ、目標を返す。
 * 他の生徒の目標を指定されても、存在するかどうかを区別できない応答にする
 */
function editableGoal(student, goalId, studyDate) {
  const goal = typeof goalId === "string"
    ? readGoals(student.studentId).find(function (g) { return g.goalId === goalId; })
    : null;
  if (!goal) throw new AppError("VALIDATION_ERROR", "目標が見つかりません。画面を開き直してください");

  const today = planToday();
  if (!isValidDateKey(studyDate)) throw new AppError("VALIDATION_ERROR", "日付が正しくありません");
  // 過ぎた日を後から変えると今日のノルマが変わってしまうので受け付けない（spec §14.3）
  if (studyDate < today) throw new AppError("VALIDATION_ERROR", "過ぎた日の記録は変更できません。画面を開き直してください");
  if (studyDate < goal.startDate || studyDate > (goal.dueDate > today ? goal.dueDate : today)) {
    throw new AppError("VALIDATION_ERROR", "この日は計画の期間外です");
  }
  return goal;
}

function handleSetProgress(req) {
  const student = authenticate(req.token);
  ensurePlanSheets();
  const studyDate = req.studyDate;
  const goal = editableGoal(student, req.goalId, studyDate);

  let through = null;
  if (req.throughPage !== null && req.throughPage !== undefined) {
    through = req.throughPage;
    if (!Number.isInteger(through) || through < goal.startPage - 1 || through > goal.endPage) {
      throw new AppError("VALIDATION_ERROR", "ページは " + goal.startPage + "〜" + goal.endPage + " の範囲で入力してください");
    }
  }

  withLock(function () {
    const sheet = getSheet(SHEET.GOAL_PROGRESS);
    const rows = readRows(SHEET.GOAL_PROGRESS).filter(function (r) { return r.values[1] === goal.goalId; });
    const existing = rows.find(function (r) { return toDateKey(r.values[3]) === studyDate; });
    // 進捗は「何ページ目まで」で数えるので、後の日にチェックがあるのに前の日を外すと
    // 進捗バーが減らず表示が食い違う。外す（減らす）のは後の日から順番にさせる（spec §14.3）
    const decreasing = existing && (through === null || through < Number(existing.values[4]));
    const laterChecked = rows.some(function (r) { return toDateKey(r.values[3]) > studyDate; });
    if (decreasing && laterChecked) {
      throw new AppError("VALIDATION_ERROR", "後の日のチェックがあるため外せません。先に後の日の分を外してください");
    }
    if (through === null) {
      if (existing) sheet.deleteRow(existing.rowNumber);
    } else if (existing) {
      sheet.getRange(existing.rowNumber, 5, 1, 2).setValues([[through, nowIso()]]);
    } else {
      sheet.appendRow([newId("prog_"), goal.goalId, student.studentId, studyDate, through, nowIso()]);
    }
  });
  return ok({});
}

// ---------------------------------------------------------------------------
// 講師向け

function handleTutorGetPlan(req) {
  authenticateTutor(req.tutorToken);
  ensurePlanSheets();
  const student = findActiveStudent(req.studentId);
  return ok(planPayload(student.studentId));
}

function validateGoalInput(input) {
  if (!input || typeof input !== "object") throw new AppError("VALIDATION_ERROR", "目標の内容が正しくありません");

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || Array.from(title).length > GOAL_TITLE_MAX) {
    throw new AppError("VALIDATION_ERROR", "テキスト名は1〜" + GOAL_TITLE_MAX + "文字で入力してください");
  }
  const startPage = input.startPage;
  const endPage = input.endPage;
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage || endPage > GOAL_PAGE_MAX) {
    throw new AppError("VALIDATION_ERROR", "ページは1〜" + GOAL_PAGE_MAX + "で、終わりのページは始めのページ以上にしてください");
  }
  if (!isValidDateKey(input.startDate) || !isValidDateKey(input.dueDate)) {
    throw new AppError("VALIDATION_ERROR", "開始日と期限を入力してください");
  }
  if (input.dueDate < input.startDate) throw new AppError("VALIDATION_ERROR", "期限は開始日以降にしてください");
  if (daysBetween(input.startDate, input.dueDate) > GOAL_MAX_DAYS) throw new AppError("VALIDATION_ERROR", "期間は1年以内にしてください");

  const weekdays = Array.isArray(input.restWeekdays) ? input.restWeekdays : [];
  if (!weekdays.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 6; })) {
    throw new AppError("VALIDATION_ERROR", "休みの曜日が正しくありません");
  }
  const restWeekdays = weekdays.filter(function (n, i) { return weekdays.indexOf(n) === i; }).sort();
  if (restWeekdays.length >= 7) throw new AppError("VALIDATION_ERROR", "勉強する曜日を1つ以上残してください");

  const dates = Array.isArray(input.restDates) ? input.restDates : [];
  if (dates.length > GOAL_REST_DATES_MAX || !dates.every(isValidDateKey)) {
    throw new AppError("VALIDATION_ERROR", "休みの日付が正しくありません");
  }
  const restDates = dates.filter(function (d, i) { return dates.indexOf(d) === i; }).sort();

  // 休みを除いて勉強日が1日も無い計画は割り振れない
  let hasStudyDay = false;
  for (let d = input.startDate; d <= input.dueDate && !hasStudyDay; ) {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    if (restWeekdays.indexOf(wd) === -1 && restDates.indexOf(d) === -1) hasStudyDay = true;
    d = new Date(new Date(d + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  }
  if (!hasStudyDay) throw new AppError("VALIDATION_ERROR", "開始日から期限までに勉強する日がありません。休みを見直してください");

  return {
    title: title, startPage: startPage, endPage: endPage, startDate: input.startDate, dueDate: input.dueDate,
    restWeekdays: restWeekdays, restDates: restDates
  };
}

function handleTutorSaveGoal(req) {
  authenticateTutor(req.tutorToken);
  ensurePlanSheets();
  const student = findActiveStudent(req.studentId);
  const g = validateGoalInput(req.goal);
  const goalId = req.goal && typeof req.goal.goalId === "string" && req.goal.goalId ? req.goal.goalId : null;
  const now = nowIso();

  const savedId = withLock(function () {
    const sheet = getSheet(SHEET.GOALS);
    const goals = readRows(SHEET.GOALS).map(rowToGoal);
    const row = [g.title, g.startPage, g.endPage, g.startDate, g.dueDate, JSON.stringify(g.restWeekdays), JSON.stringify(g.restDates)];
    if (goalId) {
      const existing = goals.find(function (x) { return x.goalId === goalId && x.studentId === student.studentId && x.active; });
      if (!existing) throw new AppError("VALIDATION_ERROR", "目標が見つかりません。画面を開き直してください");
      sheet.getRange(existing.rowNumber, 3, 1, row.length).setValues([row]);
      sheet.getRange(existing.rowNumber, 12).setValue(now);
      return goalId;
    }
    const activeCount = goals.filter(function (x) { return x.studentId === student.studentId && x.active; }).length;
    if (activeCount >= GOALS_PER_STUDENT_MAX) {
      throw new AppError("VALIDATION_ERROR", "目標は1人" + GOALS_PER_STUDENT_MAX + "件までです。終わった目標を削除してください");
    }
    const id = newId("goal_");
    sheet.appendRow([id, student.studentId].concat(row).concat([true, now, now]));
    return id;
  });
  return ok({ goalId: savedId });
}

function handleTutorDeleteGoal(req) {
  authenticateTutor(req.tutorToken);
  ensurePlanSheets();
  if (typeof req.goalId !== "string") throw new AppError("VALIDATION_ERROR", "目標が見つかりません");
  withLock(function () {
    const goal = readRows(SHEET.GOALS).map(rowToGoal).find(function (g) { return g.goalId === req.goalId && g.active; });
    if (!goal) throw new AppError("VALIDATION_ERROR", "目標が見つかりません。画面を開き直してください");
    const sheet = getSheet(SHEET.GOALS);
    sheet.getRange(goal.rowNumber, 10).setValue(false);
    sheet.getRange(goal.rowNumber, 12).setValue(nowIso());
  });
  return ok({});
}

// ---------------------------------------------------------------------------
// 取り組んだページの写真（spec §14.7）

const PLAN_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PLAN_PHOTO_FOLDER_NAME = "計画の写真";

function readPhotos(studentId) {
  return readRows(SHEET.PLAN_PHOTOS)
    .filter(function (r) { return studentId === null || r.values[2] === studentId; })
    .map(function (r) {
      return {
        photoId: String(r.values[0]), goalId: String(r.values[1]), studentId: String(r.values[2]),
        studyDate: toDateKey(r.values[3]), fromPage: Number(r.values[4]), toPage: Number(r.values[5]),
        fileId: String(r.values[6]), rowNumber: r.rowNumber
      };
    })
    .filter(function (p) { return p.studyDate; });
}

/** 生徒フォルダの中の「計画の写真」フォルダ。答案と混ざらないよう分ける */
function planPhotoFolder(student) {
  const parent = ensureStudentFolder(student);
  return withLock(function () {
    const found = parent.getFoldersByName(PLAN_PHOTO_FOLDER_NAME);
    return found.hasNext() ? found.next() : parent.createFolder(PLAN_PHOTO_FOLDER_NAME);
  });
}

function trashQuietly(fileId) {
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (err) {
    // 先生が手で消していた等。写真の記録の更新は止めない
    console.error(err);
  }
}

function handleUploadPlanPhoto(req) {
  const student = authenticate(req.token);
  ensurePlanSheets();
  const goal = editableGoal(student, req.goalId, req.studyDate);

  const from = req.fromPage;
  const to = req.toPage;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < goal.startPage || to > goal.endPage || to - from < 0 || to - from > 1) {
    throw new AppError("VALIDATION_ERROR", "写真のページが正しくありません。画面を開き直してください");
  }
  if (typeof req.dataBase64 !== "string" || req.dataBase64.length === 0) {
    throw new AppError("VALIDATION_ERROR", "写真が空です");
  }
  if (estimateDecodedSize(req.dataBase64) > PLAN_PHOTO_MAX_BYTES) {
    throw new AppError("FILE_TOO_LARGE", "写真が大きすぎます");
  }
  const bytes = decodeBase64(req.dataBase64);
  // アプリは必ず JPEG に変換して送る。それ以外は受け付けない
  if (bytes.length > PLAN_PHOTO_MAX_BYTES || !matchesMagicBytes("image/jpeg", bytes)) {
    throw new AppError("UNSUPPORTED_TYPE", "写真を読み込めませんでした。撮り直してください");
  }

  const folder = planPhotoFolder(student);
  const date = req.studyDate.replace(/-/g, "");
  const title = Array.from(sanitizeFileName(goal.title)).slice(0, 30).join("") || "計画";
  const pages = from === to ? "p" + from : "p" + from + "-" + to;
  const file = folder.createFile(Utilities.newBlob(bytes, "image/jpeg", date + "_" + student.nameSlug + "_" + title + "_" + pages + ".jpg"));

  let replacedFileId = null;
  const photoId = withLock(function () {
    const sheet = getSheet(SHEET.PLAN_PHOTOS);
    const existing = readPhotos(student.studentId).find(function (p) {
      return p.goalId === goal.goalId && p.studyDate === req.studyDate && p.fromPage === from;
    });
    if (existing) {
      replacedFileId = existing.fileId;
      sheet.getRange(existing.rowNumber, 6, 1, 3).setValues([[to, file.getId(), nowIso()]]);
      return existing.photoId;
    }
    const id = newId("photo_");
    sheet.appendRow([id, goal.goalId, student.studentId, req.studyDate, from, to, file.getId(), nowIso()]);
    return id;
  });
  // 撮り直した前の写真は消さずにゴミ箱へ（30日は先生が戻せる）
  if (replacedFileId) trashQuietly(replacedFileId);
  return ok({ photoId: photoId });
}

function handleDeletePlanPhoto(req) {
  const student = authenticate(req.token);
  ensurePlanSheets();
  const photo = typeof req.photoId === "string"
    ? readPhotos(student.studentId).find(function (p) { return p.photoId === req.photoId; })
    : null;
  if (!photo) throw new AppError("VALIDATION_ERROR", "写真が見つかりません。画面を開き直してください");
  if (photo.studyDate < planToday()) throw new AppError("VALIDATION_ERROR", "過ぎた日の写真は変更できません");

  withLock(function () {
    // ロック待ちの間に行がずれていないよう、IDで探し直してから消す
    const current = readPhotos(student.studentId).find(function (p) { return p.photoId === photo.photoId; });
    if (current) getSheet(SHEET.PLAN_PHOTOS).deleteRow(current.rowNumber);
  });
  trashQuietly(photo.fileId);
  return ok({});
}

function photoPayload(photo) {
  let file;
  try {
    file = DriveApp.getFileById(photo.fileId);
  } catch (_) {
    throw new AppError("VALIDATION_ERROR", "この写真は削除されています");
  }
  if (file.isTrashed()) throw new AppError("VALIDATION_ERROR", "この写真は削除されています");
  const blob = file.getBlob();
  return ok({ mimeType: blob.getContentType(), dataBase64: Utilities.base64Encode(blob.getBytes()) });
}

function handleGetPlanPhoto(req) {
  const student = authenticate(req.token);
  ensurePlanSheets();
  const photo = typeof req.photoId === "string"
    ? readPhotos(student.studentId).find(function (p) { return p.photoId === req.photoId; })
    : null;
  if (!photo) throw new AppError("VALIDATION_ERROR", "写真が見つかりません");
  return photoPayload(photo);
}

function handleTutorGetPlanPhoto(req) {
  authenticateTutor(req.tutorToken);
  ensurePlanSheets();
  const photo = typeof req.photoId === "string"
    ? readPhotos(null).find(function (p) { return p.photoId === req.photoId; })
    : null;
  if (!photo) throw new AppError("VALIDATION_ERROR", "写真が見つかりません");
  return photoPayload(photo);
}
