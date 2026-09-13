/**
 * 講師端末へのプッシュ通知（spec §13.6）
 */

const PUSH_TOKEN_PREFIX = "push_token_";
const PUSH_TOKEN_PATTERN = /^[A-Za-z0-9_:\-]{20,4096}$/;
const PUSH_BODY_MAX = 100;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_ACCESS_TOKEN_CACHE_KEY = "fcm_access_token";

function handleTutorRegisterPush(req) {
  authenticateTutor(req.tutorToken);
  if (typeof req.fcmToken !== "string" || !PUSH_TOKEN_PATTERN.test(req.fcmToken)) {
    throw new AppError("VALIDATION_ERROR", "通知の登録に失敗しました");
  }
  const label = typeof req.label === "string" ? req.label.slice(0, 40) : "";
  PropertiesService.getScriptProperties().setProperty(
    PUSH_TOKEN_PREFIX + hashToken(req.fcmToken),
    JSON.stringify({ token: req.fcmToken, label: label, createdAt: nowIso() })
  );
  return ok({});
}

function handleTutorUnregisterPush(req) {
  authenticateTutor(req.tutorToken);
  if (typeof req.fcmToken === "string" && req.fcmToken) {
    PropertiesService.getScriptProperties().deleteProperty(PUSH_TOKEN_PREFIX + hashToken(req.fcmToken));
  }
  return ok({});
}

function handleTutorTestPush(req) {
  authenticateTutor(req.tutorToken);
  if (!PropertiesService.getScriptProperties().getProperty("FIREBASE_SERVICE_ACCOUNT")) {
    throw new AppError("VALIDATION_ERROR", "通知の送信設定（FIREBASE_SERVICE_ACCOUNT）がまだです");
  }
  const result = sendPushToTutor({ title: "テスト通知", body: "Study Portal からの通知が届いています", studentId: "" });
  return ok(result);
}

/** 生徒の操作の後に呼ぶ。通知の失敗で生徒側のリクエストを失敗させない */
function notifyTutorSafely(payload) {
  try {
    sendPushToTutor(payload);
  } catch (err) {
    console.error("プッシュ通知の送信に失敗: " + (err && err.stack ? err.stack : err));
  }
}

function readPushTokens() {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter(function (key) { return key.indexOf(PUSH_TOKEN_PREFIX) === 0; })
    .map(function (key) {
      try {
        return { key: key, token: JSON.parse(all[key]).token };
      } catch (_) {
        return { key: key, token: null };
      }
    })
    .filter(function (t) { return t.token; });
}

function sendPushToTutor(payload) {
  const tokens = readPushTokens();
  const serviceAccountJson = PropertiesService.getScriptProperties().getProperty("FIREBASE_SERVICE_ACCOUNT");
  if (tokens.length === 0 || !serviceAccountJson) return { sent: 0, failed: 0 };

  const account = JSON.parse(serviceAccountJson);
  const accessToken = getFcmAccessToken(account);
  const url = "https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(account.project_id) + "/messages:send";
  const body = Array.from(String(payload.body || "")).slice(0, PUSH_BODY_MAX).join("");

  const requests = tokens.map(function (t) {
    return {
      url: url,
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + accessToken },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: {
          token: t.token,
          // notification ではなく data で送り、表示は Service Worker に任せる。
          // iOS は通知を出さないプッシュが続くと購読を打ち切るので、必ず自前で表示する
          data: {
            title: String(payload.title || "Study Portal"),
            body: body,
            studentId: String(payload.studentId || "")
          },
          webpush: { headers: { Urgency: "high", TTL: "86400" } }
        }
      })
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  let sent = 0;
  let failed = 0;
  const props = PropertiesService.getScriptProperties();
  responses.forEach(function (res, i) {
    const code = res.getResponseCode();
    if (code === 200) {
      sent++;
      return;
    }
    failed++;
    const text = res.getContentText();
    // アプリを消した端末などのトークンは二度と届かないので掃除する
    if (code === 404 || text.indexOf("UNREGISTERED") !== -1) {
      props.deleteProperty(tokens[i].key);
    } else {
      console.error("FCM 送信エラー " + code + ": " + text.slice(0, 500));
    }
  });
  return { sent: sent, failed: failed };
}

/**
 * サービスアカウントの JWT でアクセストークンを取る。
 * 生徒が送信するたびに取り直すと遅くなるので、有効期限(1時間)より短い50分だけキャッシュする
 */
function getFcmAccessToken(account) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(FCM_ACCESS_TOKEN_CACHE_KEY);
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  });
  const input = header + "." + claims;
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, account.private_key)).replace(/=+$/, "");

  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: input + "." + signature },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("FCM のアクセストークン取得に失敗: " + res.getResponseCode() + " " + res.getContentText().slice(0, 300));
  }
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put(FCM_ACCESS_TOKEN_CACHE_KEY, token, 50 * 60);
  return token;
}

function base64UrlJson(obj) {
  return Utilities.base64EncodeWebSafe(JSON.stringify(obj), Utilities.Charset.UTF_8).replace(/=+$/, "");
}
