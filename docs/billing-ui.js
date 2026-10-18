/**
 * 授業料の画面部品（spec §16）。保護者アプリと講師アプリで共有する。
 * 月ごとのカード（実施日・金額・支払い期限・入金の状態）と領収書を作る
 */
(function (root) {
  "use strict";

  const B = root.Billing;
  const L = root.Lessons;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, label, onClick) {
    const b = el("button", className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  /** "11/30(月)" */
  function shortDate(key) {
    return L.shortDate(key);
  }

  /** "2026年11月3日" */
  function longDate(key) {
    const p = key.split("-");
    return p[0] + "年" + Number(p[1]) + "月" + Number(p[2]) + "日";
  }

  /**
   * 1か月分のカード。
   * billing は Billing.monthBilling の結果、payment はその月の入金記録（無ければ null）。
   * options:
   *   role            "parent" | "tutor"
   *   paypayLink      保護者アプリ: PayPay の受け取りリンク
   *   onToggleLesson  講師アプリ: (item, cancelled) => void。実施しなかった授業を休みにする／戻す
   *   onConfirm       講師アプリ: (billing) => void。入金を確認した
   *   onCancelPayment 講師アプリ: (payment) => void
   *   onReceipt       (payment) => void。領収書を開く
   */
  function renderMonthCard(billing, payment, options) {
    const o = options || {};
    const tutor = o.role === "tutor";
    const paid = !!payment;
    const card = el("section", "bill-card" + (paid ? " is-paid" : billing.closed ? " is-due" : " is-current"));

    const head = el("div", "bill-head");
    head.appendChild(el("h3", "bill-month", B.monthLabel(billing.month)));
    head.appendChild(el("span", "bill-status", paid ? "入金済み" : billing.closed ? "未入金" : "今月"));
    card.appendChild(head);

    if (billing.grade) {
      card.appendChild(el("p", "bill-grade", billing.grade.label + "・1回 " + B.yen(B.rateForGrade(billing.grade))));
    } else {
      card.appendChild(el("p", "bill-grade bill-warn", tutor ? "学年が未設定のため金額を計算できません" : "金額は先生が学年を設定すると表示されます"));
    }

    // 実施日
    const list = el("ul", "bill-lessons");
    if (billing.items.length === 0) list.appendChild(el("li", "bill-lesson bill-none", "この月の授業はありません"));
    billing.items.forEach(function (x) {
      const li = el("li", "bill-lesson" + (x.cancelled ? " is-cancelled" : x.done ? " is-done" : " is-planned"));
      li.appendChild(el("span", "bill-lesson-date", shortDate(x.date)));
      li.appendChild(el("span", "bill-lesson-time", L.timeRange(x)));
      li.appendChild(el("span", "bill-lesson-state", x.cancelled ? "休み" : x.done ? "実施" : "予定"));
      if (x.note) li.appendChild(el("span", "bill-lesson-note", x.note));
      // 実施の有無を講師が直せるのは、入金前の過ぎた授業だけ。足した授業（extra）は授業の予定の画面で消す
      if (tutor && !paid && x.kind === "weekly" && (x.done || x.cancelled) && o.onToggleLesson) {
        li.appendChild(button("mini-btn bill-toggle", x.cancelled ? "実施に戻す" : "休みにする", function () { o.onToggleLesson(x, !x.cancelled); }));
      }
      list.appendChild(li);
    });
    card.appendChild(list);

    // 金額
    const sum = el("dl", "bill-sum");
    const row = function (label, value, strong) {
      const dt = el("dt", "", label);
      const dd = el("dd", strong ? "bill-strong" : "", value);
      sum.append(dt, dd);
    };
    if (paid) {
      row("お支払い済み", B.yen(payment.amount) + "（" + payment.lessonCount + "回）", true);
      if (payment.paidAt) row("入金日", longDate(payment.paidAt));
      if (tutor && billing.closed && payment.amount !== billing.amountTotal) {
        sum.appendChild(el("dd", "bill-warn bill-note", "予定が変わっています（今の計算: " + B.yen(billing.amountTotal) + "）。領収書は記録した金額のままです"));
      }
    } else {
      const rateText = billing.grade ? " × " + B.yen(B.rateForGrade(billing.grade)) : "";
      row("実施", billing.doneCount + "回" + rateText, false);
      if (billing.plannedCount > 0) row("予定", billing.plannedCount + "回");
      row(billing.closed ? "請求額" : "今月の見込み", B.yen(billing.amountTotal), true);
      if (!billing.closed && billing.plannedCount > 0) row("実施分", B.yen(billing.amountDone));
      row("支払い期限", shortDate(billing.dueDate));
    }
    card.appendChild(sum);

    // 操作
    const actions = el("div", "bill-actions");
    if (!tutor) {
      if (!paid && billing.amountTotal > 0) {
        if (o.paypayLink) {
          const a = el("a", "btn btn-primary btn-block", "PayPay で支払う");
          a.href = o.paypayLink;
          a.target = "_blank";
          a.rel = "noopener";
          actions.appendChild(a);
          actions.appendChild(el("p", "hint bill-hint", billing.closed
            ? "PayPay が開いたら " + B.yen(billing.amountTotal) + " を送ってください"
            : "月末に金額が確定してからお支払いください"));
        } else {
          actions.appendChild(el("p", "hint bill-hint", "お支払い方法は先生にご確認ください"));
        }
      }
      if (paid && o.onReceipt) actions.appendChild(button("btn btn-secondary btn-block", "領収書を見る", function () { o.onReceipt(payment); }));
    } else {
      if (!paid && o.onConfirm) {
        actions.appendChild(button("btn btn-primary btn-block", "入金を確認した（" + B.yen(billing.amountTotal) + "）", function () { o.onConfirm(billing); }));
      }
      if (paid) {
        actions.appendChild(el("p", "bill-receipt-no", "領収書 No. " + payment.receiptNo));
        const row2 = el("div", "bill-actions-row");
        if (o.onReceipt) row2.appendChild(button("btn btn-secondary", "領収書", function () { o.onReceipt(payment); }));
        if (o.onCancelPayment) row2.appendChild(button("mini-btn danger", "入金を取り消す", function () { o.onCancelPayment(payment); }));
        actions.appendChild(row2);
      }
    }
    if (actions.childNodes.length) card.appendChild(actions);
    return card;
  }

  /**
   * 領収書。入金記録に保存した値だけで作る（後から授業の予定を直しても変わらない）。
   * 電子的に発行する領収書なので収入印紙は不要
   */
  function renderReceipt(payment, studentName, tutorName) {
    const box = el("article", "receipt");
    box.appendChild(el("h2", "receipt-title", "領収書"));
    const meta = el("div", "receipt-meta");
    meta.appendChild(el("span", "", "No. " + payment.receiptNo));
    meta.appendChild(el("span", "", payment.paidAt ? longDate(payment.paidAt) : ""));
    box.appendChild(meta);
    box.appendChild(el("p", "receipt-to", (payment.recipient || studentName) + " 様"));
    box.appendChild(el("p", "receipt-amount", B.yen(payment.amount) + " -"));
    const dates = (payment.lessonDates || []).map(function (d) { const p = d.split("-"); return Number(p[1]) + "/" + Number(p[2]); }).join("、");
    box.appendChild(el("p", "receipt-for", "但し " + B.monthLabel(payment.month) + " 授業料として（" + payment.lessonCount + "回" + (dates ? ": " + dates : "") + "）"));
    box.appendChild(el("p", "receipt-line", "上記正に領収いたしました。"));
    box.appendChild(el("p", "receipt-method", "PayPay にて受領"));
    box.appendChild(el("p", "receipt-issuer", tutorName || ""));
    return box;
  }

  root.BillingView = { renderMonthCard: renderMonthCard, renderReceipt: renderReceipt };
})(self);
