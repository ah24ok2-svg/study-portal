(function () {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const GAS_URL = CONFIG.GAS_URL;
  const AUTH_URL = CONFIG.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_KEY = "tutorapp.tutorToken";
  const PUSH_TOKEN_KEY = "tutorapp.pushToken";
  const FIREBASE_SDK_BASE = "https://www.gstatic.com/firebasejs/10.14.1/";
  const PENDING_KEY = "tutorapp.pendingLogin";
  // GAS は1回の応答に1〜2秒かかるので、前回の一覧とやりとりを保存しておき、開いた瞬間に出す
  const CACHE_PREFIX = "tutorapp.tutorCache.";
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
    // 読み込み中のスレッドの生徒ID。別の生徒を選んだときに読み込みを止めないよう、真偽値ではなくIDで持つ
    loadingThread: null,
    // 送信中の返信。サーバーから取り直したスレッドで上書きされないよう、別に持つ
    pending: [],
    planView: null,
    loadingPlan: null,
    // 編集中の目標（新規は null）と、フォームで選んでいる休み
    editingGoal: null,
    formRestWeekdays: [],
    formRestDates: [],
    // 授業の予定（spec §15）。選んでいる生徒の { rules, changes }
    lessons: null,
    loadingLessons: null,
    editingRule: null,
    formRuleWeekday: null,
    // 授業フォームの用途: 追加（item なし）／毎週の授業の日時を変える（move）／追加した授業を直す（edit）
    lessonForm: null,
    // 通知から開いたときに、一覧の読み込み後に選ぶ生徒
    pendingStudentId: new URLSearchParams(location.search).get("student")
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

  /** ログインし直すと別の講師トークンになるので、保存時のトークンと一致するときだけ使う */
  function readCache(name) {
    try {
      const cached = JSON.parse(storageGet(CACHE_PREFIX + name) || "null");
      return cached && cached.owner === state.tutorToken ? cached.items : null;
    } catch (_) {
      return null;
    }
  }

  function writeCache(name, items) {
    storageSet(CACHE_PREFIX + name, JSON.stringify({ owner: state.tutorToken, items: items }));
  }

  function clearCaches() {
    try {
      Object.keys(localStorage)
        .filter(function (key) { return key.indexOf(CACHE_PREFIX) === 0; })
        .forEach(function (key) { localStorage.removeItem(key); });
    } catch (_) { /* noop */ }
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
    clearCaches();
    state.pending = [];
    storageRemove(PUSH_TOKEN_KEY);
    storageRemove(TOKEN_KEY);
    state.tutorToken = null;
    state.students = [];
    state.selectedId = null;
    state.thread = null;
    state.planView = null;
    $("tutor-plan-root").replaceChildren();
    state.lessons = null;
    closeRuleForm();
    closeLessonForm();
    closeGoalForm();
    closeFileViewer();
    stopPolling();
    showLogin(message);
  }

  function enterApp() {
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    const cachedStudents = readCache("students");
    if (cachedStudents) {
      state.students = cachedStudents;
      renderStudents();
    }
    loadStudents();
    startPolling();
    refreshPushToken();
  }

  function openPendingStudent() {
    const id = state.pendingStudentId;
    if (!id) return;
    state.pendingStudentId = null;
    history.replaceState(null, "", redirectUri());
    if (state.students.some(function (s) { return s.studentId === id; })) selectStudent(id);
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
      writeCache("students", data.students);
      showError($("students-error"), "");
      renderStudents();
      openPendingStudent();
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
      state.thread = readCache("thread." + studentId);
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
    scrollToBottom();
    loadThread({ scrollToBottom: true });
    if (changed) {
      state.lessons = readCache("lessons." + studentId);
      renderLessons();
    }
    if (state.view === "lessons") loadLessons();
    if (changed) {
      // 前の生徒の計画が一瞬でも見えないよう、作り直す
      state.planView = null;
      const cached = readCache("plan." + studentId);
      if (cached) getPlanView().setData(cached);
      else getPlanView().render();
    }
    if (state.view === "plan") loadPlan();
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
    $("view-lessons").hidden = view !== "lessons";
    $("view-plan").hidden = view !== "plan";
    $("view-submissions").hidden = view !== "submissions";
    if (view === "messages") scrollToBottom();
    if (view === "lessons") loadLessons();
    if (view === "plan") loadPlan();
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
    if (!studentId || state.loadingThread === studentId) return;
    state.loadingThread = studentId;
    const list = $("message-list");
    try {
      const data = await api("tutorGetThread", { studentId: studentId });
      // 読み込み中に別の生徒を選んでいたら捨てる
      if (state.selectedId !== studentId) return;
      const stick = (options && options.scrollToBottom) || isNearBottom(list);
      state.thread = data;
      writeCache("thread." + studentId, data);
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
      if (state.loadingThread === studentId) state.loadingThread = null;
    }
  }

  function renderThread() {
    const list = $("message-list");
    const empty = $("messages-empty");
    list.replaceChildren(empty);
    const thread = state.thread;
    const pending = state.pending.filter(function (p) { return p.studentId === state.selectedId; });
    const messages = (thread ? thread.messages : []).concat(pending);
    empty.hidden = messages.length > 0;
    empty.textContent = thread ? "まだメッセージはありません。" : "読み込んでいます…";
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
      wrap.className = "msg " + (m.sender === "tutor" ? "msg-mine" : "msg-theirs") + (m.pending ? " msg-pending" : "");
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.body;
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = m.pending ? "送信中…" : shortTime.format(date);
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
      // Drive から消えたものは開けないので、ボタンにしない
      const card = document.createElement(s.available ? "button" : "div");
      card.className = "submission-card" + (s.available ? " submission-button" : "");
      if (s.available) {
        card.type = "button";
        card.addEventListener("click", function () { openSubmission(s); });
      }

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
      card.appendChild(info);
      if (s.available) {
        const chevron = document.createElement("span");
        chevron.className = "submission-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "›";
        card.appendChild(chevron);
      }
      li.appendChild(card);
      list.appendChild(li);
    });
  }

  /** 提出物の中身をその場で確認する（spec §13.8）。書き込みは今までどおり PDF ビューアで Drive のファイルに行う */
  function openSubmission(s) {
    openFileViewer(s.fileName, function () {
      return api("tutorGetSubmissionFile", { submissionId: s.id });
    });
  }

  function autoGrowComposer() {
    const input = $("composer-input");
    input.style.height = "auto";
    // 非表示中は scrollHeight が 0 になるので、そのときは既定の高さに戻す
    input.style.height = input.scrollHeight ? Math.min(input.scrollHeight + 3, 160) + "px" : "";
    $("composer-send").disabled = input.value.trim() === "";
  }

  /** 返事を待たずに吹き出しを出す。GAS の応答（1〜2秒）を待つと送れていないように見えるため */
  async function onSend(event) {
    event.preventDefault();
    const input = $("composer-input");
    const body = input.value.trim();
    const studentId = state.selectedId;
    if (!body || !studentId) return;

    const pending = { id: "pending_" + Date.now() + Math.random(), studentId: studentId, sender: "tutor", body: body, createdAt: new Date().toISOString(), system: false, pending: true };
    state.pending.push(pending);
    input.value = "";
    autoGrowComposer();
    showError($("messages-error"), "");
    renderThread();
    scrollToBottom();

    try {
      const data = await api("tutorSendMessage", { studentId: studentId, body: body });
      state.pending = state.pending.filter(function (p) { return p !== pending; });
      // 取り直しを待たずに確定分として表示する。既読状態などの反映は裏の再取得に任せる
      if (state.thread && state.thread.student.studentId === studentId &&
          !state.thread.messages.some(function (m) { return m.id === data.id; })) {
        state.thread.messages.push({ id: data.id, sender: "tutor", body: body, createdAt: data.createdAt, system: false });
        writeCache("thread." + studentId, state.thread);
      }
      if (state.selectedId === studentId) renderThread();
      loadThread();
      loadStudents();
    } catch (err) {
      state.pending = state.pending.filter(function (p) { return p !== pending; });
      if (err.code === "INVALID_TOKEN") return;
      if (state.selectedId !== studentId) {
        // 別の生徒に移っていたら入力欄へ戻せないので、一覧の上で知らせる
        const student = state.students.find(function (x) { return x.studentId === studentId; });
        showError($("students-error"), (student ? student.name + "さんへの" : "") + "返信を送れませんでした: " + body.slice(0, 40));
        return;
      }
      renderThread();
      // 書いた返信は消さずに入力欄へ戻す。続けて別の文章を書き始めていたら上書きしない
      if (!input.value.trim()) {
        input.value = body;
        autoGrowComposer();
      }
      showError($("messages-error"), err.message + "（返信は送られていません）");
    }
  }

  // ---------------------------------------------------------------------------
  // プッシュ通知（spec §13.6）

  let messagingPromise = null;

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }

  function pushAvailability() {
    if (!CONFIG.FIREBASE_CONFIG || !CONFIG.FIREBASE_VAPID_KEY) return "unconfigured";
    // iOS は Safari のタブでは PushManager 自体が無い。ホーム画面に追加したアプリだけが通知を受け取れる
    if (isIos() && !isStandalone()) return "ios-browser";
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    if (Notification.permission === "granted" && storageGet(PUSH_TOKEN_KEY)) return "enabled";
    return "available";
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new ApiError("NETWORK", TEXT.network)); };
      document.head.appendChild(script);
    });
  }

  /** Firebase SDK はトークン取得にしか使わないので、必要になったときだけ読み込む */
  function getMessaging() {
    if (!messagingPromise) {
      messagingPromise = loadScript(FIREBASE_SDK_BASE + "firebase-app-compat.js")
        .then(function () { return loadScript(FIREBASE_SDK_BASE + "firebase-messaging-compat.js"); })
        .then(function () {
          if (!window.firebase.apps.length) window.firebase.initializeApp(CONFIG.FIREBASE_CONFIG);
          return window.firebase.messaging();
        })
        .catch(function (err) {
          messagingPromise = null;
          throw err;
        });
    }
    return messagingPromise;
  }

  async function fetchFcmToken() {
    const registration = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const messaging = await getMessaging();
    return messaging.getToken({ vapidKey: CONFIG.FIREBASE_VAPID_KEY, serviceWorkerRegistration: registration });
  }

  function deviceLabel() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return "Android";
    if (/Mac/.test(ua)) return "Mac";
    return "PC";
  }

  function renderPushPanel(message) {
    const availability = pushAvailability();
    const texts = {
      unconfigured: "通知の設定がまだ終わっていません。",
      "ios-browser": "iPhone・iPad では、Safari の共有ボタンから「ホーム画面に追加」したアプリで開くと通知を受け取れます。",
      unsupported: "このブラウザは通知に対応していません。",
      denied: "通知が拒否されています。端末の設定から、このアプリの通知をオンにしてください。",
      enabled: "この端末で通知を受け取ります。生徒から提出やメッセージが届くとお知らせします。",
      available: "生徒から提出やメッセージが届いたら、この端末にお知らせします。"
    };
    $("push-status").textContent = message || texts[availability];
    $("push-enable").hidden = availability !== "available";
    $("push-test").hidden = availability !== "enabled";
    $("push-disable").hidden = availability !== "enabled";
    $("push-dot").hidden = availability !== "enabled";
  }

  function openPushPanel() {
    showError($("push-error"), "");
    renderPushPanel();
    $("push-panel").hidden = false;
  }

  function closePushPanel() {
    $("push-panel").hidden = true;
  }

  async function enablePush() {
    const button = $("push-enable");
    showError($("push-error"), "");
    // 許可ダイアログはタップの直後に出さないと iOS で無視されるので、他の await より先に呼ぶ
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      renderPushPanel();
      return;
    }
    button.disabled = true;
    button.textContent = "設定しています…";
    try {
      const token = await fetchFcmToken();
      await api("tutorRegisterPush", { fcmToken: token, label: deviceLabel() });
      storageSet(PUSH_TOKEN_KEY, token);
      renderPushPanel();
    } catch (err) {
      console.warn(err);
      if (err.code !== "INVALID_TOKEN") showError($("push-error"), "通知の設定に失敗しました。通信状態を確認して、もう一度お試しください");
    } finally {
      button.disabled = false;
      button.textContent = "この端末で通知を受け取る";
    }
  }

  async function disablePush() {
    const token = storageGet(PUSH_TOKEN_KEY);
    storageRemove(PUSH_TOKEN_KEY);
    renderPushPanel();
    try {
      if (token) await api("tutorUnregisterPush", { fcmToken: token });
      const messaging = await getMessaging();
      await messaging.deleteToken();
    } catch (err) {
      // 端末側の登録が残っても、サーバーから消えていれば通知は届かない
      console.warn(err);
    }
  }

  async function sendTestPush() {
    const button = $("push-test");
    button.disabled = true;
    showError($("push-error"), "");
    try {
      const result = await api("tutorTestPush");
      renderPushPanel(result.sent > 0
        ? "テスト通知を送りました。数秒で届きます。"
        : "送信できる端末がありませんでした。一度オフにして、もう一度オンにしてください。");
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("push-error"), err.message);
    } finally {
      button.disabled = false;
    }
  }

  /** FCM トークンは更新されることがあるので、開くたびに取り直して変わっていれば登録し直す */
  async function refreshPushToken() {
    if (pushAvailability() !== "enabled") {
      renderPushPanel();
      return;
    }
    renderPushPanel();
    try {
      const token = await fetchFcmToken();
      if (token && token !== storageGet(PUSH_TOKEN_KEY)) {
        await api("tutorRegisterPush", { fcmToken: token, label: deviceLabel() });
        storageSet(PUSH_TOKEN_KEY, token);
      }
    } catch (err) {
      console.warn(err);
    }
  }

  function onServiceWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "push") {
      // アプリを開いている間に届いた通知は、画面もすぐ更新する
      poll();
    } else if (data.type === "open-student" && data.studentId) {
      state.pendingStudentId = data.studentId;
      loadStudents();
    }
  }

  // ---------------------------------------------------------------------------
  // ポーリング

  function poll() {
    loadStudents();
    if (state.selectedId) loadThread();
    if (state.selectedId && state.view === "plan") loadPlan();
    // 終わった授業を一覧から外す。予定は講師しか変えないので取り直さない
    if (state.selectedId && state.view === "lessons") renderLessons();
  }

  // ---------------------------------------------------------------------------
  // 計画（spec §14）

  const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  function getPlanView() {
    if (!state.planView) {
      state.planView = new window.PlanView($("tutor-plan-root"), {
        editable: false,
        emptyText: "まだ目標がありません。「＋ 目標を追加」から作れます",
        onOpenPhoto: openPlanPhoto,
        goalActions: function (goal, container) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "icon-button";
          edit.setAttribute("aria-label", goal.title + "を編集");
          edit.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
          edit.addEventListener("click", function () { openGoalForm(goal); });
          const del = document.createElement("button");
          del.type = "button";
          del.className = "icon-button danger";
          del.setAttribute("aria-label", goal.title + "を削除");
          del.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          del.addEventListener("click", function () { deleteGoal(goal); });
          container.append(edit, del);
        }
      });
    }
    return state.planView;
  }

  /** 生徒が撮った見開きの写真を大きく表示する（spec §14.7） */
  function openPlanPhoto(photo, canEdit, context) {
    const pages = photo.fromPage === photo.toPage ? "p." + photo.fromPage : "p." + photo.fromPage + "〜" + photo.toPage;
    openFileViewer(context.goal.title + " " + pages, function () {
      return api("tutorGetPlanPhoto", { photoId: photo.photoId });
    });
  }

  // ---------------------------------------------------------------------------
  // ファイルの表示（提出物のプレビューと計画の写真で共通）

  let fileViewerToken = 0;

  /** load は { mimeType, dataBase64 } を返す。PDF はページごとの画像にして並べる（docs/pdf-view.js） */
  async function openFileViewer(title, load) {
    const token = ++fileViewerToken;
    const pages = $("file-viewer-pages");
    const status = $("file-viewer-status");
    const isCancelled = function () { return token !== fileViewerToken; };
    $("file-viewer-title").textContent = title;
    window.PdfView.clear(pages);
    showError(status, "読み込んでいます…");
    $("file-viewer").hidden = false;
    try {
      const data = await load();
      if (isCancelled()) return;
      const bytes = window.PdfView.base64ToBytes(data.dataBase64);
      if (data.mimeType === "application/pdf") {
        await window.PdfView.render(bytes, pages, {
          isCancelled: isCancelled,
          onProgress: function (i, total) { showError(status, "ページを表示しています… (" + i + "/" + total + ")"); }
        });
      } else {
        const img = document.createElement("img");
        img.className = "viewer-page";
        img.alt = title;
        img.src = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }));
        pages.appendChild(img);
      }
      if (!isCancelled()) showError(status, "");
    } catch (err) {
      if (isCancelled() || err.code === "INVALID_TOKEN") return;
      showError(status, err instanceof ApiError ? err.message : "ファイルを表示できませんでした。電波の良い場所でもう一度お試しください");
    }
  }

  function closeFileViewer() {
    fileViewerToken++;
    window.PdfView.clear($("file-viewer-pages"));
    $("file-viewer").hidden = true;
  }

  async function loadPlan() {
    const studentId = state.selectedId;
    if (!studentId || state.loadingPlan === studentId) return;
    state.loadingPlan = studentId;
    try {
      const data = await api("tutorGetPlan", { studentId: studentId });
      if (state.selectedId !== studentId) return;
      writeCache("plan." + studentId, data);
      getPlanView().setData(data);
      showError($("tutor-plan-error"), "");
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("tutor-plan-error"), err.message);
    } finally {
      if (state.loadingPlan === studentId) state.loadingPlan = null;
    }
  }

  function planToday() {
    const view = state.planView;
    return view && view.data ? view.data.today : window.StudyPlan.studyDateNow();
  }

  function openGoalForm(goal) {
    state.editingGoal = goal || null;
    $("goal-form-title").textContent = goal ? "目標を編集" : "目標を追加";
    $("goal-title").value = goal ? goal.title : "";
    $("goal-start-page").value = goal ? goal.startPage : "";
    $("goal-end-page").value = goal ? goal.endPage : "";
    $("goal-start-date").value = goal ? goal.startDate : planToday();
    $("goal-due-date").value = goal ? goal.dueDate : "";
    $("goal-rest-date").value = "";
    const spread = goal && goal.spreadStart === "odd" ? "odd" : "even";
    document.querySelectorAll("input[name=goal-spread]").forEach(function (r) { r.checked = r.value === spread; });
    state.formRestWeekdays = goal ? goal.restWeekdays.slice() : [];
    state.formRestDates = goal ? goal.restDates.slice() : [];
    showError($("goal-error"), "");
    renderGoalForm();
    $("goal-panel").hidden = false;
    $("goal-title").focus();
  }

  function closeGoalForm() {
    $("goal-panel").hidden = true;
    state.editingGoal = null;
  }

  function readGoalForm() {
    const num = function (id) { const v = $(id).value.trim(); return v === "" ? NaN : Number(v); };
    return {
      goalId: state.editingGoal ? state.editingGoal.goalId : undefined,
      title: $("goal-title").value.trim(),
      startPage: num("goal-start-page"),
      endPage: num("goal-end-page"),
      startDate: $("goal-start-date").value,
      dueDate: $("goal-due-date").value,
      restWeekdays: state.formRestWeekdays.slice().sort(),
      restDates: state.formRestDates.slice().sort(),
      spreadStart: (document.querySelector("input[name=goal-spread]:checked") || {}).value || "even"
    };
  }

  /** 見開きの選択肢を、入力した始めのページで例示する。「10と11」より実際のページ番号の方が手元のテキストと見比べやすいため */
  function renderSpreadLabels() {
    const raw = Number($("goal-start-page").value);
    const s = Number.isInteger(raw) && raw >= 1 ? raw : 10;
    function pair(startParity) {
      let first = s % 2 === startParity ? s : s - 1;
      if (first < 1) first += 2;
      return "p." + first + " と " + (first + 1) + " が見開き";
    }
    $("goal-spread-even").textContent = pair(0);
    $("goal-spread-odd").textContent = pair(1);
  }

  /** 入力に合わせて「何日でどれくらいのペースか」をその場で見せる。期限の決め方の目安になるため */
  function renderGoalPreview() {
    renderSpreadLabels();
    const g = readGoalForm();
    const preview = $("goal-preview");
    if (!Number.isInteger(g.startPage) || !Number.isInteger(g.endPage) || g.endPage < g.startPage || !g.startDate || !g.dueDate || g.dueDate < g.startDate) {
      preview.textContent = "";
      return;
    }
    let days = 0;
    for (let d = g.startDate; d <= g.dueDate; d = window.StudyPlan.addDays(d, 1)) {
      if (!window.StudyPlan.isRestDay(g, d)) days++;
      if (days > 400) break;
    }
    const pages = g.endPage - g.startPage + 1;
    preview.textContent = days === 0
      ? "勉強する日がありません。休みを見直してください"
      : "勉強する日 " + days + "日 ／ " + pages + "ページ → 1日あたり約" + Math.ceil(pages / days) + "ページ";
  }

  function renderGoalForm() {
    const box = $("goal-weekdays");
    box.replaceChildren();
    WEEKDAY_LABELS.forEach(function (label, i) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(state.formRestWeekdays.indexOf(i) !== -1));
      b.setAttribute("aria-label", label + "曜日を休みにする");
      b.addEventListener("click", function () {
        const at = state.formRestWeekdays.indexOf(i);
        if (at === -1) state.formRestWeekdays.push(i);
        else state.formRestWeekdays.splice(at, 1);
        renderGoalForm();
      });
      box.appendChild(b);
    });

    const list = $("goal-rest-dates");
    list.replaceChildren();
    state.formRestDates.slice().sort().forEach(function (d) {
      const li = document.createElement("li");
      const p = d.split("-");
      li.appendChild(document.createTextNode(Number(p[1]) + "/" + Number(p[2]) + "(" + WEEKDAY_LABELS[window.StudyPlan.weekday(d)] + ")"));
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", d + "の休みを外す");
      x.addEventListener("click", function () {
        state.formRestDates = state.formRestDates.filter(function (v) { return v !== d; });
        renderGoalForm();
      });
      li.appendChild(x);
      list.appendChild(li);
    });
    renderGoalPreview();
  }

  function addRestDate() {
    const d = $("goal-rest-date").value;
    if (!d) return;
    if (state.formRestDates.indexOf(d) === -1) state.formRestDates.push(d);
    $("goal-rest-date").value = "";
    renderGoalForm();
  }

  async function saveGoal(event) {
    event.preventDefault();
    const studentId = state.selectedId;
    const goal = readGoalForm();
    // サーバーでも検証するが、よくある入力漏れはその場で知らせる
    if (!goal.title) return showError($("goal-error"), "テキスト名を入力してください");
    if (!Number.isInteger(goal.startPage) || !Number.isInteger(goal.endPage)) return showError($("goal-error"), "ページを数字で入力してください");
    if (!goal.dueDate) return showError($("goal-error"), "期限を入力してください");
    const button = $("goal-save");
    button.disabled = true;
    button.textContent = "保存しています…";
    try {
      await api("tutorSaveGoal", { studentId: studentId, goal: goal });
      closeGoalForm();
      await loadPlan();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("goal-error"), err.message);
    } finally {
      button.disabled = false;
      button.textContent = "保存";
    }
  }

  async function deleteGoal(goal) {
    if (!window.confirm("「" + goal.title + "」の目標を削除しますか？\n生徒の画面からも消えます。")) return;
    try {
      await api("tutorDeleteGoal", { goalId: goal.goalId });
      await loadPlan();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("tutor-plan-error"), err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 授業の予定（spec §15）

  async function loadLessons() {
    const studentId = state.selectedId;
    if (!studentId || state.loadingLessons === studentId) return;
    state.loadingLessons = studentId;
    try {
      const data = await api("tutorGetLessons", { studentId: studentId });
      if (state.selectedId !== studentId) return;
      state.lessons = data;
      writeCache("lessons." + studentId, data);
      showError($("tutor-lessons-error"), "");
      renderLessons();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("tutor-lessons-error"), err.message);
    } finally {
      if (state.loadingLessons === studentId) state.loadingLessons = null;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function miniButton(label, onClick, danger) {
    const b = el("button", "mini-btn" + (danger ? " danger" : ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function iconButton(label, svgPath, onClick, danger) {
    const b = el("button", "icon-button" + (danger ? " danger" : ""));
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="' + svgPath + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.addEventListener("click", onClick);
    return b;
  }

  function ruleRangeText(rule) {
    const L = window.Lessons;
    const today = L.nowInTokyo().date;
    if (rule.startDate > today && rule.endDate) return L.shortDate(rule.startDate) + "〜" + L.shortDate(rule.endDate);
    if (rule.startDate > today) return L.shortDate(rule.startDate) + "から";
    if (rule.endDate) return L.shortDate(rule.endDate) + "まで";
    return "";
  }

  function renderLessons() {
    const L = window.Lessons;
    const data = state.lessons;
    const ruleList = $("rule-list");
    const list = $("tutor-lesson-list");
    ruleList.replaceChildren();
    list.replaceChildren();
    $("rules-empty").hidden = !data || data.rules.length > 0;
    if (!data) {
      $("tutor-lessons-empty").textContent = "読み込んでいます…";
      $("tutor-lessons-empty").hidden = false;
      return;
    }

    data.rules.slice().sort(function (a, b) {
      return a.weekday !== b.weekday ? a.weekday - b.weekday : a.startTime < b.startTime ? -1 : 1;
    }).forEach(function (rule) {
      const li = el("li", "rule-item");
      const text = el("div", "rule-text");
      text.appendChild(el("p", "rule-main", L.describeRule(rule)));
      const range = ruleRangeText(rule);
      if (range) text.appendChild(el("p", "rule-range", range));
      li.append(
        text,
        iconButton(L.describeRule(rule) + "を編集", "M4 20h4L19 9l-4-4L4 16z", function () { openRuleForm(rule); }),
        iconButton(L.describeRule(rule) + "を削除", "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13", function () { deleteRule(rule); }, true)
      );
      ruleList.appendChild(li);
    });

    const items = L.upcoming(data);
    const next = L.nextLesson(items);
    $("tutor-lessons-empty").textContent = data.rules.length
      ? "これからの予定はありません"
      : "予定はまだありません";
    $("tutor-lessons-empty").hidden = items.length > 0;
    items.forEach(function (x) {
      const li = el("li", "lesson-row" + (x.cancelled ? " is-cancelled" : ""));
      const main = el("div", "lesson-row-main");
      main.append(el("span", "lesson-row-date", L.shortDate(x.date)), el("span", "lesson-row-time", L.timeRange(x)));
      li.appendChild(main);
      if (x === next) li.appendChild(el("span", "lesson-tag tag-next", x.ongoing ? "授業中" : "次回"));
      if (x.kind === "extra") li.appendChild(el("span", "lesson-tag tag-extra", "追加"));
      if (x.cancelled) li.appendChild(el("span", "lesson-tag tag-off", "休み"));

      const actions = el("div", "lesson-actions");
      if (x.kind === "weekly" && x.cancelled) {
        actions.appendChild(miniButton("休みを取り消す", function () { setCancelled(x, false); }));
      } else if (x.kind === "weekly") {
        actions.append(
          miniButton("日時を変更", function () { openLessonForm("move", x); }),
          miniButton("休みにする", function () { setCancelled(x, true); })
        );
      } else {
        actions.append(
          miniButton("変更", function () { openLessonForm("edit", x); }),
          miniButton("削除", function () { deleteLesson(x); }, true)
        );
      }
      if (x.note) li.appendChild(el("p", "lesson-note", x.note));
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  async function lessonAction(action, params) {
    showError($("tutor-lessons-error"), "");
    try {
      await api(action, Object.assign({ studentId: state.selectedId }, params));
      await loadLessons();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("tutor-lessons-error"), err.message);
    }
  }

  function setCancelled(item, cancelled) {
    const L = window.Lessons;
    const label = L.shortDate(item.date) + " " + L.timeRange(item);
    const question = cancelled ? label + " の授業をお休みにしますか？" : label + " の授業を元に戻しますか？";
    if (!window.confirm(question)) return;
    lessonAction("tutorSetLessonCancelled", { ruleId: item.ruleId, date: item.date, cancelled: cancelled });
  }

  function deleteLesson(item) {
    const L = window.Lessons;
    if (!window.confirm(L.shortDate(item.date) + " " + L.timeRange(item) + " の授業を削除しますか？")) return;
    lessonAction("tutorDeleteLesson", { lessonId: item.lessonId });
  }

  function deleteRule(rule) {
    const L = window.Lessons;
    if (!window.confirm("「" + L.describeRule(rule) + "」を削除しますか？\nこれからの予定からも消えます（追加した授業は残ります）。")) return;
    lessonAction("tutorDeleteLessonRule", { ruleId: rule.ruleId });
  }

  function openRuleForm(rule) {
    state.editingRule = rule || null;
    state.formRuleWeekday = rule ? rule.weekday : null;
    $("rule-form-title").textContent = rule ? "毎週の授業を編集" : "毎週の授業を追加";
    $("rule-start-time").value = rule ? rule.startTime : "";
    $("rule-end-time").value = rule ? rule.endTime : "";
    $("rule-start-date").value = rule ? rule.startDate : window.Lessons.nowInTokyo().date;
    $("rule-end-date").value = rule && rule.endDate ? rule.endDate : "";
    showError($("rule-error"), "");
    renderRuleWeekdays();
    $("rule-panel").hidden = false;
  }

  function closeRuleForm() {
    $("rule-panel").hidden = true;
    state.editingRule = null;
  }

  function renderRuleWeekdays() {
    const box = $("rule-weekdays");
    box.replaceChildren();
    WEEKDAY_LABELS.forEach(function (label, i) {
      const b = el("button", "", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.formRuleWeekday === i));
      b.setAttribute("aria-label", label + "曜日");
      b.addEventListener("click", function () {
        state.formRuleWeekday = i;
        renderRuleWeekdays();
      });
      box.appendChild(b);
    });
  }

  async function saveRule(event) {
    event.preventDefault();
    const rule = {
      ruleId: state.editingRule ? state.editingRule.ruleId : undefined,
      weekday: state.formRuleWeekday,
      startTime: $("rule-start-time").value,
      endTime: $("rule-end-time").value,
      startDate: $("rule-start-date").value,
      endDate: $("rule-end-date").value || null
    };
    // サーバーでも検証するが、よくある入力漏れはその場で知らせる
    if (rule.weekday === null) return showError($("rule-error"), "曜日を選んでください");
    if (!rule.startTime || !rule.endTime) return showError($("rule-error"), "開始と終了の時刻を入力してください");
    if (rule.endTime <= rule.startTime) return showError($("rule-error"), "終了の時刻は開始より後にしてください");
    const button = $("rule-save");
    button.disabled = true;
    button.textContent = "保存しています…";
    try {
      await api("tutorSaveLessonRule", { studentId: state.selectedId, rule: rule });
      closeRuleForm();
      await loadLessons();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("rule-error"), err.message);
    } finally {
      button.disabled = false;
      button.textContent = "保存";
    }
  }

  /** "19:00" に分を足す。追加の授業の終了時刻を、開始に合わせて自動で入れるため */
  function addMinutes(t, minutes) {
    const p = t.split(":");
    const total = Math.min(23 * 60 + 59, Number(p[0]) * 60 + Number(p[1]) + minutes);
    return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  function minutesBetween(a, b) {
    const pa = a.split(":");
    const pb = b.split(":");
    return (Number(pb[0]) * 60 + Number(pb[1])) - (Number(pa[0]) * 60 + Number(pa[1]));
  }

  function openLessonForm(mode, item) {
    const L = window.Lessons;
    state.lessonForm = { mode: mode, item: item || null };
    const lead = $("lesson-form-lead");
    $("lesson-form-title").textContent = mode === "move" ? "日時を変更" : mode === "edit" ? "授業を変更" : "授業を追加";
    if (mode === "move") {
      lead.textContent = L.shortDate(item.date) + " " + L.timeRange(item) + " の授業はお休みになり、ここで選んだ日時に移ります";
    }
    lead.hidden = mode !== "move";
    // 新しく足すときは、毎週の授業と同じ長さを最初から入れておく
    const base = item || (state.lessons && state.lessons.rules[0]) || null;
    $("lesson-date").value = item ? item.date : "";
    $("lesson-start-time").value = base ? base.startTime : "";
    $("lesson-end-time").value = base ? base.endTime : "";
    $("lesson-note").value = mode === "edit" ? item.note : mode === "move" ? "振替" : "";
    $("lesson-start-time").dataset.prev = $("lesson-start-time").value;
    $("lesson-date").min = L.nowInTokyo().date;
    showError($("lesson-error"), "");
    $("lesson-panel").hidden = false;
  }

  function closeLessonForm() {
    $("lesson-panel").hidden = true;
    state.lessonForm = null;
  }

  /** 開始時刻を変えたら、授業の長さを保ったまま終了時刻もずらす */
  function onLessonStartChange() {
    const start = $("lesson-start-time");
    const end = $("lesson-end-time");
    const prev = start.dataset.prev;
    if (prev && end.value && start.value) {
      const length = minutesBetween(prev, end.value);
      if (length > 0) end.value = addMinutes(start.value, length);
    }
    start.dataset.prev = start.value;
  }

  async function saveLesson(event) {
    event.preventDefault();
    const form = state.lessonForm;
    if (!form) return;
    const lesson = {
      lessonId: form.mode === "edit" ? form.item.lessonId : undefined,
      date: $("lesson-date").value,
      startTime: $("lesson-start-time").value,
      endTime: $("lesson-end-time").value,
      note: $("lesson-note").value.trim()
    };
    if (!lesson.date) return showError($("lesson-error"), "日付を入力してください");
    if (!lesson.startTime || !lesson.endTime) return showError($("lesson-error"), "開始と終了の時刻を入力してください");
    if (lesson.endTime <= lesson.startTime) return showError($("lesson-error"), "終了の時刻は開始より後にしてください");
    const params = { studentId: state.selectedId, lesson: lesson };
    if (form.mode === "move") params.replaces = { ruleId: form.item.ruleId, date: form.item.date };
    const button = $("lesson-save");
    button.disabled = true;
    button.textContent = "保存しています…";
    try {
      await api("tutorSaveLesson", params);
      closeLessonForm();
      await loadLessons();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("lesson-error"), err.message);
    } finally {
      button.disabled = false;
      button.textContent = "保存";
    }
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
      const pushToken = storageGet(PUSH_TOKEN_KEY);
      try {
        // ログアウトした端末に生徒のメッセージが届き続けないよう、通知の登録も外す
        if (pushToken) await api("tutorUnregisterPush", { fcmToken: pushToken });
        await api("tutorLogout");
      } catch (_) { /* 失効済みでもローカルは消す */ }
      logout();
    });
    $("back-button").addEventListener("click", backToList);
    document.querySelectorAll(".segmented button").forEach(function (b) {
      b.addEventListener("click", function () { switchView(b.dataset.view); });
    });
    $("add-goal").addEventListener("click", function () { openGoalForm(null); });
    $("add-rule").addEventListener("click", function () { openRuleForm(null); });
    $("rule-close").addEventListener("click", closeRuleForm);
    $("rule-panel").addEventListener("click", function (e) { if (e.target === $("rule-panel")) closeRuleForm(); });
    $("rule-form").addEventListener("submit", saveRule);
    $("add-lesson").addEventListener("click", function () { openLessonForm("add", null); });
    $("lesson-close").addEventListener("click", closeLessonForm);
    $("lesson-panel").addEventListener("click", function (e) { if (e.target === $("lesson-panel")) closeLessonForm(); });
    $("lesson-form").addEventListener("submit", saveLesson);
    $("lesson-start-time").addEventListener("focus", function () { this.dataset.prev = this.value; });
    $("lesson-start-time").addEventListener("change", onLessonStartChange);
    $("file-viewer-close").addEventListener("click", closeFileViewer);
    $("goal-close").addEventListener("click", closeGoalForm);
    $("goal-panel").addEventListener("click", function (e) { if (e.target === $("goal-panel")) closeGoalForm(); });
    $("goal-form").addEventListener("submit", saveGoal);
    $("goal-rest-add").addEventListener("click", addRestDate);
    ["goal-start-page", "goal-end-page", "goal-start-date", "goal-due-date"].forEach(function (id) {
      $(id).addEventListener("input", renderGoalPreview);
    });
    $("composer").addEventListener("submit", onSend);
    $("composer-input").addEventListener("input", autoGrowComposer);
    document.addEventListener("visibilitychange", onVisibilityChange);

    $("push-button").addEventListener("click", openPushPanel);
    $("push-close").addEventListener("click", closePushPanel);
    $("push-panel").addEventListener("click", function (e) { if (e.target === $("push-panel")) closePushPanel(); });
    $("push-enable").addEventListener("click", enablePush);
    $("push-disable").addEventListener("click", disablePush);
    $("push-test").addEventListener("click", sendTestPush);
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
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
