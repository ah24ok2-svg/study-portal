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
   *   onTakePhoto    (goal, entry, spread) => void。写真を撮る（生徒アプリのみ。spec §14.7）
   *   onOpenPhoto    (photo, canEdit) => void。撮った写真を見る
   *   order          並び順。生徒は毎日チェックするので "day" を先頭に、講師は全体を見るので "goals" を先頭にする
   */
  function PlanView(root, options) {
    this.root = root;
    this.options = options || {};
    this.data = null;
    this.plans = [];
    this.month = null;
    this.selected = null;
  }

  PlanView.prototype.setData = function (data) {
    const first = !this.data;
    const dayChanged = this.data && this.data.today !== data.today;
    this.data = { goals: data.goals.slice(), progress: data.progress.slice(), photos: (data.photos || []).slice(), today: data.today };
    this.uploading = this.uploading || {};
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

  /**
   * 送信を待たずに表示へ反映する。
   * 1ページずつ素早く押されると、通信の届く順番が入れ替わってサーバーの記録が古い値で上書きされうるので、
   * 送信は1件ずつ順番に行う
   */
  PlanView.prototype.setProgress = function (goalId, date, through) {
    const self = this;
    const before = this.data.progress.slice();
    this.data.progress = this.data.progress.filter(function (r) { return !(r.goalId === goalId && r.studyDate === date); });
    if (through !== null) this.data.progress.push({ goalId: goalId, studyDate: date, throughPage: through });
    this.recompute();
    this.render();

    const seq = (this.seq = (this.seq || 0) + 1);
    this.queue = (this.queue || Promise.resolve()).then(function () {
      return self.options.onSetProgress(goalId, date, through);
    }).catch(function (err) {
      // 後から押した分がまだ控えているなら、それが最新の状態を送るので戻さない
      if (seq === self.seq) {
        self.data.progress = before;
        self.recompute();
        self.render();
      }
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
        // 期限はテストの日なので動かせない。見直しは促さず、遅れを取り戻すために量が増えていることだけを伝える
        card.appendChild(el("p", "goal-note", "遅れを取り戻すため、1日の量が最初の予定（" + p.originalPace + "ページ）より増えています"));
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
    this.render();
    const day = this.root.querySelector(".plan-day");
    if (day && day.scrollIntoView) day.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (this.options.onSelect) this.options.onSelect(date);
  };

  // ---------------------------------------------------------------------------
  // その日のやること

  function photoKey(goalId, date, from) {
    return goalId + "|" + date + "|" + from;
  }

  PlanView.prototype.photoFor = function (goalId, date, from) {
    return this.data.photos.find(function (p) { return p.goalId === goalId && p.studyDate === date && p.fromPage === from; }) || null;
  };

  /** 写真を送っている間は📷を「送信中」にする */
  PlanView.prototype.setUploading = function (goalId, date, from, on) {
    if (on) this.uploading[photoKey(goalId, date, from)] = true;
    else delete this.uploading[photoKey(goalId, date, from)];
    this.render();
  };

  PlanView.prototype.addPhoto = function (photo) {
    this.data.photos = this.data.photos.filter(function (p) {
      return !(p.goalId === photo.goalId && p.studyDate === photo.studyDate && p.fromPage === photo.fromPage);
    });
    this.data.photos.push(photo);
    this.render();
  };

  PlanView.prototype.removePhoto = function (photoId) {
    this.data.photos = this.data.photos.filter(function (p) { return p.photoId !== photoId; });
    this.render();
  };

  /** 後の日にチェックがあるか。あるうちは前の日のチェックを外させない（spec §14.3） */
  PlanView.prototype.laterChecked = function (goalId, date) {
    return this.data.progress.some(function (r) { return r.goalId === goalId && r.studyDate > date; });
  };

  /** ページのボックスを押したとき。未チェックならそこまで付け、チェック済みならそこから先を外す */
  PlanView.prototype.togglePage = function (goal, entry, page) {
    const current = entry.record === null ? entry.from - 1 : entry.record;
    if (page > current) {
      this.setProgress(goal.goalId, entry.date, page);
      return;
    }
    if (this.laterChecked(goal.goalId, entry.date)) {
      const later = this.data.progress
        .filter(function (r) { return r.goalId === goal.goalId && r.studyDate > entry.date; })
        .map(function (r) { return r.studyDate; })
        .sort()
        .pop();
      if (this.options.onError) this.options.onError("後の日（" + md(later) + "）のチェックがあるため外せません。先にその日の分を外してください");
      return;
    }
    const last = Math.min(current, entry.to);
    const label = page === last ? "p." + page : "p." + page + "〜" + last;
    if (!window.confirm(label + " のチェックを外しますか？")) return;
    const next = page - 1;
    this.setProgress(goal.goalId, entry.date, next < entry.from ? null : next);
  };

  /** 見開きごとの📷。撮っていなければ「撮る」、撮っていれば「写真」、送信中は「送信中」 */
  PlanView.prototype.renderPhotoButton = function (goal, entry, spread, canEdit) {
    const self = this;
    const photo = this.photoFor(goal.goalId, entry.date, spread.from);
    const busy = !!this.uploading[photoKey(goal.goalId, entry.date, spread.from)];
    const pagesLabel = spread.from === spread.to ? "p." + spread.from : "p." + spread.from + "〜" + spread.to;
    if (!photo && !busy && !(canEdit && this.options.onTakePhoto)) return null;

    const btn = el("button", "photo-btn" + (photo ? " has-photo" : "") + (busy ? " is-busy" : ""));
    btn.type = "button";
    const icon = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
    if (busy) {
      btn.disabled = true;
      btn.innerHTML = '<span class="mini-spinner" aria-hidden="true"></span>';
      btn.appendChild(el("span", "photo-label", "送信中"));
      btn.setAttribute("aria-label", pagesLabel + " の写真を送信中");
    } else if (photo) {
      btn.innerHTML = icon;
      btn.appendChild(el("span", "photo-label", "写真✓"));
      btn.setAttribute("aria-label", pagesLabel + " の写真を見る");
      btn.addEventListener("click", function () {
        if (self.options.onOpenPhoto) self.options.onOpenPhoto(photo, canEdit, { goal: goal, entry: entry, spread: spread });
      });
    } else {
      btn.innerHTML = icon;
      btn.appendChild(el("span", "photo-label", "撮る"));
      btn.setAttribute("aria-label", pagesLabel + " の写真を撮る");
      btn.addEventListener("click", function () { self.options.onTakePhoto(goal, entry, spread); });
    }
    return btn;
  };

  PlanView.prototype.renderDay = function () {
    const self = this;
    const date = this.selected;
    const wrap = el("section", "plan-day");
    // 「今日（10/8(木)）」とカッコが重なると読みにくいので、日付は見出しの横に小さく添える
    const heading = el("h3", "plan-day-title", date === this.data.today ? "今日のやること" : fullDate(date) + " のやること");
    if (date === this.data.today) heading.appendChild(el("span", "plan-day-date", fullDate(date)));
    wrap.appendChild(heading);

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

      const head = el("div", "todo-head");
      const titles = el("div", "todo-body");
      titles.appendChild(el("p", "todo-title", g.title));
      titles.appendChild(el("p", "todo-range", range(e) + "（" + e.pages + "ページ）"));
      head.appendChild(titles);
      const doneCount = e.record === null ? 0 : Math.max(0, Math.min(e.record, e.to) - e.from + 1);
      const count = el("span", "todo-count", e.status === "done" ? "✓ 完了" : doneCount + " / " + e.pages);
      head.appendChild(count);
      li.appendChild(head);

      // 1ページごとのボックスを見開きごとに並べ、見開きごとに写真を撮れるようにする（spec §14.3, §14.7）
      const pages = el("div", "page-checks");
      pages.setAttribute("role", "group");
      pages.setAttribute("aria-label", g.title + " のページ");
      P.spreadsOf(e, g.spreadStart).forEach(function (spread) {
        const row = el("div", "spread-row");
        for (let n = spread.from; n <= spread.to; n++) {
          const checked = e.record !== null && n <= e.record;
          const box = el("button", "page-check" + (checked ? " is-checked" : ""));
          box.type = "button";
          box.setAttribute("role", "checkbox");
          box.setAttribute("aria-checked", String(checked));
          box.setAttribute("aria-label", "p." + n);
          box.disabled = !canEdit;
          box.innerHTML = checked
            ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : "";
          box.appendChild(el("span", "page-num", String(n)));
          if (canEdit) {
            box.addEventListener("click", (function (page) {
              return function () { self.togglePage(g, e, page); };
            })(n));
          }
          row.appendChild(box);
        }
        const photoBtn = self.renderPhotoButton(g, e, spread, canEdit);
        if (photoBtn) row.appendChild(photoBtn);
        pages.appendChild(row);
      });
      li.appendChild(pages);

      let note = "";
      if (e.overdue) note = "期限を過ぎています。残りをまとめて表示しています";
      else if (e.status === "partial" && date < self.data.today) note = "p." + e.record + " までできた（残りは次の日以降に回しました）";
      else if (e.status === "missed") note = "できなかった分は、次の日以降に回しました";
      if (note) li.appendChild(el("p", "todo-note", note));
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
