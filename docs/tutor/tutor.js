(function () {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const GAS_URL = CONFIG.GAS_URL;
  const AUTH_URL = CONFIG.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_KEY = "tutorapp.tutorToken";
  const PENDING_KEY = "tutorapp.pendingLogin";
  const POLL_INTERVAL_MS = 30 * 1000;
  const TIME_ZONE = "Asia/Tokyo";

  const TEXT = {
    network: "通信に失敗しました。電波の良い場所でもう一度お試しください",
    unknown: "うまくいきませんでした。少し待ってからもう一度お試しください",
    sessionExpired: "ログインの有効期限が切れました。もう一度ログインしてください"
  };

  const $ = function (id) { return document.getElementById(id); };

  const state = {
    tutorToken: null,
    students: [],
    selectedId: null,
    view: "messages",
    thread: null,
    pollTimer: null,
    loadingList: false,
    loadingThread: false
  };

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* 今回のセッションだけは使える */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // API

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(action, params) {
    const payload = Object.assign({ action: action, tutorToken: state.tutorToken }, params || {});
    let res;
    try {
      // text/plain と redirect: "follow" の理由は生徒アプリ（../app.js）と同じ
      res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow"
      });
    } catch (_) {
      throw new ApiError("NETWORK", TEXT.network);
    }
    let body;
    try {
      body = await res.json();
    } catch (_) {
      throw new ApiError("NETWORK", TEXT.network);
    }
    if (!body || body.ok !== true) {
      const code = (body && body.error && body.error.code) || "INTERNAL_ERROR";
      const message = (body && body.error && body.error.message) || TEXT.unknown;
      if (code === "INVALID_TOKEN" && action !== "tutorLogin") logout(TEXT.sessionExpired);
      throw new ApiError(code, code === "INTERNAL_ERROR" ? TEXT.unknown : message);
    }
    return body.data;
  }

  function showError(el, text) {
    el.textContent = text || "";
    el.hidden = !text;
  }

  // ---------------------------------------------------------------------------
  // ログイン（Google の OAuth 画面へのリダイレクト。spec §13.2）

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function redirectUri() {
    return location.origin + location.pathname;
  }

  function startGoogleLogin() {
    if (!CONFIG.GOOGLE_CLIENT_ID) {
      showError($("login-error"), "ログインの設定がまだです（GOOGLE_CLIENT_ID）");
      return;
    }
    const pending = { nonce: randomHex(16), state: randomHex(16), at: Date.now() };
    // iOS のホーム画面アプリは外部ページから戻ると sessionStorage が消えることがあるので localStorage に置く
    storageSet(PENDING_KEY, JSON.stringify(pending));
    const params = new URLSearchParams({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "id_token",
      scope: "openid email",
      nonce: pending.nonce,
      state: pending.state,
      prompt: "select_account"
    });
    location.assign(AUTH_URL + "?" + params.toString());
  }

  /** Google から戻ってきたとき（URL の # に id_token が付いている）の処理。処理したら true */
  async function completeGoogleLogin() {
    if (location.hash.indexOf("id_token=") === -1 && location.hash.indexOf("error=") === -1) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    // トークンを URL に残さない（履歴やスクリーンショットに写り込むため）
    history.replaceState(null, "", redirectUri());

    let pending = null;
    try { pending = JSON.parse(storageGet(PENDING_KEY) || "null"); } catch (_) { /* 無視 */ }
    storageRemove(PENDING_KEY);

    showLogin();
    if (params.get("error")) {
      showError($("login-error"), "ログインをキャンセルしました");
      return true;
    }
    // state が一致しない＝自分が始めたログインではない。他人の ID トークンを押し込まれるのを防ぐ
    if (!pending || pending.state !== params.get("state") || Date.now() - pending.at > 10 * 60 * 1000) {
      showError($("login-error"), "ログインをやり直してください");
      return true;
    }

    const button = $("login-button");
    button.disabled = true;
    try {
      const data = await api("tutorLogin", { idToken: params.get("id_token"), nonce: pending.nonce });
      state.tutorToken = data.tutorToken;
      storageSet(TOKEN_KEY, data.tutorToken);
      enterApp();
    } catch (err) {
      showError($("login-error"), err.message);
    } finally {
      button.disabled = false;
    }
    return true;
  }

  function showLogin(message) {
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    showError($("login-error"), message || "");
  }

  function logout(message) {
    storageRemove(TOKEN_KEY);
    state.tutorToken = null;
    state.students = [];
    state.selectedId = null;
    state.thread = null;
    stopPolling();
    showLogin(message);
  }

  function enterApp() {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    loadStudents();
    startPolling();
  }

  // ---------------------------------------------------------------------------
  // 生徒一覧

  const shortTime = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  const shortDate = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, month: "numeric", day: "numeric" });
  const dayFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, month: "long", day: "numeric", weekday: "short" });
  const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function relativeTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return shortDate.format(d) === shortDate.format(new Date()) ? shortTime.format(d) : shortDate.format(d);
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + "KB";
    return (bytes / 1024 / 1024).toFixed(1) + "MB";
  }

  async function loadStudents() {
    if (state.loadingList || !state.tutorToken) return;
    state.loadingList = true;
    try {
      const data = await api("tutorListStudents");
      state.students = data.students;
      showError($("students-error"), "");
      renderStudents();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("students-error"), err.message);
    } finally {
      state.loadingList = false;
    }
  }

  function renderStudents() {
    const list = $("student-list");
    list.replaceChildren();
    $("students-empty").hidden = state.students.length > 0;
    state.students.forEach(function (s) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "student-item";
      btn.setAttribute("aria-current", String(s.studentId === state.selectedId));

      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = Array.from(s.name)[0] || "?";

      const main = document.createElement("span");
      main.className = "student-main";
      const name = document.createElement("p");
      name.className = "student-name";
      name.textContent = s.name;
      const preview = document.createElement("p");
      preview.className = "student-preview";
      preview.textContent = s.lastMessage || "まだやりとりはありません";
      main.append(name, preview);

      const side = document.createElement("span");
      side.className = "student-side";
      const time = document.createElement("span");
      time.className = "student-time";
      time.textContent = relativeTime(s.lastActivityAt);
      side.appendChild(time);
      // 開いている生徒の未読は、既読にする取得が終わるまでの一瞬だけ残るので表示しない
      if (s.unreadCount > 0 && s.studentId !== state.selectedId) {
        const badge = document.createElement("span");
        badge.className = "unread";
        badge.textContent = s.unreadCount > 99 ? "99+" : String(s.unreadCount);
        badge.setAttribute("aria-label", "未読" + s.unreadCount + "件");
        side.appendChild(badge);
      }

      btn.append(avatar, main, side);
      btn.addEventListener("click", function () { selectStudent(s.studentId); });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------------
  // 生徒の画面

  function selectStudent(studentId) {
    const changed = state.selectedId !== studentId;
    state.selectedId = studentId;
    if (changed) {
      state.thread = null;
      $("composer-input").value = "";
      autoGrowComposer();
    }
    const student = state.students.find(function (s) { return s.studentId === studentId; });
    $("detail-name").textContent = student ? student.name : "";
    $("detail-placeholder").hidden = true;
    $("detail").hidden = false;
    $("layout").classList.add("show-detail");
    renderStudents();
    renderThread();
    loadThread({ scrollToBottom: true });
  }

  function backToList() {
    $("layout").classList.remove("show-detail");
    state.selectedId = null;
    state.thread = null;
    $("detail").hidden = true;
    $("detail-placeholder").hidden = false;
    loadStudents();
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll(".segmented button").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.view === view));
    });
    $("view-messages").hidden = view !== "messages";
    $("view-submissions").hidden = view !== "submissions";
    if (view === "messages") scrollToBottom();
  }

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function scrollToBottom() {
    const list = $("message-list");
    list.scrollTop = list.scrollHeight;
  }

  async function loadThread(options) {
    const studentId = state.selectedId;
    if (!studentId || state.loadingThread) return;
    state.loadingThread = true;
    const list = $("message-list");
    try {
      const data = await api("tutorGetThread", { studentId: studentId });
      // 読み込み中に別の生徒を選んでいたら捨てる
      if (state.selectedId !== studentId) return;
      const stick = (options && options.scrollToBottom) || isNearBottom(list);
      state.thread = data;
      showError($("messages-error"), "");
      renderThread();
      if (stick) scrollToBottom();
      // 開いた時点で既読になったので、一覧のバッジも消す
      const s = state.students.find(function (x) { return x.studentId === studentId; });
      if (s && s.unreadCount) {
        s.unreadCount = 0;
        renderStudents();
      }
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("messages-error"), err.message);
    } finally {
      state.loadingThread = false;
    }
  }

  function renderThread() {
    const list = $("message-list");
    const empty = $("messages-empty");
    list.replaceChildren(empty);
    const thread = state.thread;
    const messages = thread ? thread.messages : [];
    empty.hidden = !thread || messages.length > 0;
    $("submission-count").textContent = thread ? "(" + thread.submissions.length + ")" : "";

    let lastDay = null;
    messages.forEach(function (m) {
      const date = new Date(m.createdAt);
      const day = dayFormat.format(date);
      if (day !== lastDay) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.textContent = day;
        list.appendChild(divider);
        lastDay = day;
      }
      if (m.system) {
        const band = document.createElement("div");
        band.className = "system-msg";
        const span = document.createElement("span");
        span.textContent = m.body + " · " + shortTime.format(date);
        band.appendChild(span);
        list.appendChild(band);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "msg " + (m.sender === "tutor" ? "msg-mine" : "msg-theirs");
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.body;
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = shortTime.format(date);
      wrap.append(bubble, time);
      list.appendChild(wrap);
    });

    renderSubmissions(thread ? thread.submissions : []);
  }

  function renderSubmissions(items) {
    const list = $("submission-list");
    list.replaceChildren();
    $("submissions-empty").hidden = !state.thread || items.length > 0;
    items.forEach(function (s) {
      const li = document.createElement("li");
      li.className = "submission-card";

      const info = document.createElement("div");
      const name = document.createElement("p");
      name.className = "submission-name";
      name.textContent = s.fileName;
      const meta = document.createElement("p");
      meta.className = "submission-meta";
      meta.textContent = (s.createdAt ? dateTimeFormat.format(new Date(s.createdAt)) : "") + " ・ " + formatBytes(s.sizeBytes);
      info.append(name, meta);
      if (s.note) {
        const note = document.createElement("p");
        note.className = "submission-note";
        note.textContent = "💬 " + s.note;
        info.appendChild(note);
      }
      if (!s.available) {
        const missing = document.createElement("span");
        missing.className = "missing-badge";
        missing.textContent = "Driveから削除されています";
        info.appendChild(missing);
      } else if (s.annotated) {
        const badge = document.createElement("span");
        badge.className = "annotated-badge";
        badge.textContent = "✏️ 書き込み済み";
        info.appendChild(badge);
      }
      li.appendChild(info);
      list.appendChild(li);
    });
  }

  function autoGrowComposer() {
    const input = $("composer-input");
    input.style.height = "auto";
    // 非表示中は scrollHeight が 0 になるので、そのときは既定の高さに戻す
    input.style.height = input.scrollHeight ? Math.min(input.scrollHeight + 3, 160) + "px" : "";
    $("composer-send").disabled = input.value.trim() === "";
  }

  async function onSend(event) {
    event.preventDefault();
    const input = $("composer-input");
    const body = input.value.trim();
    const studentId = state.selectedId;
    if (!body || !studentId) return;
    $("composer-send").disabled = true;
    input.disabled = true;
    try {
      await api("tutorSendMessage", { studentId: studentId, body: body });
      input.value = "";
      showError($("messages-error"), "");
      await loadThread({ scrollToBottom: true });
      loadStudents();
    } catch (err) {
      // 書いた返信は消さずに残す
      if (err.code !== "INVALID_TOKEN") showError($("messages-error"), err.message);
    } finally {
      input.disabled = false;
      autoGrowComposer();
    }
  }

  // ---------------------------------------------------------------------------
  // ポーリング

  function poll() {
    loadStudents();
    if (state.selectedId) loadThread();
  }

  function startPolling() {
    stopPolling();
    if (document.visibilityState === "hidden") return;
    state.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function onVisibilityChange() {
    if (!state.tutorToken) return;
    if (document.visibilityState === "hidden") {
      stopPolling();
    } else {
      poll();
      startPolling();
    }
  }

  // ---------------------------------------------------------------------------
  // 初期化

  function bind() {
    $("login-button").addEventListener("click", startGoogleLogin);
    $("logout-button").addEventListener("click", async function () {
      if (!window.confirm("ログアウトしますか？")) return;
      try { await api("tutorLogout"); } catch (_) { /* 失効済みでもローカルは消す */ }
      logout();
    });
    $("back-button").addEventListener("click", backToList);
    document.querySelectorAll(".segmented button").forEach(function (b) {
      b.addEventListener("click", function () { switchView(b.dataset.view); });
    });
    $("composer").addEventListener("submit", onSend);
    $("composer-input").addEventListener("input", autoGrowComposer);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  async function boot() {
    bind();
    if (await completeGoogleLogin()) return;
    state.tutorToken = storageGet(TOKEN_KEY);
    if (state.tutorToken) {
      enterApp();
    } else {
      showLogin();
    }
  }

  boot();
})();
