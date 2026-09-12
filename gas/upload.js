/**
 * 提出ファイルのアップロードと履歴（spec §5, §6.4, §6.5）
 */

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const NOTE_MAX_LENGTH = 200;
const FILE_NAME_MAX_LENGTH = 100;
const SUBMISSIONS_LIMIT = 100;

// MIMEタイプごとに許可する拡張子。クライアントの accept 属性は検証にならないのでここで判定する
const ALLOWED_TYPES = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/heic": ["heic"]
};

function handleUpload(req) {
  const student = authenticate(req.token);
  const input = validateUpload(req);

  const bytes = decodeBase64(input.dataBase64);
  // base64 長からの推定はパディング等で誤差があるので、デコード後の実サイズでも確認する
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new AppError("FILE_TOO_LARGE", "ファイルが大きすぎます（上限20MB）");
  }
  if (bytes.length === 0) {
    throw new AppError("VALIDATION_ERROR", "ファイルが空です");
  }
  // 拡張子とMIMEを偽装した別形式のファイルを弾くため、先頭バイトも確認する
  if (!matchesMagicBytes(input.mimeType, bytes)) {
    throw new AppError("UNSUPPORTED_TYPE", "ファイルの中身が形式と一致しません");
  }

  const folder = ensureStudentFolder(student);
  const fileName = buildUniqueFileName(folder, student.nameSlug, input.fileName);
  const file = folder.createFile(Utilities.newBlob(bytes, input.mimeType, fileName));

  const submissionId = newId("sub_");
  const createdAt = nowIso();
  const messageBody = UPLOAD_MESSAGE_PREFIX + fileName + (input.pageCount ? "（" + input.pageCount + "ページ）" : "");

  withLock(function () {
    getSheet(SHEET.SUBMISSIONS).appendRow([
      submissionId, student.studentId, file.getId(), fileName, input.mimeType, bytes.length, input.note, createdAt
    ]);
    getSheet(SHEET.MESSAGES).appendRow([newId("msg_"), student.studentId, "student", messageBody, createdAt, true]);
  });

  return ok({ submissionId: submissionId, fileName: fileName });
}

function validateUpload(req) {
  const mimeType = req.mimeType;
  if (typeof mimeType !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, mimeType)) {
    throw new AppError("UNSUPPORTED_TYPE", "PDF・JPEG・PNG・HEIC のファイルだけ提出できます");
  }

  const dataBase64 = req.dataBase64;
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    throw new AppError("VALIDATION_ERROR", "ファイルが空です");
  }
  // デコード前に弾くことで、巨大なデータのデコードに実行時間を使わない
  if (estimateDecodedSize(dataBase64) > MAX_UPLOAD_BYTES) {
    throw new AppError("FILE_TOO_LARGE", "ファイルが大きすぎます（上限20MB）");
  }

  if (typeof req.fileName !== "string") {
    throw new AppError("VALIDATION_ERROR", "ファイル名がありません");
  }
  const fileName = sanitizeFileName(req.fileName);
  const ext = splitExtension(fileName).ext.toLowerCase();
  if (!splitExtension(fileName).base) {
    throw new AppError("VALIDATION_ERROR", "ファイル名がありません");
  }
  if (ALLOWED_TYPES[mimeType].indexOf(ext) === -1) {
    throw new AppError("UNSUPPORTED_TYPE", "ファイルの拡張子と形式が一致しません");
  }

  let note = "";
  if (req.note !== undefined && req.note !== null) {
    if (typeof req.note !== "string") throw new AppError("VALIDATION_ERROR", "コメントが不正です");
    note = req.note.trim();
    if (note.length > NOTE_MAX_LENGTH) {
      throw new AppError("VALIDATION_ERROR", "コメントは" + NOTE_MAX_LENGTH + "文字以内で入力してください");
    }
  }

  // ページ数は表示用の付加情報なので、不正値ならエラーにせず無視する
  const pageCount = Number.isInteger(req.pageCount) && req.pageCount > 0 && req.pageCount <= 500 ? req.pageCount : null;

  return { mimeType: mimeType, dataBase64: dataBase64, fileName: fileName, note: note, pageCount: pageCount };
}

