/**
 * 保護者アプリと授業料（spec §16）。
 * 月ごとの金額はサーバーでは計算しない（docs/billing.js が端末で計算する）。
 * ここは保護者の認証、学年と保護者の合言葉の設定、入金の記録だけを担う
 */

const GRADE_LABELS = ["小1", "小2", "小3", "小4", "小5", "小6", "中1", "中2", "中3", "高1", "高2", "高3"];
const PAYMENT_AMOUNT_MAX = 1000000;
const PAYMENT_LESSONS_MAX = 62;
const RECIPIENT_MAX = 40;
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 年度（4月始まり）。学年を "2026:中1" の形で保存するのに使う */
function schoolYearOf(dateKey) {
  const p = dateKey.split("-");
  return Number(p[1]) >= 4 ? Number(p[0]) : Number(p[0]) - 1;
}

function ensureBillingSheets() {
  ensureSheets([SHEET.PAYMENTS]);
}

// ---------------------------------------------------------------------------
// 保護者の認証。生徒の合言葉とは別の合言葉で、同じ students 行の I 列にハッシュを置く

function authenticateParent(parentToken) {
  const cache = CacheService.getScriptCache();
  if (cache.get("auth_lock")) {
    throw new AppError("RATE_LIMITED", "しばらく時間をおいてからお試しください");
  }
  if (typeof parentToken !== "string" || !TOKEN_PATTERN.test(parentToken)) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "合言葉が正しくありません");
  }
  const tokenHash = hashToken(parentToken);
  enforceRateLimit(cache, tokenHash);

  const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[8] === tokenHash; });
  if (!row || !isTrue(row.values[5])) {
    recordAuthFailure(cache);
    throw new AppError("INVALID_TOKEN", "合言葉が正しくありません");
  }
  return { studentId: String(row.values[0]), name: String(row.values[1]), gradeBase: String(row.values[7] || ""), rowNumber: row.rowNumber };
}

function handleParentLogin(req) {
  const student = authenticateParent(req.parentToken);
  return ok({ name: student.name });
}

function readPayments(studentId) {
  return readRows(SHEET.PAYMENTS)
    .filter(function (r) { return r.values[1] === studentId; })
    .map(function (r) {
      return {
        paymentId: String(r.values[0]),
        month: String(r.values[2] || ""),
        amount: Number(r.values[3]) || 0,
        lessonCount: Number(r.values[4]) || 0,
        lessonDates: parseJsonArray(r.values[5]).filter(isValidDateKey),
        receiptNo: String(r.values[6] || ""),
        recipient: String(r.values[7] || ""),
        paidAt: toDateKey(r.values[8]),
        rowNumber: r.rowNumber
      };
    })
    .filter(function (p) { return MONTH_KEY_PATTERN.test(p.month); });
}

function publicPayment(p) {
  return { paymentId: p.paymentId, month: p.month, amount: p.amount, lessonCount: p.lessonCount, lessonDates: p.lessonDates, receiptNo: p.receiptNo, recipient: p.recipient, paidAt: p.paidAt };
}

/** 保護者に見せるもの。やりとりと提出物は含めない（spec §16.1） */
function billingPayload(student) {
  const plan = planPayload(student.studentId);
  return {
    student: { name: student.name, gradeBase: student.gradeBase },
    // 計画の写真は生徒と講師の間のものなので保護者には返さない
    plan: { goals: plan.goals, progress: plan.progress, photos: [], today: plan.today },
    lessons: lessonsPayload(student.studentId),
    payments: readPayments(student.studentId).map(publicPayment),
    // 領収書の発行者名と PayPay の受け取りリンク。Script Properties に置き、ソースには書かない
    tutorName: getOptionalProp("TUTOR_NAME"),
    paypayLink: getOptionalProp("PAYPAY_LINK"),
    today: lessonToday()
  };
}

function handleParentGetSummary(req) {
  const student = authenticateParent(req.parentToken);
  ensurePlanSheets();
  ensureLessonSheets();
  ensureBillingSheets();
  return ok(billingPayload(student));
}

// ---------------------------------------------------------------------------
// 講師向け

/** 講師アプリの「請求」。保護者が見るものと同じ材料に、設定の状態を添えて返す */
function handleTutorGetBilling(req) {
  authenticateTutor(req.tutorToken);
  ensureLessonSheets();
  ensureBillingSheets();
  const student = findActiveStudent(req.studentId);
  const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[0] === student.studentId; });
  return ok({
    gradeBase: String(row.values[7] || ""),
    parentTokenIssued: !!row.values[8],
    lessons: lessonsPayload(student.studentId),
    payments: readPayments(student.studentId).map(publicPayment),
    tutorName: getOptionalProp("TUTOR_NAME"),
    paypayLinkSet: !!getOptionalProp("PAYPAY_LINK"),
    today: lessonToday()
  });
}

