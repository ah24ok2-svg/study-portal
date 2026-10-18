(function () {
  "use strict";

  const GAS_URL = window.APP_CONFIG && window.APP_CONFIG.GAS_URL;
  const TOKEN_KEY = "tutorapp.parentToken";
  const NAME_KEY = "tutorapp.parentName";
  // GAS は1回の応答に1〜2秒かかるので、前回の表示を保存しておき、開いた瞬間に出す
  const CACHE_KEY = "tutorapp.cache.parent";

  const TEXT = {
    network: "通信に失敗しました。電波の良い場所でもう一度お試しください",
    unknown: "うまくいきませんでした。少し待ってからもう一度お試しください",
    sessionExpired: "合言葉を確認できませんでした。もう一度入力してください"
  };

  const $ = function (id) { return document.getElementById(id); };

  const state = { token: null, tab: "billing", data: null, loading: false, planView: null };

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* 保存できなくても今回のセッションは使える */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  }

  /** 別の家庭の表示が一瞬でも出ないよう、保存時の合言葉と一致するときだけ使う */
  function readCache() {
    try {
      const cached = JSON.parse(storageGet(CACHE_KEY) || "null");
      return cached && cached.owner === state.token ? cached.items : null;
    } catch (_) {
      return null;
    }
  }

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(action, params) {
    const payload = Object.assign({ action: action, parentToken: state.token }, params || {});
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
      if (code === "INVALID_TOKEN" && action !== "parentLogin") logout(TEXT.sessionExpired);
      throw new ApiError(code, code === "INTERNAL_ERROR" ? TEXT.unknown : message);
    }
    return body.data;
  }

  function showError(el, text) {
    el.textContent = text || "";
    el.hidden = !text;
  }

  // ---------------------------------------------------------------------------
  // ログイン

  function showLogin(message) {
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-error").textContent = message || "";
    $("token-input").value = "";
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    const token = $("token-input").value.trim().toLowerCase();
    if (!token) return void ($("login-error").textContent = "合言葉を入力してください");
    const button = $("login-button");
    button.disabled = true;
    button.textContent = "確認しています…";
    state.token = token;
    try {
      const data = await api("parentLogin");
      storageSet(TOKEN_KEY, token);
      storageSet(NAME_KEY, data.name);
      enterApp(data.name);
    } catch (err) {
      state.token = null;
      $("login-error").textContent = err.code === "INVALID_TOKEN" ? "合言葉が正しくありません" : err.message;
    } finally {
      button.disabled = false;
      button.textContent = "はじめる";
    }
  }

  function logout(message) {
    storageRemove(TOKEN_KEY);
    storageRemove(NAME_KEY);
    storageRemove(CACHE_KEY);
    state.token = null;
    state.data = null;
    state.planView = null;
    $("plan-root").replaceChildren();
    $("billing-root").replaceChildren();
    closeReceipt();
    showLogin(message);
  }

  function enterApp(name) {
    $("student-name").textContent = name || "";
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    switchTab("billing");
    state.data = readCache();
    render();
    load();
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    });
    $("tab-billing").hidden = tab !== "billing";
    $("tab-plan").hidden = tab !== "plan";
  }

  async function load() {
    if (state.loading || !state.token) return;
    state.loading = true;
    try {
      const data = await api("parentGetSummary");
      state.data = data;
      storageSet(CACHE_KEY, JSON.stringify({ owner: state.token, items: data }));
      storageSet(NAME_KEY, data.student.name);
      $("student-name").textContent = data.student.name;
      showError($("billing-error"), "");
      render();
    } catch (err) {
      if (err.code !== "INVALID_TOKEN") showError($("billing-error"), err.message);
    } finally {
      state.loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 表示

  function getPlanView() {
    if (!state.planView) {
      state.planView = new window.PlanView($("plan-root"), {
        editable: false,
        order: ["goals", "calendar", "day"],
        emptyText: "先生が目標を立てると、ここに計画と進み具合が表示されます"
      });
      state.planView.render();
    }
    return state.planView;
  }

  function render() {
    const root = $("billing-root");
    root.replaceChildren();
    const data = state.data;
    if (!data) {
      root.appendChild(el("p", "empty", "読み込んでいます…"));
      getPlanView().render();
      return;
    }
    getPlanView().setData(data.plan);

    const B = window.Billing;
    const paymentsByMonth = {};
    data.payments.forEach(function (p) { paymentsByMonth[p.month] = p; });
    B.monthsToShow(data.payments).forEach(function (month) {
      const billing = B.monthBilling(data.lessons, data.student.gradeBase, month);
      // 授業も入金も無い過去の月は出さない
      if (billing.items.length === 0 && !paymentsByMonth[month] && month !== B.monthOf(data.today)) return;
      root.appendChild(window.BillingView.renderMonthCard(billing, paymentsByMonth[month] || null, {
        role: "parent",
        paypayLink: data.paypayLink,
        onReceipt: openReceipt
      }));
    });
    root.appendChild(el("p", "hint billing-hint", "金額は授業の実施回数から自動で計算しています。お支払いは PayPay でお願いします（期限は翌月末）。ご不明な点は先生にご連絡ください。"));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function openReceipt(payment) {
    const body = $("receipt-body");
    body.replaceChildren(window.BillingView.renderReceipt(payment, state.data.student.name, state.data.tutorName));
    $("receipt-view").hidden = false;
    document.body.classList.add("receipt-open");
  }

  function closeReceipt() {
    $("receipt-view").hidden = true;
    document.body.classList.remove("receipt-open");
  }

  // ---------------------------------------------------------------------------
  // 初期化

  function bind() {
    $("login-form").addEventListener("submit", onLoginSubmit);
    $("logout-button").addEventListener("click", function () {
      if (window.confirm("ログアウトしますか？\nもう一度使うには合言葉が必要です。")) logout();
    });
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
    });
    $("receipt-close").addEventListener("click", closeReceipt);
    $("receipt-print").addEventListener("click", function () { window.print(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.token) load();
    });
  }

  function boot() {
    bind();
    const token = storageGet(TOKEN_KEY);
    if (!token) return showLogin();
    state.token = token;
    // 電波が悪いだけでログイン画面に戻さないよう、前回の名前で先に画面を出す
    enterApp(storageGet(NAME_KEY));
  }

  boot();
})();
