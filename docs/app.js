(function () {
  "use strict";

  const GAS_URL = window.APP_CONFIG && window.APP_CONFIG.GAS_URL;
  const TOKEN_KEY = "tutorapp.token";
  const NAME_KEY = "tutorapp.name";
  // GAS は1回の応答に1〜2秒かかるので、前回の表示を保存しておき、開いた瞬間に出す
  const MESSAGES_CACHE_KEY = "tutorapp.cache.messages";
  const HISTORY_CACHE_KEY = "tutorapp.cache.history";
  const PLAN_CACHE_KEY = "tutorapp.cache.plan";
  const LESSONS_CACHE_KEY = "tutorapp.cache.lessons";
  const MESSAGES_CACHE_LIMIT = 100;
  const POLL_INTERVAL_MS = 30 * 1000;
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  // 1ページの目安。影やノイズの多い写真は同じ解像度でも2倍以上重くなり、講師の iPad での表示が遅れて授業が止まるため、
  // これを超えたら画質→解像度の順に落とす（spec §8.1）
  const PAGE_TARGET_BYTES = 300 * 1024;
  // 上から順に試し、目安に収まった段で止める。最後の段（長辺1400px・画質0.6）でも手書きの文字は読める
  const JPEG_STEPS = [
    { edge: 2000, quality: 0.8 },
    { edge: 2000, quality: 0.7 },
    { edge: 1600, quality: 0.7 },
    { edge: 1600, quality: 0.6 },
    { edge: 1400, quality: 0.6 }
  ];
  const THUMB_EDGE_PX = 240;
  const DONE_AUTO_RETURN_MS = 3000;
  const TIME_ZONE = "Asia/Tokyo";

  const TEXT = {
    network: "通信に失敗しました。電波の良い場所でもう一度お試しください",
    tooLarge: "ファイルが大きすぎます。ページ数を減らすか、画質を下げてお試しください",
    unknown: "うまくいきませんでした。少し待ってからもう一度お試しください",
    decodeFailed: "この画像形式は読み込めませんでした。カメラで撮り直してください",
    mixed: "画像とPDFは一緒に提出できません。どちらかを選び直してください",
    multiPdf: "PDFは1つずつ提出してください",
    unsupported: "PDFか画像のファイルを選んでください",
    sessionExpired: "合言葉を確認できませんでした。もう一度入力してください",
    pdfFailed: "PDFの作成に失敗しました。もう一度お試しください"
  };

  const $ = function (id) { return document.getElementById(id); };

  const state = {
    token: null,
    tab: "messages",
    messages: [],
    messageIds: new Set(),
    lastCreatedAt: null,
    messagesLoaded: false,
    // 送信中のメッセージ。サーバーの一覧とは別に持ち、ポーリングで上書きされないようにする
    pending: [],
    pollTimer: null,
    loadingMessages: false,
    planView: null,
    loadingPlan: false,
    // 授業の予定（spec §15）。サーバーの { rules, changes } をそのまま持ち、表示のたびに展開する
    lessons: null,
    loadingLessons: false,
    // 朝6時をまたいだら計画を取り直すため、最後に見た「勉強の日付」を覚えておく
    lastStudyDate: null,
    submit: {
      status: "idle", // idle | editing | uploading | done
      mode: null,     // images | pdf
      pages: [],
      pdfFile: null,
      doneTimer: null
    }
  };

  // ---------------------------------------------------------------------------
  // localStorage（プライベートモード等で例外を投げることがあるので必ず包む）

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* 保存できなくても今回のセッションは使える */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  }

  /** 別の生徒の表示が一瞬でも出ないよう、保存時の合言葉と一致するときだけ使う */
  function readCache(key) {
    try {
      const cached = JSON.parse(storageGet(key) || "null");
      return cached && cached.owner === state.token ? cached.items : null;
    } catch (_) {
      return null;
    }
  }

  function writeCache(key, items) {
    storageSet(key, JSON.stringify({ owner: state.token, items: items }));
  }

  function clearCaches() {
    storageRemove(MESSAGES_CACHE_KEY);
    storageRemove(HISTORY_CACHE_KEY);
    storageRemove(PLAN_CACHE_KEY);
    storageRemove(LESSONS_CACHE_KEY);
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
    const payload = Object.assign({ action: action, token: state.token }, params || {});
    let res;
    try {
      // text/plain にするのは CORS プリフライトを起こさないため。GAS は OPTIONS に応答できない
      res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow" // GAS Web App は 302 で googleusercontent.com に転送する
      });
    } catch (_) {
      throw new ApiError("NETWORK", TEXT.network);
    }

    let body;
    try {
      body = await res.json();
    } catch (_) {
      // Google 側の障害時は HTML が返ってくる
      throw new ApiError("NETWORK", TEXT.network);
    }

    if (!body || body.ok !== true) {
      const code = (body && body.error && body.error.code) || "INTERNAL_ERROR";
      const message = (body && body.error && body.error.message) || TEXT.unknown;
      if (code === "INVALID_TOKEN" && action !== "login") {
        logout(TEXT.sessionExpired);
      }
      throw new ApiError(code, message);
    }
    return body.data;
  }

  /** 生徒に見せる文言へ変換する。技術的な詳細は出さない */
  function userMessage(err) {
    if (err instanceof ApiError) {
      if (err.code === "FILE_TOO_LARGE") return TEXT.tooLarge;
      if (err.code === "INTERNAL_ERROR") return TEXT.unknown;
      return err.message || TEXT.unknown;
    }
    return TEXT.unknown;
  }

  // ---------------------------------------------------------------------------
  // ログイン

  function showLogin(errorText) {
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-error").textContent = errorText || "";
    $("token-input").value = "";
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    // 口頭で伝えた合言葉は大文字や空白が混ざりやすいので、ここで吸収する
    const token = $("token-input").value.replace(/\s+/g, "").toLowerCase();
    const errorEl = $("login-error");
    errorEl.textContent = "";

    if (!token) {
      errorEl.textContent = "合言葉を入力してください";
      return;
    }
    if (!/^[a-z0-9]{16}$/.test(token)) {
      errorEl.textContent = "合言葉は英字と数字の16文字です。もう一度確認してください";
      return;
    }

    const button = $("login-button");
    button.disabled = true;
    button.textContent = "確認しています…";
    state.token = token;
    try {
      const data = await api("login");
      storageSet(TOKEN_KEY, token);
      storageSet(NAME_KEY, data.name);
      enterApp(data.name);
    } catch (err) {
      state.token = null;
      errorEl.textContent = err.code === "INVALID_TOKEN" ? "合言葉が正しくありません" : userMessage(err);
    } finally {
      button.disabled = false;
      button.textContent = "はじめる";
    }
  }

  function logout(message) {
    storageRemove(TOKEN_KEY);
    storageRemove(NAME_KEY);
    clearCaches();
    state.token = null;
    stopPolling();
    state.messages = [];
    state.messageIds = new Set();
    state.lastCreatedAt = null;
    state.messagesLoaded = false;
    state.pending = [];
    state.planView = null;
    $("plan-root").replaceChildren();
    state.lessons = null;
    renderLessons();
    renderMessages();
    resetSubmit();
    closeViewer();
    $("upload-overlay").hidden = true;
    showLogin(message);
  }

  function enterApp(name) {
    $("student-name").textContent = name || "";
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    switchTab("messages");
    // 保存した表示が無くても「読み込んでいます…」を出す（HTML の初期文言は「まだありません」のため）
    renderMessages();
    restoreCaches();
    loadMessages({ scrollToBottom: true });
    loadHistory();
    loadLessons();
    startPolling();
  }

  async function boot() {
    const token = storageGet(TOKEN_KEY);
    if (!token) {
      showLogin();
      return;
    }
    state.token = token;
    // 電波が悪いだけでログイン画面に戻さないよう、前回の名前で先に画面を出す
    enterApp(storageGet(NAME_KEY));
    try {
      const data = await api("login");
      storageSet(NAME_KEY, data.name);
      $("student-name").textContent = data.name;
    } catch (_) {
      // INVALID_TOKEN なら api() 内でログイン画面に戻している
    }
  }

  // ---------------------------------------------------------------------------
  // タブ

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    });
    $("tab-messages").hidden = tab !== "messages";
    $("tab-lessons").hidden = tab !== "lessons";
    $("tab-plan").hidden = tab !== "plan";
    $("tab-submit").hidden = tab !== "submit";
    if (tab === "plan") loadPlan();
    if (tab === "lessons") loadLessons();
    if (tab === "messages") scrollMessagesToBottom();
    // 先生が Drive で書き込んだかどうかは生徒側では気づけないので、開くたびに取り直す
    if (tab === "submit" && state.submit.status === "idle") loadHistory();
  }

  // ---------------------------------------------------------------------------
  // やりとり

  const dayFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, month: "long", day: "numeric", weekday: "short" });
  const timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function scrollMessagesToBottom() {
    const list = $("message-list");
    list.scrollTop = list.scrollHeight;
  }

  function restoreCaches() {
    const messages = readCache(MESSAGES_CACHE_KEY);
    if (messages && messages.length) {
      addMessages(messages);
      state.messagesLoaded = true;
      renderMessages();
      scrollMessagesToBottom();
    }
    const history = readCache(HISTORY_CACHE_KEY);
    if (history) renderHistory(history);
    const plan = readCache(PLAN_CACHE_KEY);
    if (plan) getPlanView().setData(plan);
    state.lessons = readCache(LESSONS_CACHE_KEY);
    renderLessons();
  }

  // ---------------------------------------------------------------------------
  // 計画（spec §14）

  function getPlanView() {
    if (!state.planView) {
      state.planView = new window.PlanView($("plan-root"), {
        editable: true,
        order: ["day", "calendar", "goals"],
        emptyText: "先生が目標を立てると、ここに毎日のやることが表示されます",
        onSetProgress: function (goalId, studyDate, throughPage) {
          $("plan-error").hidden = true;
          return api("setProgress", { goalId: goalId, studyDate: studyDate, throughPage: throughPage }).then(function () {
            writeCache(PLAN_CACHE_KEY, state.planView.data);
          }).catch(function (err) {
            // 過ぎた日になっていた等で弾かれたときは、最新の状態に揃える
            if (err.code === "VALIDATION_ERROR") loadPlan();
            throw new Error(err.code === "INVALID_TOKEN" ? "" : userMessage(err) + "（記録は保存されていません）");
          });
        },
        onError: function (message) {
          if (!message) return;
          $("plan-error").textContent = message;
          $("plan-error").hidden = false;
        },
        onSavingChange: function (saving) { $("plan-saving").hidden = !saving; },
        onTakePhoto: takePlanPhoto,
        onOpenPhoto: openPlanPhoto
      });
      state.planView.render();
    }
    return state.planView;
  }

  /**
   * 見開きの写真を撮って送る（spec §14.7）。撮る＝やった、なのでその見開きの最後のページまでチェックも付ける。
   * カメラはタップの直後に開かないと iOS で無視されるので、await より前に input.click() する
   */
  function takePlanPhoto(goal, entry, spread) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.className = "visually-hidden";
    document.body.appendChild(input);
    input.addEventListener("change", async function () {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const view = getPlanView();
      $("plan-error").hidden = true;
      view.setUploading(goal.goalId, entry.date, spread.from, true);
      const current = entry.record === null ? entry.from - 1 : entry.record;
      if (spread.to > current) view.setProgress(goal.goalId, entry.date, spread.to);
      try {
        let page;
        try {
          page = await processImage(file);
        } catch (_) {
          throw new ApiError("VALIDATION_ERROR", TEXT.decodeFailed);
        }
        URL.revokeObjectURL(page.thumbUrl);
        const dataBase64 = arrayBufferToBase64(await page.blob.arrayBuffer());
        const data = await api("uploadPlanPhoto", {
          goalId: goal.goalId, studyDate: entry.date, fromPage: spread.from, toPage: spread.to, dataBase64: dataBase64
        });
        view.addPhoto({ photoId: data.photoId, goalId: goal.goalId, studyDate: entry.date, fromPage: spread.from, toPage: spread.to });
        writeCache(PLAN_CACHE_KEY, view.data);
      } catch (err) {
        if (err.code === "INVALID_TOKEN") return;
        $("plan-error").textContent = "写真を送れませんでした。" + userMessage(err) + "（チェックは付いています）";
        $("plan-error").hidden = false;
      } finally {
        if (state.planView === view) view.setUploading(goal.goalId, entry.date, spread.from, false);
      }
    });
    input.click();
  }

  function openPlanPhoto(photo, canEdit, context) {
    const pages = photo.fromPage === photo.toPage ? "p." + photo.fromPage : "p." + photo.fromPage + "〜" + photo.toPage;
    showInViewer(context.goal.title + " " + pages, function () {
      return api("getPlanPhoto", { photoId: photo.photoId });
    }, canEdit ? {
      retake: function () { takePlanPhoto(context.goal, context.entry, context.spread); },
      remove: async function () {
        if (!window.confirm(pages + " の写真を削除しますか？\nページのチェックはそのまま残ります。")) return false;
        await api("deletePlanPhoto", { photoId: photo.photoId });
        getPlanView().removePhoto(photo.photoId);
        writeCache(PLAN_CACHE_KEY, getPlanView().data);
        return true;
      }
    } : null);
  }

  async function loadPlan() {
    if (state.loadingPlan || !state.token) return;
    state.loadingPlan = true;
    const view = getPlanView();
    try {
      const data = await api("getPlan");
      state.lastStudyDate = window.StudyPlan.studyDateNow();
      writeCache(PLAN_CACHE_KEY, data);
      view.setData(data);
      $("plan-error").hidden = true;
    } catch (err) {
      if (err.code === "INVALID_TOKEN") return;
      $("plan-error").textContent = userMessage(err);
      $("plan-error").hidden = false;
    } finally {
      state.loadingPlan = false;
    }
  }

  /**
   * アプリが隠れる・閉じられる直前に、まだ送れていないチェックを sendBeacon で送る。
   * スマホは画面を消したりアプリを切り替えたりすると通信を止めるが、sendBeacon は閉じた後もブラウザが送り届ける。
   * 応答は受け取れないので、次に計画を開いたときにサーバーの状態に揃う
   */
  function sendPendingProgress() {
    const view = state.planView;
    if (!view || !state.token || !navigator.sendBeacon) return;
    view.takePending().forEach(function (item) {
      const body = JSON.stringify({ action: "setProgress", token: state.token, goalId: item.goalId, studyDate: item.date, throughPage: item.through });
      // text/plain にする理由は api() と同じ（CORS のプリフライトを起こさない）
      navigator.sendBeacon(GAS_URL, new Blob([body], { type: "text/plain;charset=utf-8" }));
    });
  }

  /** 開きっぱなしで朝6時をまたいだら、組み替え後の計画を取り直す */
  function checkStudyDateRollover() {
    const now = window.StudyPlan.studyDateNow();
    if (state.lastStudyDate && now !== state.lastStudyDate) {
      state.lastStudyDate = now;
      loadPlan();
    }
  }

  // ---------------------------------------------------------------------------
  // 授業の予定（spec §15）

  async function loadLessons() {
    if (state.loadingLessons || !state.token) return;
    state.loadingLessons = true;
    try {
      const data = await api("getLessons");
      state.lessons = data;
      writeCache(LESSONS_CACHE_KEY, data);
      $("lessons-error").hidden = true;
      renderLessons();
    } catch (err) {
      if (err.code === "INVALID_TOKEN") return;
      // やりとりの上の「次の授業」は前回の表示のまま。エラーは授業タブにだけ出す
      $("lessons-error").textContent = userMessage(err);
      $("lessons-error").hidden = false;
    } finally {
      state.loadingLessons = false;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function lessonWhen(item) {
    return item.ongoing ? "授業中" : window.Lessons.relativeDay(item.date);
  }

  function renderLessons() {
    const L = window.Lessons;
    const root = $("lessons-root");
    const bar = $("next-lesson-bar");
    root.replaceChildren();
    if (!state.lessons) {
      bar.hidden = true;
      if (state.token) root.appendChild(el("p", "empty", "読み込んでいます…"));
      return;
    }
    const items = L.upcoming(state.lessons);
    const next = L.nextLesson(items);

    bar.hidden = !next;
    if (next) {
      bar.replaceChildren(
        el("span", "next-lesson-bar-label", "次の授業"),
        el("span", "next-lesson-bar-when", L.shortDate(next.date) + " " + L.timeRange(next)),
        el("span", "lesson-rel" + (next.ongoing ? " is-now" : ""), lessonWhen(next))
      );
      bar.setAttribute("aria-label", "次の授業 " + L.longDate(next.date) + " " + L.timeRange(next) + "。授業の予定を開く");
    }

    const card = el("section", "next-lesson-card");
    card.appendChild(el("h2", "next-lesson-title", "次の授業"));
    if (next) {
      const head = el("div", "next-lesson-head");
      head.append(el("p", "next-lesson-date", L.longDate(next.date)), el("span", "lesson-rel" + (next.ongoing ? " is-now" : ""), lessonWhen(next)));
      card.append(head, el("p", "next-lesson-time", L.timeRange(next)));
      if (next.note) card.appendChild(el("p", "lesson-note", next.note));
    } else {
      card.appendChild(el("p", "next-lesson-none", "次の授業はまだ決まっていません"));
    }
    root.appendChild(card);

    const rest = items.filter(function (x) { return x !== next; });
    if (rest.length) {
      root.appendChild(el("h2", "section-title lessons-section-title", "これからの予定"));
      const list = el("ul", "lesson-list");
      rest.forEach(function (x) {
        const li = el("li", "lesson-row" + (x.cancelled ? " is-cancelled" : ""));
        const main = el("div", "lesson-row-main");
        main.append(el("span", "lesson-row-date", L.shortDate(x.date)), el("span", "lesson-row-time", L.timeRange(x)));
        li.appendChild(main);
        if (x.kind === "extra") li.appendChild(el("span", "lesson-tag tag-extra", "追加"));
        if (x.cancelled) li.appendChild(el("span", "lesson-tag tag-off", "休み"));
        if (x.note) li.appendChild(el("p", "lesson-note", x.note));
        list.appendChild(li);
      });
      root.appendChild(list);
    }
    root.appendChild(el("p", "hint lessons-hint", "予定は先生が設定します。都合が悪いときは「やりとり」で先生に連絡してください。"));
  }

  function addMessages(incoming) {
    let added = false;
    incoming.forEach(function (m) {
      if (state.messageIds.has(m.id)) return;
      state.messageIds.add(m.id);
      state.messages.push(m);
      added = true;
    });
    if (!added) return false;
    state.messages.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });
    state.lastCreatedAt = state.messages[state.messages.length - 1].createdAt;
    return true;
  }

  async function loadMessages(options) {
    if (state.loadingMessages || !state.token) return;
    state.loadingMessages = true;
    const list = $("message-list");
    try {
      const params = state.lastCreatedAt ? { since: state.lastCreatedAt } : {};
      const data = await api("getMessages", params);
      $("messages-error").hidden = true;
      // 描画前に判定しないと、追加分の高さで「最下部にいない」扱いになる
      const stickToBottom = (options && options.scrollToBottom) || isNearBottom(list);
      const firstLoad = !state.messagesLoaded;
      state.messagesLoaded = true;
      if (addMessages(data.messages) || firstLoad || (options && options.scrollToBottom)) {
        writeCache(MESSAGES_CACHE_KEY, state.messages.slice(-MESSAGES_CACHE_LIMIT));
        renderMessages();
        if (stickToBottom) scrollMessagesToBottom();
      }
    } catch (err) {
      if (err.code === "INVALID_TOKEN") return;
      const errorEl = $("messages-error");
      errorEl.textContent = userMessage(err);
      errorEl.hidden = false;
    } finally {
      state.loadingMessages = false;
    }
  }

  function renderMessages() {
    const list = $("message-list");
    const empty = $("messages-empty");
    list.replaceChildren(empty);
    empty.hidden = state.messages.length + state.pending.length > 0;
    empty.innerHTML = state.messagesLoaded
      ? "まだメッセージはありません。<br>質問や連絡があれば送ってください。"
      : "読み込んでいます…";

    let lastDay = null;
    state.messages.concat(state.pending).forEach(function (m) {
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
        span.textContent = m.body + " · " + timeFormat.format(date);
        band.appendChild(span);
        list.appendChild(band);
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "msg " + (m.sender === "student" ? "msg-student" : "msg-tutor") + (m.pending ? " msg-pending" : "");
      if (m.sender === "tutor") {
        const sender = document.createElement("p");
        sender.className = "msg-sender";
        sender.textContent = "先生";
        wrap.appendChild(sender);
      }
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.body; // textContent なので本文にHTMLが含まれても安全
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = m.pending ? "送信中…" : timeFormat.format(date);
      wrap.append(bubble, time);
      list.appendChild(wrap);
    });
  }

  function autoGrowComposer() {
    const input = $("composer-input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 3, 140) + "px";
    $("composer-send").disabled = input.value.trim() === "";
  }

  /** 返事を待たずに吹き出しを出す。GAS の応答（1〜2秒）を待つと送れていないように見えるため */
  async function onSendMessage(event) {
    event.preventDefault();
    const input = $("composer-input");
    const body = input.value.trim();
    if (!body) return;

    const pending = { id: "pending_" + Date.now() + Math.random(), sender: "student", body: body, createdAt: new Date().toISOString(), system: false, pending: true };
    state.pending.push(pending);
    input.value = "";
    autoGrowComposer();
    $("messages-error").hidden = true;
    renderMessages();
    scrollMessagesToBottom();

    try {
      const data = await api("sendMessage", { body: body });
      state.pending = state.pending.filter(function (p) { return p !== pending; });
      addMessages([{ id: data.id, sender: "student", body: body, createdAt: data.createdAt, system: false }]);
      writeCache(MESSAGES_CACHE_KEY, state.messages.slice(-MESSAGES_CACHE_LIMIT));
      renderMessages();
    } catch (err) {
      state.pending = state.pending.filter(function (p) { return p !== pending; });
      if (err.code === "INVALID_TOKEN") return;
      renderMessages();
      // 書いた文章は消さずに入力欄へ戻す。続けて別の文章を書き始めていたら上書きしない
      if (!input.value.trim()) {
        input.value = body;
        autoGrowComposer();
      }
      $("messages-error").textContent = userMessage(err) + "（メッセージは送られていません）";
      $("messages-error").hidden = false;
    }
  }

  function startPolling() {
    stopPolling();
    // 画面が見えていない間はリクエストを出さない（電池と GAS の実行回数の節約）
    if (document.visibilityState === "hidden") return;
    state.pollTimer = setInterval(function () {
      loadMessages();
      checkStudyDateRollover();
      // 授業が終わったら一覧から外す。予定そのものは変わっていないので取り直さない
      renderLessons();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function onVisibilityChange() {
    if (!state.token) return;
    if (document.visibilityState === "hidden") {
      stopPolling();
      sendPendingProgress();
    } else {
      loadMessages();
      if (state.tab === "submit" && state.submit.status === "idle") loadHistory();
      if (state.tab === "plan") loadPlan();
      loadLessons();
      checkStudyDateRollover();
      startPolling();
    }
  }

  // ---------------------------------------------------------------------------
  // 提出: 履歴

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + "KB";
    return (bytes / 1024 / 1024).toFixed(1) + "MB";
  }

  async function loadHistory() {
    try {
      const data = await api("getSubmissions");
      $("history-error").hidden = true;
      writeCache(HISTORY_CACHE_KEY, data.submissions);
      renderHistory(data.submissions);
    } catch (err) {
      if (err.code === "INVALID_TOKEN") return;
      $("history-error").textContent = userMessage(err);
      $("history-error").hidden = false;
    }
  }

  function renderHistory(items) {
    const list = $("history-list");
    list.replaceChildren();
    $("history-empty").hidden = items.length > 0;
    items.forEach(function (s) {
      const li = document.createElement("li");
      // 先生が Drive 上で削除したものは開けないので、ボタンにしない
      const row = document.createElement(s.available === false ? "div" : "button");
      row.className = "history-item";
      if (s.available !== false) {
        row.type = "button";
        row.addEventListener("click", function () { openViewer(s); });
      }
      const text = document.createElement("span");
      text.className = "history-text";
      const name = document.createElement("span");
      name.className = "history-name";
      name.textContent = s.fileName;
      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = (s.createdAt ? dateTimeFormat.format(new Date(s.createdAt)) : "") + " ・ " + formatBytes(s.sizeBytes);
      text.append(name, meta);
      if (s.note) {
        const note = document.createElement("span");
        note.className = "history-note";
        note.textContent = "💬 " + s.note;
        text.appendChild(note);
      }
      if (s.available === false) {
        const gone = document.createElement("span");
        gone.className = "history-gone";
        gone.textContent = "このファイルは削除されています";
        text.appendChild(gone);
      } else if (s.annotated) {
        const badge = document.createElement("span");
        badge.className = "annotated-badge";
        badge.textContent = "✏️ 先生が書き込みました";
        text.appendChild(badge);
      }
      row.appendChild(text);
      if (s.available !== false) {
        const chevron = document.createElement("span");
        chevron.className = "history-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "›";
        row.appendChild(chevron);
      }
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------------
  // 提出物ビューア（spec §13.7）

  const viewer = { token: 0, file: null };

  function setViewerStatus(text) {
    const el = $("viewer-status");
    el.textContent = text || "";
    el.hidden = !text;
  }

  function openViewer(submission) {
    return showInViewer(submission.fileName, function () {
      return api("getSubmissionFile", { submissionId: submission.id });
    }, null);
  }

  /**
   * ビューアにファイルを出す。提出物と計画の写真で共通。
   * load は { fileName?, mimeType, dataBase64 } を返す。actions があれば下に「撮り直す」「削除」を出す
   */
  async function showInViewer(title, load, actions) {
    const token = ++viewer.token;
    viewer.file = null;
    viewer.actions = actions;
    $("viewer-title").textContent = title;
    $("viewer-pages").replaceChildren();
    $("viewer-share").disabled = true;
    $("viewer-actions").hidden = !actions;
    setViewerStatus("読み込んでいます…");
    $("viewer").hidden = false;
    document.body.classList.add("viewer-open");

    try {
      const data = await load();
      if (!data.fileName) data.fileName = title.replace(/[\/\\:*?"<>|]/g, "") + ".jpg";
      if (token !== viewer.token) return; // 読み込み中に閉じられた
      const bytes = window.PdfView.base64ToBytes(data.dataBase64);
      viewer.file = new File([bytes], data.fileName, { type: data.mimeType });
      $("viewer-share").disabled = false;

      if (data.mimeType === "application/pdf") {
        await window.PdfView.render(bytes, $("viewer-pages"), {
          isCancelled: function () { return token !== viewer.token; },
          onProgress: function (i, total) { setViewerStatus("ページを表示しています… (" + i + "/" + total + ")"); }
        });
        if (token === viewer.token) setViewerStatus("");
      } else {
        const img = document.createElement("img");
        img.className = "viewer-page";
        img.alt = data.fileName;
        img.src = URL.createObjectURL(viewer.file);
        $("viewer-pages").appendChild(img);
        setViewerStatus("");
      }
    } catch (err) {
      if (token !== viewer.token || err.code === "INVALID_TOKEN") return;
      console.warn(err);
      setViewerStatus(err instanceof ApiError ? userMessage(err) : "ファイルを表示できませんでした。「保存・共有」から開いてみてください");
    }
  }

  function closeViewer() {
    viewer.token++;
    viewer.file = null;
    viewer.actions = null;
    $("viewer-actions").hidden = true;
    window.PdfView.clear($("viewer-pages"));
    $("viewer").hidden = true;
    document.body.classList.remove("viewer-open");
  }

  async function shareViewerFile() {
    const file = viewer.file;
    if (!file) return;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
      } catch (_) {
        // 共有シートを閉じただけのときも例外になるので何もしない
      }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  // ---------------------------------------------------------------------------
  // 提出: ファイル選択と画像処理

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function isImageFile(file) {
    return file.type.indexOf("image/") === 0 || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name);
  }

  function nextTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error("toBlob failed"));
      }, type, quality);
    });
  }

  /**
   * 撮影画像を長辺2000px・JPEG品質0.8に縮小する。
   * 元の 3〜5MB のままだと3ページで上限20MBに達するため、この処理は省略できない
   */
  function drawScaled(bitmap, edge) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    // 透過PNGの背景が黒くならないように白で塗る
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function processImage(file) {
    // imageOrientation を指定しないと、縦構えで撮った答案が90度倒れる
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    let canvas = null;
    try {
      let blob = null;
      let edge = 0;
      for (let i = 0; i < JPEG_STEPS.length; i++) {
        const step = JPEG_STEPS[i];
        if (step.edge !== edge) {
          // iOS Safari は canvas の合計メモリに上限があるので、作り直す前に前の canvas を解放する
          if (canvas) canvas.width = canvas.height = 0;
          canvas = drawScaled(bitmap, step.edge);
          edge = step.edge;
        }
        blob = await canvasToBlob(canvas, "image/jpeg", step.quality);
        if (blob.size <= PAGE_TARGET_BYTES) break;
      }
      const width = canvas.width;
      const height = canvas.height;

      const thumbScale = Math.min(1, THUMB_EDGE_PX / Math.max(width, height));
      const thumb = document.createElement("canvas");
      thumb.width = Math.round(width * thumbScale);
      thumb.height = Math.round(height * thumbScale);
      thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const thumbBlob = await canvasToBlob(thumb, "image/jpeg", 0.7);
      thumb.width = thumb.height = 0;

      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        blob: blob,
        width: width,
        height: height,
        thumbUrl: URL.createObjectURL(thumbBlob)
      };
    } finally {
      if (canvas) canvas.width = canvas.height = 0;
      if (bitmap.close) bitmap.close();
    }
  }

  function showError(el, text) {
    el.textContent = text;
    el.hidden = !text;
  }

  async function onFilesSelected(input, context) {
    const files = Array.from(input.files || []);
    // 同じファイルを選び直しても change が発火するように空にしておく
    input.value = "";
    if (files.length === 0) return;

    const adding = context === "add";
    const errorEl = adding ? $("add-page-error") : $("select-error");
    const loadingEl = adding ? $("add-page-loading") : $("select-loading");
    showError(errorEl, "");

    const pdfs = files.filter(isPdfFile);
    const images = files.filter(function (f) { return !isPdfFile(f) && isImageFile(f); });
    if (pdfs.length + images.length !== files.length) return showError(errorEl, TEXT.unsupported);
    if (pdfs.length > 0 && images.length > 0) return showError(errorEl, TEXT.mixed);
    if (adding && pdfs.length > 0) return showError(errorEl, TEXT.mixed);

    if (pdfs.length > 0) {
      if (pdfs.length > 1) return showError(errorEl, TEXT.multiPdf);
      startPdfEditing(pdfs[0]);
      return;
    }

    loadingEl.hidden = false;
    let failed = 0;
    const newPages = [];
    for (let i = 0; i < images.length; i++) {
      loadingEl.textContent = "画像を読み込んでいます… (" + (i + 1) + "/" + images.length + ")";
      await nextTick();
      try {
        newPages.push(await processImage(images[i]));
      } catch (err) {
        // Android Chrome は HEIC をデコードできない
        console.warn(err);
        failed++;
      }
    }
    loadingEl.hidden = true;

    if (newPages.length > 0) {
      state.submit.mode = "images";
      state.submit.pages = state.submit.pages.concat(newPages);
      if (state.submit.status !== "editing") {
        $("title-input").value = "";
        $("note-input").value = "";
        setSubmitStatus("editing");
      }
      renderPages();
    }
    if (failed > 0) {
      const text = failed === images.length ? TEXT.decodeFailed : failed + "枚の画像を読み込めませんでした。その画像はカメラで撮り直してください";
      // editing に移った場合は、そちらの画面にエラーを出す
      showError(state.submit.status === "editing" ? $("add-page-error") : errorEl, text);
    }
  }

  function startPdfEditing(file) {
    state.submit.mode = "pdf";
    state.submit.pdfFile = file;
    $("title-input").value = sanitizeTitle(file.name.replace(/\.pdf$/i, ""));
    $("note-input").value = "";
    setSubmitStatus("editing");
    renderPages();
  }

  function sanitizeTitle(text) {
    return Array.from(String(text).replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, "").trim()).slice(0, 30).join("");
  }

  // ---------------------------------------------------------------------------
  // 提出: 編集画面

  function estimatedSize() {
    if (state.submit.mode === "pdf") return state.submit.pdfFile ? state.submit.pdfFile.size : 0;
    // PDF の構造分として1ページあたり数KBを見込む
    return state.submit.pages.reduce(function (sum, p) { return sum + p.blob.size + 2048; }, 1024);
  }

  function iconSvg(path) {
    return '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function renderPages() {
    const isPdf = state.submit.mode === "pdf";
    const list = $("page-list");
    list.replaceChildren();
    list.hidden = isPdf;
    $("add-page").hidden = isPdf;
    $("pdf-preview").hidden = !isPdf;
    $("editing-title").textContent = isPdf ? "PDFを確認" : "ページを確認";

    if (isPdf) {
      $("pdf-original-name").textContent = state.submit.pdfFile.name;
      $("pdf-size").textContent = formatBytes(state.submit.pdfFile.size);
    } else {
      const pages = state.submit.pages;
      pages.forEach(function (page, index) {
        const li = document.createElement("li");
        li.className = "page-item";

        const img = document.createElement("img");
        img.className = "page-thumb";
        img.src = page.thumbUrl;
        img.alt = (index + 1) + "ページ目のプレビュー";

        const info = document.createElement("div");
        const label = document.createElement("p");
        label.className = "page-label";
        label.textContent = (index + 1) + "ページ目";
        const size = document.createElement("p");
        size.className = "page-size";
        size.textContent = formatBytes(page.blob.size);
        info.append(label, size);

        const controls = document.createElement("div");
        controls.className = "page-controls";
        controls.append(
          pageButton("上へ移動", iconSvg("M12 19V5M6 11l6-6 6 6"), index === 0, function () { movePage(index, -1); }),
          pageButton("下へ移動", iconSvg("M12 5v14M6 13l6 6 6-6"), index === pages.length - 1, function () { movePage(index, 1); })
        );
        // 削除ボタン（ti-x 相当）は誤タップを避けるため並べ替えボタンと離して置く
        const remove = pageButton((index + 1) + "ページ目を削除", iconSvg("M18 6L6 18M6 6l12 12"), false, function () { removePage(index); });
        remove.classList.add("danger", "page-remove");
        info.appendChild(remove);

        li.append(img, info, controls);
        list.appendChild(li);
      });
    }
    updateSizeSummary();
  }

  function pageButton(label, svg, disabled, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-button";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function movePage(index, delta) {
    const pages = state.submit.pages;
    const target = index + delta;
    if (target < 0 || target >= pages.length) return;
    const moved = pages.splice(index, 1)[0];
    pages.splice(target, 0, moved);
    renderPages();
  }

  function removePage(index) {
    const removed = state.submit.pages.splice(index, 1)[0];
    URL.revokeObjectURL(removed.thumbUrl);
    if (state.submit.pages.length === 0) {
      resetSubmit();
      return;
    }
    renderPages();
  }

  function updateSizeSummary() {
    const size = estimatedSize();
    const tooLarge = size > MAX_UPLOAD_BYTES;
    const prefix = state.submit.mode === "images" ? state.submit.pages.length + "ページ / " : "";
    const summary = $("size-summary");
    summary.textContent = prefix + "約" + formatBytes(size) + (tooLarge ? "（上限20MBを超えています）" : "");
    summary.style.color = tooLarge ? "var(--danger)" : "";
    $("submit-button").disabled = tooLarge;
    if (tooLarge) {
      showUploadError(TEXT.tooLarge, false);
    } else if ($("retry-button").hidden) {
      hideUploadError();
    }
  }

  function showUploadError(text, retryable) {
    $("upload-error-text").textContent = text;
    $("retry-button").hidden = !retryable;
    $("upload-error").hidden = false;
  }

  function hideUploadError() {
    $("upload-error").hidden = true;
  }

  function onCancelEditing() {
    const hasWork = state.submit.pages.length > 0 || state.submit.pdfFile;
    if (hasWork && !window.confirm("選んだページを破棄して、最初の画面に戻りますか？")) return;
    resetSubmit();
  }

  function resetSubmit() {
    state.submit.pages.forEach(function (p) { URL.revokeObjectURL(p.thumbUrl); });
    state.submit.pages = [];
    state.submit.pdfFile = null;
    state.submit.mode = null;
    $("title-input").value = "";
    $("note-input").value = "";
    $("note-count").textContent = "0";
    hideUploadError();
    showError($("add-page-error"), "");
    setSubmitStatus("idle");
  }

  function setSubmitStatus(status) {
    const s = state.submit;
    s.status = status;
    if (s.doneTimer) {
      clearTimeout(s.doneTimer);
      s.doneTimer = null;
    }
    $("submit-idle").hidden = status !== "idle";
    $("submit-editing").hidden = status !== "editing" && status !== "uploading";
    $("submit-done").hidden = status !== "done";
    $("upload-overlay").hidden = status !== "uploading";
    $("tab-submit").scrollTop = 0;
  }

  // ---------------------------------------------------------------------------
  // 提出: アップロード

  function setProgress(text) {
    $("upload-progress").textContent = text;
  }

  /**
   * 大きな ArrayBuffer を一度に String.fromCharCode(...) に渡すと
   * 引数が多すぎてスタックオーバーフローするので、8KBずつ文字列化する
   */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x2000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }

  async function buildPdf(pages) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      // CDN から jsPDF を読めていない＝通信の問題
      throw new ApiError("NETWORK", TEXT.network);
    }
    const A4 = { short: 210, long: 297 };
    const MARGIN = 10;
    let doc = null;

    for (let i = 0; i < pages.length; i++) {
      setProgress("画像を処理しています… (" + (i + 1) + "/" + pages.length + ")");
      await nextTick();

      const page = pages[i];
      const landscape = page.width > page.height;
      const orientation = landscape ? "landscape" : "portrait";
      if (!doc) {
        doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: orientation });
      } else {
        doc.addPage("a4", orientation);
      }

      const pageW = landscape ? A4.long : A4.short;
      const pageH = landscape ? A4.short : A4.long;
      const areaW = pageW - MARGIN * 2;
      const areaH = pageH - MARGIN * 2;
      const scale = Math.min(areaW / page.width, areaH / page.height);
      const w = page.width * scale;
      const h = page.height * scale;
      const bytes = new Uint8Array(await page.blob.arrayBuffer());
      doc.addImage(bytes, "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h, "page" + i, "NONE");
    }

    setProgress("PDFを作成しています…");
    await nextTick();
    const dataUri = doc.output("datauristring");
    return dataUri.slice(dataUri.indexOf(",") + 1);
  }

  async function onSubmit() {
    const s = state.submit;
    if (s.status === "uploading") return;
    hideUploadError();

    const title = sanitizeTitle($("title-input").value) || "答案";
    const note = $("note-input").value.trim();
    const fileName = title + ".pdf";
    const pageCount = s.mode === "images" ? s.pages.length : undefined;

    setSubmitStatus("uploading");
    setProgress("準備しています…");
    blockNavigation(true);

    try {
      let dataBase64;
      if (s.mode === "images") {
        try {
          dataBase64 = await buildPdf(s.pages.slice());
        } catch (err) {
          if (err instanceof ApiError) throw err;
          console.error(err);
          throw new Error(TEXT.pdfFailed);
        }
      } else {
        setProgress("ファイルを読み込んでいます…");
        await nextTick();
        dataBase64 = arrayBufferToBase64(await s.pdfFile.arrayBuffer());
      }

      if (Math.floor(dataBase64.length * 3 / 4) > MAX_UPLOAD_BYTES) {
        throw new ApiError("FILE_TOO_LARGE", TEXT.tooLarge);
      }

      setProgress("送信しています…");
      const data = await api("upload", {
        fileName: fileName,
        mimeType: "application/pdf",
        dataBase64: dataBase64,
        note: note,
        pageCount: pageCount
      });

      showDone(data.fileName);
    } catch (err) {
      if (err.code === "INVALID_TOKEN") return; // ログイン画面に戻っている
      // 撮り直しは生徒の負担が大きいので、失敗してもページは絶対に捨てない
      setSubmitStatus("editing");
      renderPages();
      const text = err instanceof ApiError ? userMessage(err) : (err.message === TEXT.pdfFailed ? TEXT.pdfFailed : TEXT.unknown);
      showUploadError(text, true);
    } finally {
      blockNavigation(false);
    }
  }

  function showDone(fileName) {
    // 送信済みのページはここで初めて破棄する
    state.submit.pages.forEach(function (p) { URL.revokeObjectURL(p.thumbUrl); });
    state.submit.pages = [];
    state.submit.pdfFile = null;
    state.submit.mode = null;
    $("title-input").value = "";
    $("note-input").value = "";
    $("note-count").textContent = "0";

    $("done-file-name").textContent = fileName;
    const done = $("submit-done");
    done.classList.remove("animate");
    setSubmitStatus("done");
    void done.offsetWidth; // アニメーションを毎回再生させるためにリフローを挟む
    done.classList.add("animate");

    loadHistory();
    loadMessages();
    state.submit.doneTimer = setTimeout(function () {
      if (state.submit.status === "done") setSubmitStatus("idle");
    }, DONE_AUTO_RETURN_MS);
  }

  // アップロード中にブラウザの「戻る」や再読み込みで処理を失わないようにする
  function onBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = "";
  }

  function onPopState() {
    if (state.submit.status === "uploading") {
      history.pushState({ uploading: true }, "");
    }
  }

  function blockNavigation(block) {
    if (block) {
      window.addEventListener("beforeunload", onBeforeUnload);
      history.pushState({ uploading: true }, "");
    } else {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (history.state && history.state.uploading) history.back();
    }
  }

  // ---------------------------------------------------------------------------
  // 初期化

  function bind() {
    $("login-form").addEventListener("submit", onLoginSubmit);
    $("logout-button").addEventListener("click", function () {
      if (state.submit.status === "editing" && !window.confirm("選んだページは破棄されます。ログアウトしますか？")) return;
      if (window.confirm("ログアウトしますか？\nもう一度使うには合言葉が必要です。")) logout();
    });

    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
    });

    $("next-lesson-bar").addEventListener("click", function () { switchTab("lessons"); });
    $("composer").addEventListener("submit", onSendMessage);
    $("composer-input").addEventListener("input", autoGrowComposer);

    $("camera-input").addEventListener("change", function () { onFilesSelected(this, "select"); });
    $("file-input").addEventListener("change", function () { onFilesSelected(this, "select"); });
    $("add-page-input").addEventListener("change", function () { onFilesSelected(this, "add"); });

    $("editing-cancel").addEventListener("click", onCancelEditing);
    $("note-input").addEventListener("input", function () {
      $("note-count").textContent = String(this.value.length);
    });
    $("submit-button").addEventListener("click", onSubmit);
    $("retry-button").addEventListener("click", onSubmit);

    $("done-again").addEventListener("click", function () { setSubmitStatus("idle"); });
    $("done-messages").addEventListener("click", function () {
      setSubmitStatus("idle");
      switchTab("messages");
    });

    $("viewer-close").addEventListener("click", closeViewer);
    $("viewer-retake").addEventListener("click", function () {
      const actions = viewer.actions;
      closeViewer();
      if (actions) actions.retake();
    });
    $("viewer-delete").addEventListener("click", async function () {
      const actions = viewer.actions;
      if (!actions) return;
      try {
        if (await actions.remove()) closeViewer();
      } catch (err) {
        if (err.code !== "INVALID_TOKEN") setViewerStatus(userMessage(err));
      }
    });
    $("viewer-share").addEventListener("click", shareViewerFile);

    document.addEventListener("visibilitychange", onVisibilityChange);
    // iOS はアプリを上にスワイプして閉じたとき visibilitychange が来ないことがあるので、pagehide でも送る
    window.addEventListener("pagehide", sendPendingProgress);
    window.addEventListener("popstate", onPopState);
  }

  bind();
  boot();
})();
