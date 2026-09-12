/**
 * 講師用の補助機能（スプレッドシートのメニュー）。
 * メニューはスクリプトがスプレッドシートにバインドされているときだけ表示される
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Study Portal")
    .addItem("返信を追加", "showReplyDialog")
    .addItem("生徒を追加（合言葉を発行）", "showAddStudentDialog")
    .addItem("合言葉を再発行", "showReissueDialog")
    .addSeparator()
    .addItem("初期設定（シート作成）", "setup")
    .addToUi();
}

/** 3シートとヘッダーを作る。既にあるシートは触らない。何度実行しても安全 */
function setup() {
  const ss = SpreadsheetApp.openById(getProp("SPREADSHEET_ID"));
  Object.keys(HEADERS).forEach(function (name) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.setFrozenRows(1);
    }
    // 列を追加したバージョンに上げたとき、既存シートのヘッダーも揃える。既存のデータ行には触らない
    sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
  });
  // ROOT_FOLDER_ID と NOTIFY_EMAIL が設定されているかもここで確かめておく
  DriveApp.getFolderById(getProp("ROOT_FOLDER_ID"));
  getProp("NOTIFY_EMAIL");
  getProp("TUTOR_EMAIL");
  getProp("GOOGLE_CLIENT_ID");
  console.log("初期設定が完了しました");
}

function showReplyDialog() {
  const options = readRows(SHEET.STUDENTS)
    .filter(function (r) { return isTrue(r.values[5]); })
    .map(function (r) {
      return '<option value="' + escapeHtml(r.values[0]) + '">' + escapeHtml(r.values[1]) + "</option>";
    }).join("");

  const html =
    '<style>body{font-family:sans-serif;font-size:14px}select,textarea{width:100%;box-sizing:border-box;margin:4px 0 12px;font-size:14px}textarea{height:140px}#msg{color:#c00}</style>' +
    '<label>生徒<select id="sid">' + options + "</select></label>" +
    '<label>本文（1000文字以内）<textarea id="body" maxlength="1000"></textarea></label>' +
    '<button id="send">送信</button> <span id="msg"></span>' +
    "<script>" +
    'document.getElementById("send").onclick=function(){' +
    'var b=this;b.disabled=true;' +
    'google.script.run.withSuccessHandler(function(){google.script.host.close();})' +
    '.withFailureHandler(function(e){b.disabled=false;document.getElementById("msg").textContent=e.message;})' +
    '.addTutorReply(document.getElementById("sid").value,document.getElementById("body").value);};' +
    "</script>";
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(420).setHeight(320), "返信を追加");
}

/** 手入力だと created_at の書式を間違えやすいので、ダイアログ経由を推奨する */
function addTutorReply(studentId, body) {
  const text = String(body || "").trim();
  if (!text) throw new Error("本文を入力してください");
  if (text.length > MESSAGE_MAX_LENGTH) throw new Error("本文は1000文字以内にしてください");
  const exists = readRows(SHEET.STUDENTS).some(function (r) { return r.values[0] === studentId; });
  if (!exists) throw new Error("生徒が見つかりません");
  appendMessage(studentId, "tutor", text);
}

function showAddStudentDialog() {
  const ui = SpreadsheetApp.getUi();
  const nameRes = ui.prompt("生徒を追加", "生徒の表示名（例: 山田太郎）", ui.ButtonSet.OK_CANCEL);
  if (nameRes.getSelectedButton() !== ui.Button.OK) return;
  const slugRes = ui.prompt("生徒を追加", "ファイル名用の名前（英小文字・数字・ハイフン。例: yamada）", ui.ButtonSet.OK_CANCEL);
  if (slugRes.getSelectedButton() !== ui.Button.OK) return;
  try {
    const result = generateToken(nameRes.getResponseText(), slugRes.getResponseText());
    ui.alert(
      "合言葉を発行しました",
      result.name + " さんの合言葉:\n\n" + result.token + "\n\n" +
      "この画面を閉じると二度と表示できません。控えてから生徒に伝えてください。\n" +
      "（シートにはハッシュだけが保存されます）",
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert(err.message);
  }
}

function showReissueDialog() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt("合言葉を再発行", "student_id（例: stu_a1b2c3d4）。古い合言葉は使えなくなります", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  try {
    const result = reissueToken(res.getResponseText().trim());
    ui.alert("合言葉を再発行しました", "新しい合言葉:\n\n" + result.token + "\n\nこの画面を閉じると二度と表示できません。", ui.ButtonSet.OK);
  } catch (err) {
    ui.alert(err.message);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
