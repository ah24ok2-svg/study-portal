/**
 * 学習計画の画面（目標カード・月のカレンダー・その日のやること）。生徒アプリと講師アプリで共有する（spec §14.6）。
 * 割り当ての計算は plan.js。ここは表示とチェック操作だけを担う
 */
(function () {
  "use strict";

  const P = window.StudyPlan;
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function md(key) {
    const p = key.split("-");
    return Number(p[1]) + "/" + Number(p[2]) + "(" + WEEKDAYS[P.weekday(key)] + ")";
  }

  function fullDate(key) {
    const p = key.split("-");
    return Number(p[1]) + "月" + Number(p[2]) + "日(" + WEEKDAYS[P.weekday(key)] + ")";
  }

  function range(entry) {
    return entry.from === entry.to ? "p." + entry.from : "p." + entry.from + "〜" + entry.to;
  }

  /**
   * options:
   *   editable       チェックを付けられるか（生徒アプリ: true、講師アプリ: false）
   *   onSetProgress  (goalId, studyDate, throughPage|null) => Promise。失敗したら reject
   *   onError        (message) => void
   *   goalActions    (goal, container) => void。講師アプリの編集ボタンなどを足す
   *   emptyText      目標が1つも無いときの文言
   *   order          並び順。生徒は毎日チェックするので "day" を先頭に、講師は全体を見るので "goals" を先頭にする
   */
  function PlanView(root, options) {
    this.root = root;
    this.options = options || {};
    this.data = null;
    this.plans = [];
    this.month = null;
    this.selected = null;
    this.openPartial = null; // 「途中まで」の入力欄を開いている goalId
  }

  PlanView.prototype.setData = function (data) {
    const first = !this.data;
    const dayChanged = this.data && this.data.today !== data.today;
    this.data = { goals: data.goals.slice(), progress: data.progress.slice(), today: data.today };
    if (first || dayChanged) {
      this.selected = data.today;
      this.month = data.today.slice(0, 7);
    }
    this.recompute();
    this.render();
  };

  PlanView.prototype.recompute = function () {
    this.plans = this.data ? P.computePlan(this.data.goals, this.data.progress, this.data.today) : [];
  };

  /** 送信を待たずに表示へ反映する。失敗したら元に戻す */
  PlanView.prototype.setProgress = function (goalId, date, through) {
    const self = this;
    const before = this.data.progress.slice();
    this.data.progress = this.data.progress.filter(function (r) { return !(r.goalId === goalId && r.studyDate === date); });
    if (through !== null) this.data.progress.push({ goalId: goalId, studyDate: date, throughPage: through });
    this.openPartial = null;
    this.recompute();
    this.render();
    Promise.resolve(this.options.onSetProgress(goalId, date, through)).catch(function (err) {
      self.data.progress = before;
      self.recompute();
      self.render();
      if (self.options.onError) self.options.onError(err && err.message ? err.message : "記録できませんでした");
    });
  };

  PlanView.prototype.render = function () {
    const root = this.root;
    root.replaceChildren();
    if (!this.data) {
      root.appendChild(el("p", "empty", "読み込んでいます…"));
      return;
    }
    if (this.plans.length === 0) {
      root.appendChild(el("p", "empty", this.options.emptyText || "まだ目標がありません"));
      return;
    }
    const self = this;
    const parts = { goals: this.renderGoals, calendar: this.renderCalendar, day: this.renderDay };
    (this.options.order || ["goals", "calendar", "day"]).forEach(function (name) {
      root.appendChild(parts[name].call(self));
    });
  };

  // ---------------------------------------------------------------------------
  // 目標カード

  PlanView.prototype.renderGoals = function () {
    const self = this;
    const wrap = el("div", "plan-goals");
    this.plans.forEach(function (p) {
      const g = p.goal;
      const card = el("section", "goal-card");

      const head = el("div", "goal-head");
      head.appendChild(el("h3", "goal-title", g.title));
      let chip;
      if (p.finished) chip = el("span", "goal-chip chip-done", "完了");
      else if (p.overdue) chip = el("span", "goal-chip chip-late", "期限超過");
      else if (p.behind) chip = el("span", "goal-chip chip-warn", "遅れ気味");
      else chip = el("span", "goal-chip chip-ok", "順調");
      head.appendChild(chip);
      if (self.options.goalActions) {
        const actions = el("div", "goal-actions");
        self.options.goalActions(g, actions);
        head.appendChild(actions);
      }
      card.appendChild(head);

      card.appendChild(el("p", "goal-meta", "p." + g.startPage + "〜" + g.endPage + " ／ 期限 " + md(g.dueDate)));

      const pct = Math.round((p.donePages / p.total) * 100);
      const bar = el("div", "goal-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(p.total));
      bar.setAttribute("aria-valuenow", String(p.donePages));
      const fill = el("span", "goal-bar-fill");
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el("p", "goal-progress", p.donePages + " / " + p.total + "ページ（" + pct + "%）"));

      const stats = el("dl", "goal-stats");
      function stat(label, value, sub) {
        const box = el("div", "goal-stat");
        const dd = el("dd", "", value);
        if (sub) dd.appendChild(el("small", "", sub));
        box.append(el("dt", "", label), dd);
        stats.appendChild(box);
      }
      if (p.finished) {
        stat("今日", "おわり 🎉");
      } else if (p.today) {
        stat("今日", range(p.today), p.today.pages + "ページ");
      } else if (self.data.today < g.startDate) {
        stat("今日", md(g.startDate) + " から開始");
      } else {
        stat("今日", "休み");
      }
      stat("これから7日間", p.finished ? "—" : p.next7 + "ページ");
      card.appendChild(stats);

      if (p.paceUp && !p.overdue && !p.finished) {
        card.appendChild(el("p", "goal-note", "最初の予定（1日" + p.originalPace + "ページ）より多くなっています。期限の見直しも検討してください"));
      }
      wrap.appendChild(card);
    });
    return wrap;
  };

  // ---------------------------------------------------------------------------
  // 月のカレンダー

  PlanView.prototype.dayMark = function (date) {
    const entries = P.entriesOn(this.plans, date);
    if (entries.length === 0) {
      const rest = this.plans.some(function (p) {
        return date >= p.goal.startDate && date <= p.goal.dueDate && P.isRestDay(p.goal, date);
      });
      return { kind: rest ? "rest" : "none", pages: 0 };
    }
    const pages = entries.reduce(function (s, x) { return s + x.entry.pages; }, 0);
    const allDone = entries.every(function (x) { return x.entry.status === "done"; });
    if (allDone) return { kind: "done", pages: pages };
    if (date < this.data.today) return { kind: "missed", pages: pages };
    return { kind: "todo", pages: pages };
  };

  PlanView.prototype.renderCalendar = function () {
    const self = this;
    const wrap = el("section", "plan-calendar");
    const ym = this.month.split("-").map(Number);

    const head = el("div", "cal-head");
    const prev = el("button", "icon-button cal-nav", "‹");
    prev.type = "button";
    prev.setAttribute("aria-label", "前の月");
    prev.addEventListener("click", function () { self.shiftMonth(-1); });
    const next = el("button", "icon-button cal-nav", "›");
    next.type = "button";
    next.setAttribute("aria-label", "次の月");
    next.addEventListener("click", function () { self.shiftMonth(1); });
    head.append(prev, el("h3", "cal-title", ym[0] + "年" + ym[1] + "月"), next);
    wrap.appendChild(head);

    const grid = el("div", "cal-grid");
    grid.setAttribute("role", "grid");
    WEEKDAYS.forEach(function (w, i) {
      grid.appendChild(el("span", "cal-wd" + (i === 0 ? " sun" : i === 6 ? " sat" : ""), w));
    });

    const first = this.month + "-01";
    const offset = P.weekday(first);
    for (let i = 0; i < offset; i++) grid.appendChild(el("span", "cal-blank"));
    for (let d = first; d.slice(0, 7) === this.month; d = P.addDays(d, 1)) {
      const mark = this.dayMark(d);
      const cell = el("button", "cal-day mark-" + mark.kind);
      cell.type = "button";
      if (d === this.data.today) cell.classList.add("is-today");
      if (d === this.selected) cell.classList.add("is-selected");
      cell.setAttribute("aria-pressed", String(d === this.selected));
      const labels = { done: "完了", missed: "できなかった", todo: mark.pages + "ページ", rest: "休み", none: "" };
      cell.setAttribute("aria-label", fullDate(d) + (labels[mark.kind] ? " " + labels[mark.kind] : ""));
      cell.appendChild(el("span", "cal-num", String(Number(d.slice(8)))));
      const sub = el("span", "cal-sub");
      if (mark.kind === "done") sub.textContent = "✓";
      else if (mark.kind === "todo" || mark.kind === "missed") sub.textContent = mark.pages + "p";
      cell.appendChild(sub);
      cell.addEventListener("click", (function (date) {
        return function () { self.select(date); };
      })(d));
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);

    const legend = el("p", "cal-legend");
    legend.innerHTML = '<span class="lg lg-todo"></span>予定 <span class="lg lg-done"></span>完了 <span class="lg lg-missed"></span>できなかった <span class="lg lg-rest"></span>休み';
    wrap.appendChild(legend);
    return wrap;
  };

  PlanView.prototype.shiftMonth = function (delta) {
    const ym = this.month.split("-").map(Number);
    const total = ym[0] * 12 + (ym[1] - 1) + delta;
    this.month = Math.floor(total / 12) + "-" + String((total % 12) + 1).padStart(2, "0");
    this.render();
  };

  PlanView.prototype.select = function (date) {
    this.selected = date;
    this.openPartial = null;
    this.render();
    const day = this.root.querySelector(".plan-day");
    if (day && day.scrollIntoView) day.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (this.options.onSelect) this.options.onSelect(date);
  };

  // ---------------------------------------------------------------------------
  // その日のやること

  PlanView.prototype.renderDay = function () {
    const self = this;
    const date = this.selected;
    const wrap = el("section", "plan-day");
    const title = date === this.data.today ? "今日（" + md(date) + "）のやること" : fullDate(date) + " のやること";
    wrap.appendChild(el("h3", "plan-day-title", title));

    const entries = P.entriesOn(this.plans, date);
    if (entries.length === 0) {
      const mark = this.dayMark(date);
      wrap.appendChild(el("p", "empty plan-day-empty", mark.kind === "rest" ? "休みの日です" : "この日のやることはありません"));
      return wrap;
    }

    const list = el("ul", "todo-list");
    entries.forEach(function (x) {
      const g = x.plan.goal;
      const e = x.entry;
      const canEdit = self.options.editable && e.editable;
      const li = el("li", "todo todo-" + e.status);

      const check = el("button", "todo-check");
      check.type = "button";
      check.setAttribute("role", "checkbox");
      check.setAttribute("aria-checked", e.status === "done" ? "true" : e.status === "partial" ? "mixed" : "false");
      check.setAttribute("aria-label", g.title + " " + range(e) + (e.status === "done" ? "（完了）" : ""));
      check.disabled = !canEdit;
      check.innerHTML = e.status === "done"
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : e.status === "partial" ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>' : "";
      if (canEdit) {
        check.addEventListener("click", function () {
          self.setProgress(g.goalId, date, e.status === "done" ? null : e.to);
        });
      }

      const body = el("div", "todo-body");
      body.appendChild(el("p", "todo-title", g.title));
      body.appendChild(el("p", "todo-range", range(e) + "（" + e.pages + "ページ）"));
      let note = "";
      if (e.overdue) note = "期限を過ぎています。残りをまとめて表示しています";
      else if (e.status === "partial") note = "p." + e.record + " までできた" + (date < self.data.today ? "（残りは次の日以降に回しました）" : "");
      else if (e.status === "missed") note = "できなかった分は、次の日以降に回しました";
      else if (e.status === "done" && e.record > e.to) note = "p." + e.record + " まで先に進めました";
      if (note) body.appendChild(el("p", "todo-note", note));

      li.append(check, body);

      if (canEdit && e.status !== "done") {
        const partialBtn = el("button", "link-button todo-partial-btn", "途中まで");
        partialBtn.type = "button";
        partialBtn.addEventListener("click", function () {
          self.openPartial = self.openPartial === g.goalId ? null : g.goalId;
          self.render();
          const input = self.root.querySelector(".todo-partial-form input");
          if (input) input.focus();
        });
        li.appendChild(partialBtn);
      }

      if (canEdit && self.openPartial === g.goalId) {
        const form = el("form", "todo-partial-form");
        const label = el("label", "", "p.");
        const input = document.createElement("input");
        input.type = "number";
        input.inputMode = "numeric";
        input.className = "input";
        input.min = String(e.from);
        input.max = String(g.endPage);
        input.value = e.record && e.record >= e.from ? String(e.record) : "";
        input.setAttribute("aria-label", "何ページ目までできたか");
        label.appendChild(input);
        const tail = el("span", "", " までできた");
        const save = el("button", "btn btn-primary", "記録");
        save.type = "submit";
        const err = el("p", "field-error", "");
        form.append(label, tail, save, err);
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          const n = Number(input.value);
          if (!Number.isInteger(n) || n < e.from || n > g.endPage) {
            err.textContent = "p." + e.from + "〜" + g.endPage + " の数字を入れてください";
            return;
          }
          self.setProgress(g.goalId, date, n);
        });
        li.appendChild(form);
      }
      list.appendChild(li);
    });
    wrap.appendChild(list);

    if (!this.options.editable) return wrap;
    if (date < this.data.today) wrap.appendChild(el("p", "hint plan-day-hint", "過ぎた日の記録は変更できません"));
    else if (date > this.data.today) wrap.appendChild(el("p", "hint plan-day-hint", "先にやった分は、その日の分としてチェックできます"));
    return wrap;
  };

  window.PlanView = PlanView;
})();