/** 学年を設定する。保存は "2026:中1" の形（今年度の学年）。4月になれば端末側で1つ上がる */
function handleTutorSetGrade(req) {
  authenticateTutor(req.tutorToken);
  const student = findActiveStudent(req.studentId);
  if (GRADE_LABELS.indexOf(req.grade) === -1) throw new AppError("VALIDATION_ERROR", "学年を選んでください");
  const gradeBase = schoolYearOf(lessonToday()) + ":" + req.grade;
  withLock(function () {
    const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[0] === student.studentId; });
    getSheet(SHEET.STUDENTS).getRange(row.rowNumber, 8).setValue(gradeBase);
  });
  return ok({ gradeBase: gradeBase });
}

/** 保護者の合言葉を発行する。平文はこの応答にだけ1度出る。再発行すると前の合言葉は使えなくなる */
function handleTutorIssueParentToken(req) {
  authenticateTutor(req.tutorToken);
  const student = findActiveStudent(req.studentId);
  const token = createRandomToken();
  withLock(function () {
    const row = readRows(SHEET.STUDENTS).find(function (r) { return r.values[0] === student.studentId; });
    getSheet(SHEET.STUDENTS).getRange(row.rowNumber, 9).setValue(hashToken(token));
  });
  return ok({ parentToken: token });
}

/**
 * 入金を確認した記録。金額と実施日は講師アプリが計算して送る（docs/billing.js）。
 * ここで保存した値を領収書に使うので、後から授業の予定を直しても領収書は変わらない
 */
function handleTutorConfirmPayment(req) {
  authenticateTutor(req.tutorToken);
  ensureBillingSheets();
  const student = findActiveStudent(req.studentId);
  const input = req.payment;
  if (!input || typeof input !== "object") throw new AppError("VALIDATION_ERROR", "入金の内容が正しくありません");
  if (!MONTH_KEY_PATTERN.test(input.month)) throw new AppError("VALIDATION_ERROR", "月が正しくありません");
  if (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > PAYMENT_AMOUNT_MAX) {
    throw new AppError("VALIDATION_ERROR", "金額が正しくありません");
  }
  const dates = Array.isArray(input.lessonDates) ? input.lessonDates : [];
  if (dates.length > PAYMENT_LESSONS_MAX || !dates.every(function (d) { return isValidDateKey(d) && d.slice(0, 7) === input.month; })) {
    throw new AppError("VALIDATION_ERROR", "実施日が正しくありません");
  }
  const recipient = (typeof input.recipient === "string" ? input.recipient : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (Array.from(recipient).length > RECIPIENT_MAX) throw new AppError("VALIDATION_ERROR", "宛名は" + RECIPIENT_MAX + "文字以内にしてください");
  const paidAt = input.paidAt === undefined ? lessonToday() : input.paidAt;
  if (!isValidDateKey(paidAt) || paidAt > lessonToday()) throw new AppError("VALIDATION_ERROR", "入金日が正しくありません");

  const saved = withLock(function () {
    const existing = readPayments(student.studentId).find(function (p) { return p.month === input.month; });
    if (existing) throw new AppError("VALIDATION_ERROR", "この月は入金済みになっています。画面を開き直してください");
    const sheet = getSheet(SHEET.PAYMENTS);
    // 領収書番号は通し番号。消した番号は再利用しない（最大値 + 1）
    const maxSeq = readRows(SHEET.PAYMENTS).reduce(function (m, r) {
      const n = Number(String(r.values[6] || "").split("-").pop());
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    const receiptNo = input.month.replace("-", "") + "-" + String(maxSeq + 1).padStart(4, "0");
    const id = newId("pay_");
    sheet.appendRow([id, student.studentId, input.month, input.amount, dates.length, JSON.stringify(dates.slice().sort()), receiptNo, recipient, paidAt, nowIso()]);
    return { paymentId: id, receiptNo: receiptNo };
  });
  return ok(saved);
}

function handleTutorCancelPayment(req) {
  authenticateTutor(req.tutorToken);
  ensureBillingSheets();
  const student = findActiveStudent(req.studentId);
  withLock(function () {
    const payment = readPayments(student.studentId).find(function (p) { return p.paymentId === req.paymentId; });
    if (!payment) throw new AppError("VALIDATION_ERROR", "入金の記録が見つかりません。画面を開き直してください");
    getSheet(SHEET.PAYMENTS).deleteRow(payment.rowNumber);
  });
  return ok({});
}