function estimateDecodedSize(b64) {
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor(b64.length * 3 / 4) - padding;
}

function decodeBase64(b64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new AppError("VALIDATION_ERROR", "ファイルの読み込みに失敗しました");
  }
  try {
    return Utilities.base64Decode(b64);
  } catch (_) {
    throw new AppError("VALIDATION_ERROR", "ファイルの読み込みに失敗しました");
  }
}

function matchesMagicBytes(mimeType, bytes) {
  const b = function (i) { return (bytes[i] + 256) % 256; };
  if (bytes.length < 12) return false;
  switch (mimeType) {
    case "application/pdf": // %PDF
      return b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46;
    case "image/jpeg":
      return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case "image/png":
      return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
    case "image/heic": // ISO BMFF: 4バイト目から "ftyp"
      return b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70;
    default:
      return false;
  }
}

/** `/ \ : * ? " < > |` と制御文字を除去する（spec §5） */
function sanitizeFileName(name) {
  return name.replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, "").trim();
}

function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * {YYYYMMDD}_{name_slug}_{元のファイル名} を作る。
 * 100文字を超える分は元ファイル名側を削り、同名があれば _2, _3 と付ける
 */
function buildUniqueFileName(folder, nameSlug, originalName) {
  const date = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd");
  const prefix = date + "_" + nameSlug + "_";
  const parts = splitExtension(originalName);
  const ext = "." + parts.ext;

  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : "_" + n;
    const candidate = composeFileName(prefix, parts.base, suffix, ext);
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }
  throw new Error("ファイル名の候補が尽きました");
}

function composeFileName(prefix, base, suffix, ext) {
  // サロゲートペア（絵文字など）を途中で切らないよう、コードポイント単位で数える
  const room = FILE_NAME_MAX_LENGTH - Array.from(prefix + suffix + ext).length;
  const baseChars = Array.from(base);
  const trimmed = baseChars.slice(0, Math.max(1, room)).join("");
  return prefix + trimmed + suffix + ext;
}

/** 生徒フォルダが無い、または消されていたら作り直す。フォルダは共有しない（spec §10-2） */
function ensureStudentFolder(student) {
  if (student.folderId) {
    try {
      const existing = DriveApp.getFolderById(student.folderId);
      if (!existing.isTrashed()) return existing;
    } catch (_) {
      // ID が無効なら下で作り直す
    }
  }
  return withLock(function () {
    // ロック待ちの間に別リクエストが作成済みかもしれないので読み直す
    const sheet = getSheet(SHEET.STUDENTS);
    const currentId = String(sheet.getRange(student.rowNumber, 5).getValue() || "");
    if (currentId && currentId !== student.folderId) {
      try {
        return DriveApp.getFolderById(currentId);
      } catch (_) { /* 作り直す */ }
    }
    const folder = DriveApp.getFolderById(getProp("ROOT_FOLDER_ID")).createFolder(student.name);
    sheet.getRange(student.rowNumber, 5).setValue(folder.getId());
    return folder;
  });
}

function handleGetSubmissions(req) {
  const student = authenticate(req.token);
  const items = readRows(SHEET.SUBMISSIONS)
    .filter(function (r) { return r.values[1] === student.studentId; })
    .map(function (r) {
      // Drive の URL や file_id は返さない。生徒に Drive へ直接アクセスさせない方針のため
      return {
        id: String(r.values[0]),
        fileName: String(r.values[3]),
        sizeBytes: Number(r.values[5]) || 0,
        note: String(r.values[6] || ""),
        createdAt: toIso(r.values[7]) || ""
      };
    });
  items.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
  return ok({ submissions: items.slice(0, SUBMISSIONS_LIMIT) });
}
