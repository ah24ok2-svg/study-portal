# tutor-app

オンライン家庭教師の提出・連絡アプリ。個人事業、生徒1〜20人規模。

**仕様は `spec.md` にある。実装前に必ず読むこと。** このファイルは運用ルールだけを書く。

---

## 構成

```
docs/        生徒アプリ。GitHub Pages の配信元（素のHTML/CSS/JS、ビルドなし）
docs/tutor/  講師アプリ（spec.md §13）
gas/     Google Apps Script。clasp でデプロイする
spec.md  仕様書
```

- フロントは `docs/` に置く。GitHub Pages のブランチ配信はルートか `/docs` しか選べないため、名前を変えない
- リポジトリは**公開**。GitHub Pages を無料プランで使うための必須条件
- フレームワークは使わない。依存は CDN の jsPDF と pdf.js、講師アプリの通知用に Firebase Messaging（gstatic の compat 版）のみ（講師のログインは Google の OAuth 画面へのリダイレクトで行い、SDK は読まない）

---

## 絶対にコミットしないもの

リポジトリが公開されているため、以下が混入すると即座に実害が出る。

- 生徒の氏名、学校名、連絡先
- 合言葉トークン（平文・ハッシュを問わない）
- スプレッドシートID、DriveフォルダID
- `.clasp.json` / `.clasprc.json`（後者にはGoogleの認証情報が入る）
- テスト用の実物の答案PDF・画像

IDや秘密情報は GAS の Script Properties に置く。ソースに直書きしない。
`docs/config.js` に入れてよいのは `GAS_URL`、`GOOGLE_CLIENT_ID`、`FIREBASE_CONFIG`、`FIREBASE_VAPID_KEY`（どれも公開前提の値）だけ。
通知の送信は講師本人の OAuth トークンで行い、サービスアカウント鍵は作らない（spec.md §13.6）。

---

## GAS の扱い

`gas/` のコードはローカルで編集し、`clasp push` で反映する。

```bash
cd gas
clasp push          # コードを反映
clasp deploy        # 新バージョンをデプロイ（URLは変わらない）
```

- **GASのコードをブラウザのスクリプトエディタで直接編集しない。** ローカルと乖離する
- デプロイ設定は「実行者: 自分」「アクセス: 全員」。これを変えると動かないか情報漏洩する
- クラウドセッション（claude.ai/code）からは `clasp push` できない。
  ネットワーク制限とOAuthの都合による。GASの変更はコードを書くところまでに留め、
  デプロイはローカルで行う

---

## 実装上、必ず守る点

仕様書に詳細があるが、忘れると必ずバグになるものを再掲する。

1. **fetch の Content-Type は `text/plain;charset=utf-8`**
   `application/json` にするとCORSプリフライトが発生し、GASは応答できない
2. **`redirect: "follow"` が必須**
   GAS Web App は302で別ドメインに転送する
3. **`student_id` をリクエストボディから受け取らない**
   必ずトークンから逆引きする。受け取ると他人の提出物を読めてしまう
4. **画像読み込みは `createImageBitmap(file, { imageOrientation: "from-image" })`**
   EXIF回転を無視すると答案が90度倒れる
5. **base64化はチャンク分割する**
   `String.fromCharCode(...new Uint8Array(buf))` はスタックオーバーフローする
6. **シートへの書き込みは `LockService` で囲む**
7. **アップロードのバリデーションはサーバー側で行う**
   クライアントの `accept` 属性は検証ではない

---

## コーディング規約

- UIの文言はすべて日本語
- エラーメッセージは生徒が読んで対処できる言葉にする。技術用語やスタックトレースを出さない
- 生徒に見せる画面は幅375pxを基準にする
- コメントは「なぜそうしたか」を書く。「何をしているか」はコードで読める
- GAS側は `Code.js` に全部入れず、`auth.js` / `upload.js` / `messages.js` / `tutor.js` / `push.js` に分ける
- 講師 API は `authenticateTutor(req.tutorToken)` を必ず通す。生徒の `token` では講師 API を呼べないようにする

---

## テスト

- **実データで試さない。** 答案には生徒の氏名や学校名が写り込む。ダミーPDFと手書きの落書きを使う
- カメラまわりは実機でしか確認できない。iPhone と Android の両方で確認する
- 変更を本番に出す前に、自分のトークンで一通り通す

---

## 現在の進捗

<!-- フェーズが進んだらここを更新する -->

- [ ] フェーズ1: 疎通（シート作成、login API）
- [ ] フェーズ2: アップロード
- [ ] フェーズ3: メッセージ
- [ ] フェーズ4: フロント
- [ ] フェーズ4.5: カメラ撮影とPDF変換
- [ ] フェーズ5: 仕上げ
