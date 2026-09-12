# tutor-app

オンライン家庭教師の提出・連絡アプリ。仕様は [spec.md](spec.md)、運用ルールは [CLAUDE.md](CLAUDE.md)。

## セットアップ手順

### 1. スプレッドシートと Drive フォルダを用意する
1. Google スプレッドシートを新規作成する（名前は自由）
2. マイドライブに `家庭教師_提出物` フォルダを作る
3. それぞれの URL から ID を控える（**リポジトリには書かない**）
   - スプレッドシート: `https://docs.google.com/spreadsheets/d/<ここ>/edit`
   - フォルダ: `https://drive.google.com/drive/folders/<ここ>`

### 2. GAS をデプロイする
スプレッドシートにメニューを出すため、スクリプトはスプレッドシートにバインドする。

1. スプレッドシートで「拡張機能 → Apps Script」を開き、プロジェクトを作る
2. 「プロジェクトの設定」でスクリプト ID を控え、「スクリプト プロパティ」に次を追加する
   - `SPREADSHEET_ID` / `ROOT_FOLDER_ID` / `NOTIFY_EMAIL`
3. ローカルで clasp を使って反映する
   ```bash
   npm install -g @google/clasp
   clasp login
   cd gas
   # .clasp.json を手で作る（.gitignore 済み。clone するとローカルのコードが上書きされるため使わない）
   echo '{"scriptId":"<スクリプトID>","rootDir":"."}' > .clasp.json
   clasp push   # 「マニフェストを上書きしますか」には Yes
   ```
4. エディタで関数 `setup` を1回実行する（権限の承認が出る）。3シートが作られる
5. 「デプロイ → 新しいデプロイ → ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
6. 表示された `https://script.google.com/macros/s/.../exec` を `docs/config.js` の `GAS_URL` に入れる

### 3. 生徒を登録する
スプレッドシートを開き直すとメニュー「Study Portal」が出る。

- **生徒を追加（合言葉を発行）**: 表示名とファイル名用の英字名を入れると合言葉が1度だけ表示される
- **返信を追加**: 生徒へのメッセージを送る（シートに直接書いてもよいが、日時の書式ミスを防げる）
- **合言葉を再発行**: 忘れた生徒向け。古い合言葉は無効になる

### 4. フロントを公開する
GitHub の公開リポジトリに push し、「Settings → Pages」で `main` ブランチの `/docs` を配信元にする。

### 疎通確認（フェーズ1）
```bash
curl -L -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"login","token":"<自分用に発行した合言葉>"}' \
  "https://script.google.com/macros/s/<デプロイID>/exec"
```

## ファイル構成

```
docs/               フロントエンド（GitHub Pages）
  index.html
  style.css
  app.js            画面・API呼び出し・画像→PDF変換
  config.js         GAS_URL のみ
  manifest.json
  icons/
gas/                Google Apps Script
  Code.js           doPost・共通処理
  auth.js           合言葉認証・レート制限・発行
  messages.js       getMessages / sendMessage
  upload.js         upload / getSubmissions・ファイル命名
  admin.js          スプレッドシートのメニュー・初期設定
  appsscript.json
```
