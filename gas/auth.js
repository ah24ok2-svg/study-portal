/**
 * 合言葉トークン方式の認証（spec §3）
 */

// 0/o, 1/l/i を除いた英小文字と数字。口頭で伝えても聞き間違えないようにするため
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 16;
const TOKEN_PATTERN = /^[a-z0-9]{16}$/;

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 30;
const AUTH_FAIL_WINDOW_SEC = 10 * 60;
const AUTH_FAIL_MAX = 20;
const AUTH_LOCK_SEC = 10 * 60;

function handleLogin(req) {
  const student = authenticate(req.token);
  return ok({ studentId: student.studentId, name: student.name });
}

/**
 * トークンから生徒を逆引きする。login 以外のハンドラも必ずここを通すこと。
 * student_id をリクエストから受け取らないのは、他人の提出物を覗けなくするため（spec §10-4）
 */
function authenticate(token) {
  const cache = CacheService.getScriptCache();

  // IP 単位で追えないため、総当たりの兆候があれば全体を一時停止する
  if (cache.get("auth_lock")) {
    throw new AppError("RATE_LIMITED", "しばらく時間をおいてからお試しください");
  }

  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "合言葉が正しくありません");
  }

  const tokenHash = hashToken(token);
  enforceRateLimit(cache, tokenHash);

  const row = readRows(SHEET.STUDENTS).find(function (r) {
    return r.values[3] === tokenHash;
  });
  if (!row || !isTrue(row.values[5])) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "合言葉が正しくありません");
  }

  return {
    studentId: String(row.values[0]),
    name: String(row.values[1]),
    nameSlug: String(row.values[2]),
    folderId: String(row.values[4] || ""),
    rowNumber: row.rowNumber
  };
}

function enforceRateLimit(cache, tokenHash) {
  // 固定窓カウンタ。CacheService は原子的に加算できないが、20人規模なら誤差は問題にならない
  const windowKey = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SEC * 1000));
  const key = "rl_" + tokenHash.slice(0, 32) + "_" + windowKey;
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), RATE_LIMIT_WINDOW_SEC + 5);
  if (count > RATE_LIMIT_MAX) {
    throw new AppError("RATE_LIMITED", "操作が多すぎます。1分ほど待ってからお試しください");
  }
}

function recordAuthFailure(cache) {
  const windowKey = Math.floor(Date.now() / (AUTH_FAIL_WINDOW_SEC * 1000));
  const key = "authfail_" + windowKey;
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), AUTH_FAIL_WINDOW_SEC + 5);
  if (count > AUTH_FAIL_MAX && !cache.get("auth_lock")) {
    cache.put("auth_lock", "1", AUTH_LOCK_SEC);
    notifyAuthLock(count);
  }
}

function notifyAuthLock(count) {
  try {
    MailApp.sendEmail(
      getProp("NOTIFY_EMAIL"),
      "[Study Portal] ログイン失敗が多発したため一時ロックしました",
      "直近10分間で合言葉の照合失敗が " + count + " 回ありました。\n" +
      "10分間、すべての生徒のアクセスを停止しています。\n" +
      "心当たりがなければ、合言葉の再発行を検討してください。"
    );
  } catch (err) {
    // 通知に失敗してもロック自体は有効にしておく
    console.error(err);
  }
}

function hashToken(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  // GAS のバイト列は -128〜127 の符号付き
  return bytes.map(function (b) {
    return ((b + 256) % 256).toString(16).padStart(2, "0");
  }).join("");
}

/**
 * ランダムなトークンを生成する。GAS には crypto.getRandomValues が無いので、
 * UUID v4（内部で安全な乱数を使う）を SHA-256 にかけてバイト源にする
 */
function createRandomToken() {
  const n = TOKEN_ALPHABET.length;
  // 256 未満で n の倍数の最大値。これ以上のバイトを捨てて偏りを無くす
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for (let i = 0; i < bytes.length && out.length < TOKEN_LENGTH; i++) {
      const b = (bytes[i] + 256) % 256;
      if (b < limit) out += TOKEN_ALPHABET[b % n];
    }
  }
  return out;
}

function createStudentId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  let id = "stu_";
  for (let i = 0; i < 8; i++) id += chars[((bytes[i] + 256) % 256) % chars.length];
  return id;
}

/**
 * 生徒を登録し、合言葉を発行する。平文はこの戻り値と実行ログにだけ1度出る。
 * スクリプトエディタからは引数を渡せないので、通常はメニュー「生徒を追加」から使う
 */
function generateToken(studentName, nameSlug) {
  const name = String(studentName || "").trim();
  const slug = String(nameSlug || "").trim().toLowerCase();
  if (!name) throw new Error("生徒名を入力してください");
  if (!/^[a-z0-9-]{1,30}$/.test(slug)) throw new Error("ファイル名用の名前は英小文字・数字・ハイフンのみ、30文字以内で入力してください");

  const token = createRandomToken();
  const studentId = createStudentId();
  withLock(function () {
    getSheet(SHEET.STUDENTS).appendRow([studentId, name, slug, hashToken(token), "", true, nowIso()]);
  });
  console.log("合言葉を発行しました: " + name + " → " + token);
  return { studentId: studentId, name: name, token: token };
}

/** 合言葉を忘れた生徒向け。古い合言葉は即座に無効になる */
function reissueToken(studentId) {
  const token = createRandomToken();
  withLock(function () {
    const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[0] === studentId; });
    if (!row) throw new Error("生徒が見つかりません: " + studentId);
    getSheet(SHEET.STUDENTS).getRange(row.rowNumber, 4).setValue(hashToken(token));
  });
  console.log("合言葉を再発行しました: " + studentId + " → " + token);
  return { studentId: studentId, token: token };
}
