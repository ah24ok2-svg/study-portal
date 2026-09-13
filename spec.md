# オンライン家庭教師 提出・連絡アプリ 仕様書

## 0. この文書について

個人事業のオンライン家庭教師が、生徒から答案PDFを受け取り、簡単なメッセージのやり取りをするためのWebアプリの仕様。
実装は Claude Code で行う前提。上から順に読めば実装できるように書いてある。

---

## 1. 目的とスコープ

### やること
- 生徒がスマホのカメラで答案を撮影すると、自動でPDFに変換されてアップロードされる
- 複数ページの答案を1つのPDFにまとめられる
- 既存のPDF/画像ファイルを選んでアップロードすることもできる
- アップロード完了時、生徒側に完了表示が出る
- アップロードされたファイルが講師のGoogle Driveの所定フォルダに保存される
- 生徒と講師が簡単なテキストメッセージをやり取りする
- 生徒が過去の提出履歴を見られる

### やらないこと（v1では）
- リアルタイムチャット（ポーリングで十分）
- 講師側の管理画面（講師はDriveとスプレッドシートを直接見る）
- プッシュ通知
- 決済、スケジュール管理
- 添削済みファイルの返却機能（v2で検討）

### 想定規模
- 生徒数: 1〜20人
- 1日あたりの提出: 数件
- ファイルサイズ: 1件あたり最大20MB

---

## 2. システム構成

```
生徒のスマホ
    │  HTTPS
    ▼
GitHub Pages (静的ホスティング)
  index.html / app.js / style.css / manifest.json
    │  fetch POST (Content-Type: text/plain)
    ▼
Google Apps Script Web App  ←← バックエンド
  doPost(e) 単一エンドポイント
    │
    ├──▶ Google Drive (提出ファイルの保存先)
    └──▶ Google スプレッドシート (生徒マスタ / メッセージ / 提出ログ)
```

### 各層の責務

| 層 | 責務 | やってはいけないこと |
|---|---|---|
| GitHub Pages | 画面描画、入力受付、base64エンコード | Driveの認証情報を持つこと |
| GAS Web App | 認証、権限判定、Drive書き込み、シート読み書き | 生徒からの入力を検証せず使うこと |
| Drive / Sheets | 保存 | — |

### なぜこの構成か
GitHub Pages は静的配信のみで、秘密情報を隠せない。
GAS Web App を「実行者: 自分」でデプロイすると、講師本人の権限でDriveに書き込めるため、
生徒側に一切の認証情報を渡さずに済む。

---

## 3. 認証設計

本格的なアカウント認証は v1 では実装しない。**合言葉トークン方式**を採用する。

### 方式
1. 講師が生徒ごとにランダムな合言葉（トークン）を発行し、口頭またはメールで伝える
2. 生徒は初回アクセス時にトークンを入力する
3. GAS側でトークンのSHA-256ハッシュを照合し、一致すれば `student_id` を返す
4. フロントは `localStorage` にトークンを保存し、以降のリクエストに毎回添える

### トークン仕様
- 形式: 英小文字と数字のみ、16文字（例: `k7m2p9x4wq3nz8vb`）
- 紛らわしい文字（`0/o`, `1/l/i`）は除外して生成する
- スプレッドシートには**平文を保存しない**。SHA-256ハッシュのみ保存する
- 発行用のGAS関数 `generateToken(studentName)` を用意し、実行ログに平文を1度だけ出力する

### レート制限
- 同一トークンで 60秒あたり 30リクエストを超えたら `429` を返す
- ログイン失敗は IP 単位では追えないため、トークン照合失敗が 10分で 20回を超えたら全体で一時ロックし、講師にメール通知する

---

## 4. データ設計（Googleスプレッドシート）

スプレッドシート1つに3シート。シート名は厳密に一致させること。

### シート `students`

| 列 | 名前 | 型 | 説明 |
|---|---|---|---|
| A | student_id | string | `stu_` + 8文字のランダム英数字 |
| B | name | string | 生徒の表示名（漢字可） |
| C | name_slug | string | ファイル名用。英数字とハイフンのみ |
| D | token_hash | string | SHA-256ハッシュ（hex小文字） |
| E | folder_id | string | この生徒専用のDriveフォルダID |
| F | active | boolean | `TRUE` / `FALSE`。退会時に `FALSE` |
| G | created_at | string | ISO 8601 |

### シート `messages`

| 列 | 名前 | 型 | 説明 |
|---|---|---|---|
| A | message_id | string | `msg_` + UUID |
| B | student_id | string | |
| C | sender | string | `student` または `tutor` |
| D | body | string | 本文。最大1000文字 |
| E | created_at | string | ISO 8601 |
| F | read_by_student | boolean | |

講師からの返信は、講師がこのシートに直接行を追加する運用とする（v1）。
`sender` に `tutor`、`created_at` に `=TEXT(NOW(),...)` ではなく実値を入れること。
入力補助として、GASのメニューから「返信を追加」ダイアログを開く関数を用意すると良い。

### シート `submissions`

| 列 | 名前 | 型 | 説明 |
|---|---|---|---|
| A | submission_id | string | `sub_` + UUID |
| B | student_id | string | |
| C | file_id | string | Drive のファイルID |
| D | file_name | string | 保存後のファイル名 |
| E | mime_type | string | |
| F | size_bytes | number | デコード後の実サイズ |
| G | note | string | 生徒が添えたコメント。任意、最大200文字 |
| H | created_at | string | ISO 8601 |

### 書き込み時の排他制御
複数の生徒が同時に提出するとシートの行がずれる可能性がある。
シートへの追記は必ず `LockService.getScriptLock()` で囲むこと。タイムアウトは10秒。

---

## 5. Drive のフォルダ構成

```
講師のマイドライブ/
  家庭教師_提出物/          ← ルートフォルダ (ID を Script Properties に保存)
    山田太郎/                ← 生徒ごとのフォルダ (students.folder_id)
      20260912_yamada_二次関数.pdf
      20260915_yamada_確率.pdf
    佐藤花子/
      ...
```

- 生徒フォルダは**共有しない**。生徒はアプリ経由でしかアクセスできない
- 生徒フォルダが存在しない場合、GAS が自動作成して `students.folder_id` を更新する

### ファイル命名規則
```
{YYYYMMDD}_{name_slug}_{元のファイル名}
```
- 日付は Asia/Tokyo で算出する
- 元のファイル名から `/ \ : * ? " < > |` と制御文字を除去する
- 全体が100文字を超える場合、元のファイル名側を切り詰める（拡張子は保持）
- 同名が既に存在する場合、拡張子の前に `_2`, `_3` を付けて回避する

---

## 6. API仕様

GAS Web App のエンドポイントは1つだけ。`doPost(e)` で `action` により分岐する。

### 共通事項

**リクエスト**
- メソッド: `POST`
- `Content-Type: text/plain;charset=utf-8`
  （重要: `application/json` にすると CORS プリフライトが発生し、GAS はこれを処理できない。
  必ず simple request にすること。ボディの中身は JSON 文字列で良い）
- ボディ: JSON 文字列

**レスポンス**
`ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON)`

成功:
```json
{ "ok": true, "data": { ... } }
```

失敗:
```json
{ "ok": false, "error": { "code": "INVALID_TOKEN", "message": "合言葉が正しくありません" } }
```

HTTPステータスは GAS の仕様上つねに 200 になる。`ok` フィールドで判定すること。

**エラーコード一覧**

| code | 意味 |
|---|---|
| `INVALID_TOKEN` | トークン不一致、または `active` が `FALSE` |
| `RATE_LIMITED` | レート制限 |
| `FILE_TOO_LARGE` | サイズ上限超過 |
| `UNSUPPORTED_TYPE` | 許可されていないMIMEタイプ |
| `VALIDATION_ERROR` | 必須項目の欠落、文字数超過 |
| `INTERNAL_ERROR` | それ以外 |

---

### 6.1 `login`

トークンを検証し、生徒情報を返す。

リクエスト:
```json
{ "action": "login", "token": "k7m2p9x4wq3nz8vb" }
```

レスポンス:
```json
{ "ok": true, "data": { "studentId": "stu_a1b2c3d4", "name": "山田太郎" } }
```

---

### 6.2 `getMessages`

メッセージ一覧を取得する。フロントは30秒間隔でポーリングする。

リクエスト:
```json
{ "action": "getMessages", "token": "...", "since": "2026-09-12T00:00:00.000Z" }
```
`since` は任意。省略時は直近50件を返す。

レスポンス:
```json
{
  "ok": true,
  "data": {
    "messages": [
      { "id": "msg_...", "sender": "tutor", "body": "答案見ました", "createdAt": "2026-09-12T04:30:00.000Z" }
    ]
  }
}
```
`createdAt` の昇順で返すこと。

---

### 6.3 `sendMessage`

リクエスト:
```json
{ "action": "sendMessage", "token": "...", "body": "提出しました" }
```

- `body` は空文字不可、1000文字以下
- 前後の空白をトリムする

レスポンス:
```json
{ "ok": true, "data": { "id": "msg_...", "createdAt": "..." } }
```

---

### 6.4 `upload`

リクエスト:
```json
{
  "action": "upload",
  "token": "...",
  "fileName": "二次関数.pdf",
  "mimeType": "application/pdf",
  "dataBase64": "JVBERi0xLjQK...",
  "note": "大問3が分かりませんでした"
}
```

**サーバー側のバリデーション（すべて必須）**

1. `mimeType` が許可リストに含まれるか
   - `application/pdf`
   - `image/jpeg`
   - `image/png`
   - `image/heic`
2. `dataBase64` の長さから実サイズを算出し、**20MB以下**か
   - 実サイズ ≒ `dataBase64.length * 3 / 4`
   - GAS の POST 上限は約50MB、base64で約1.33倍に膨らむため20MBを上限とする
3. `fileName` の拡張子が `mimeType` と整合するか
4. `note` は任意、200文字以下

**処理**
```
Utilities.base64Decode(dataBase64)
  → Utilities.newBlob(bytes, mimeType, 保存用ファイル名)
  → DriveApp.getFolderById(folderId).createFile(blob)
```

レスポンス:
```json
{ "ok": true, "data": { "submissionId": "sub_...", "fileName": "20260912_yamada_二次関数.pdf" } }
```

アップロード成功時、`messages` にも `sender: "student"` で
`アップロード完了 ✅ {fileName}（{ページ数}ページ）` という行を自動追加する。
生徒と講師の双方が時系列で状況を追えるようにするため。
ページ数はリクエストの `pageCount`（任意、整数）から取る。無ければ省略する。

この自動メッセージは、やりとり画面では通常の吹き出しではなく
中央寄せの細い帯（システムメッセージ）として表示すること。

---

### 6.5 `getSubmissions`

リクエスト:
```json
{ "action": "getSubmissions", "token": "..." }
```

レスポンス:
```json
{
  "ok": true,
  "data": {
    "submissions": [
      { "id": "sub_...", "fileName": "20260912_yamada_二次関数.pdf", "sizeBytes": 1048576, "note": "...", "createdAt": "..." }
    ]
  }
}
```
新しい順。最大100件。**Driveの閲覧URLは返さない**（生徒に直接アクセスさせない方針のため）。

---

## 7. 画面仕様

### 全体
- モバイルファースト。基準幅 375px
- 下部タブ 2つ: 「やりとり」「提出」
- ヘッダーに生徒名を表示
- 日本語UI。フォントはシステムフォント（`-apple-system`, `Hiragino Sans`, `Noto Sans JP`）

### 7.1 ログイン画面
- 未ログイン時（`localStorage` にトークンが無い、または `login` が失敗した）に表示
- 合言葉の入力欄1つとボタン1つ
- 入力欄は `inputmode="latin"` `autocapitalize="off"` `autocomplete="off"`
- 失敗時はフィールド下に赤字でエラーを表示する

### 7.2 やりとり画面
- メッセージを吹き出しで時系列表示（生徒=右、講師=左）
- 最下部に入力欄と送信ボタン
- 30秒ごとにポーリング。`document.visibilityState === "hidden"` の間はポーリングを停止する
- 新着取得時、最下部にいた場合のみ自動スクロールする

### 7.3 提出画面

画面は4つの状態を持つ。`idle` → `editing` → `uploading` → `done` と遷移する。

#### 状態: idle（初期）
大きなボタンを2つ縦に並べる。タップ領域は高さ64px以上。

1. **「答案を撮影」**（主ボタン）
   `<input type="file" accept="image/*" capture="environment" multiple>`
   カメラが直接起動する
2. **「ファイルを選ぶ」**（副ボタン）
   `<input type="file" accept="application/pdf,image/*" multiple>`
   カメラロールやファイルアプリから選べる。`capture` を付けない

下部に提出履歴のリスト（ファイル名、日時）を表示する。

#### 状態: editing（ページ編集）
1枚以上の画像が選択されると、この状態になる。

- 選択したページをサムネイルの縦リストで表示する
- 各サムネイルに「1ページ目」「2ページ目」の番号、削除ボタン（`ti-x`）、上下の並べ替えボタン
- リスト末尾に「ページを追加」ボタン。再度カメラを起動して追記する
- 「提出物の名前」入力欄（任意、30文字以内）。空欄なら `答案` を使う
- コメント入力欄（任意、200文字以内）
- 合計の推定サイズを表示する（例: 「3ページ / 約1.2MB」）
- 「提出する」ボタン

PDFファイルを直接選んだ場合はこの状態を飛ばし、ファイル名の確認だけで `uploading` に進む。
画像とPDFが混在して選択された場合は「画像とPDFは一緒に提出できません」と表示し、どちらかを選び直させる。

#### 状態: uploading
- 画面全体を覆うオーバーレイを出し、操作をブロックする
- 進捗テキストを段階的に更新する
  1. 「画像を処理しています… (2/3)」
  2. 「PDFを作成しています…」
  3. 「送信しています…」
- 戻るボタンは無効化する
- ブラウザを閉じないよう注意書きを1行添える

#### 状態: done
- 中央に大きなチェックマークと **「アップロード完了 ✅」**
- その下にファイル名と「先生に届きました」の一文
- 200ms 程度のフェードインと、チェックマークの軽いスケールアニメーション
  （`prefers-reduced-motion: reduce` の場合はアニメーションを省く）
- 「続けて提出する」ボタンと「やりとりを見る」ボタン
- 3秒後に自動で `idle` に戻し、履歴リストを更新する

#### 失敗時
- `uploading` から `editing` に戻す。**選択したページは絶対に破棄しない**
  （撮り直しは生徒にとって大きな負担になるため）
- エラー内容に応じたメッセージと「もう一度送る」ボタンを表示する
- サイズ超過の場合は「ページ数を減らすか、画質を下げてお試しください」と具体的な対処を示す

### 7.4 PWA対応
- `manifest.json` に `name`, `short_name`, `start_url`, `display: "standalone"`, `theme_color`, アイコン（192px / 512px）
- `index.html` に `<link rel="manifest">` と `<meta name="apple-mobile-web-app-capable" content="yes">`
- Service Worker は v1 では不要（オフライン動作させない）

### 7.5 エラー表示の方針
- 通信失敗は「通信に失敗しました。電波の良い場所でもう一度お試しください」
- `INVALID_TOKEN` はログイン画面に戻し、`localStorage` をクリアする
- 技術的なエラーメッセージをそのまま生徒に見せない

---

## 8. フロントエンド実装の注意

### 8.1 撮影画像 → PDF のパイプライン

```
File (HEIC/JPEG, 3〜5MB, 4000px)
  → createImageBitmap で読み込み（EXIF回転を適用）
  → canvas に縮小描画（長辺 2000px）
  → canvas.toBlob("image/jpeg", 0.8)  ≒ 300〜500KB
  → jsPDF で A4 ページに配置
  → doc.output("datauristring") → base64部分を取り出す
  → upload API へ
```

#### ライブラリ
jsPDF を CDN から読む。
`https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js`
（GitHub Pages から cdnjs は問題なく読める）

#### EXIF回転
スマホで縦に構えて撮った写真は、実データは横向きでEXIFに回転情報が入っている。
これを無視すると答案が90度倒れたPDFになる。

```js
const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
```
`imageOrientation: "from-image"` を必ず指定すること。
`new Image()` + `src = URL.createObjectURL(file)` の経路はブラウザによって挙動が割れるので使わない。

#### HEIC対応
iOSのカメラロールから選ぶとHEICで渡ってくることがある。
Safariは `createImageBitmap` でHEICをデコードできるが、Android Chromeはできない。
デコードに失敗した場合は例外を捕まえ、
「この画像形式は読み込めませんでした。カメラで撮り直してください」と表示する。
canvas経由で必ずJPEGに変換されるため、サーバー側にHEICが届くのは
「ファイルを選ぶ」で画像を直接アップロードした場合だけになる。

#### 縮小の基準
- 長辺 2000px。答案の文字はこの解像度で十分読める
- JPEG品質 0.8
- 元画像が2000px以下なら拡大しない
- この処理で1枚あたり 3〜5MB → 300〜500KB になる。
  縮小しないと3ページで上限に達するため、**この処理は必須**

#### PDFページ配置
```js
const doc = new jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
```
- A4は 210 × 297mm。上下左右に 10mm の余白を取る
- 画像のアスペクト比を保ったまま、余白内に収まる最大サイズで中央に配置する
- 画像が横長なら、そのページだけ `orientation: "landscape"` で追加する
- 2ページ目以降は `doc.addPage()`

#### 処理の重さ
1ページあたり数百msかかる。同期的に回すとUIが固まるので、
1ページ処理するごとに `await new Promise(r => setTimeout(r, 0))` を挟んで
進捗表示を更新する。Web Worker までは不要。

#### ファイル名
クライアント側では `{名前}.pdf`（既定は `答案.pdf`）とし、
日付と生徒名の付与はサーバー側の命名規則（§5）に任せる。

### 8.2 base64化
```js
const buf = await file.arrayBuffer();
// 大きいファイルで String.fromCharCode(...new Uint8Array(buf)) は
// 引数の数が多すぎてスタックオーバーフローする。必ずチャンク分割する
```
8KB程度ずつ分割して連結し、最後に `btoa()` にかけること。

### 8.3 fetch
```js
await fetch(GAS_URL, {
  method: "POST",
  headers: { "Content-Type": "text/plain;charset=utf-8" },
  body: JSON.stringify(payload),
  redirect: "follow"
});
```
GAS Web App は 302 を返して別ドメインに転送するため、`redirect: "follow"` が必須。

### 8.4 設定値
`GAS_URL` は `config.js` に切り出し、`app.js` から読む。
公開リポジトリに含まれることになるが、URLだけでは何もできない設計（トークン必須）なので許容する。

---

## 9. GAS 側の設定

### Script Properties に保存する値
| キー | 内容 |
|---|---|
| `SPREADSHEET_ID` | スプレッドシートのID |
| `ROOT_FOLDER_ID` | 提出物ルートフォルダのID |
| `NOTIFY_EMAIL` | 異常時の通知先 |

ソースコードにIDを直書きしないこと。

### デプロイ設定
- 種類: ウェブアプリ
- 次のユーザーとして実行: **自分**
- アクセスできるユーザー: **全員**

この2つを間違えると動かない、または情報漏洩する。

### タイムゾーン
`appsscript.json` に `"timeZone": "Asia/Tokyo"` を設定する。

### 制限
- 1回の実行は6分以内
- 1日あたりのDrive作成数などに割当上限がある（20人規模なら問題にならない）

---

## 10. セキュリティ要件（必須）

1. トークンは平文でシートに保存しない
2. 生徒フォルダをDriveで共有しない
3. `mimeType` と拡張子は必ずサーバー側で検証する（クライアント側の `accept` は飾り）
4. `student_id` はリクエストボディから受け取らない。**必ずトークンから逆引きする**
   （受け取ると他人の提出物を覗けるようになる）
5. シートへの書き込みは `LockService` で排他する
6. エラーの詳細（スタックトレース等）をレスポンスに含めない
7. 答案には生徒の氏名や学校名が写り込む。テスト時もダミーPDFを使い、実データを扱わない

---

## 11. 実装フェーズ

段階ごとに動作確認してから次へ進むこと。

**フェーズ1: 疎通**
- スプレッドシート3シートを作成
- GAS で `doPost` を実装し、`login` のみ対応
- 手動でシートに生徒1名とトークンハッシュを登録
- `curl` でレスポンスを確認

**フェーズ2: アップロード**
- `upload` を実装し、Driveに保存されることを確認
- バリデーション（サイズ、MIME、拡張子）を実装
- 小さいPDFと20MB超のPDFの両方でテスト

**フェーズ3: メッセージ**
- `getMessages` / `sendMessage` を実装
- 講師が手でシートに行を追加し、生徒側に反映されることを確認

**フェーズ4: フロント**
- ログイン画面 → やりとり画面 → 提出画面 の順に実装
- 提出画面は「ファイルを選ぶ」だけを先に通し、動いてからカメラ経路を足す

**フェーズ4.5: カメラ撮影とPDF変換**
- 画像1枚 → 縮小 → PDF化 → アップロード を通す
- 複数ページ、並べ替え、削除を実装
- 実機で必ず確認する項目
  - iPhone: 縦構えで撮った答案が正しい向きでPDFになるか
  - iPhone: カメラロールのHEIC画像を選んだとき
  - Android: カメラ起動と戻りの挙動
  - 5ページ撮ったときの処理時間と最終サイズ
  - 処理中に画面を消灯・復帰させたときの挙動

**フェーズ5: 仕上げ**
- PWA対応、エラー表示、レート制限
- 生徒1人で1週間試験運用してから本番投入

---

## 12. 将来の拡張（v2以降）

- 添削済みファイルの返却（`returns` シートとDriveの返却フォルダを追加）
- 講師用の管理画面（同じGAS Web Appに `role: tutor` を追加）
- 生徒数が増えたら Supabase への移行を検討する。
  その際もAPIの形（`action` ベースのPOST）を保てば、フロントの改修は最小で済む
- メール通知（`MailApp.sendEmail` で提出時に講師へ通知）

---

## 付録: 参考実装の骨格

```js
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const handlers = {
      login: handleLogin,
      getMessages: handleGetMessages,
      sendMessage: handleSendMessage,
      upload: handleUpload,
      getSubmissions: handleGetSubmissions
    };
    const handler = handlers[req.action];
    if (!handler) return json({ ok: false, error: { code: "VALIDATION_ERROR", message: "不正なリクエストです" } });
    return json(handler(req));
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "エラーが発生しました" } });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

`login` 以外のハンドラは、冒頭で必ず `const student = authenticate(req.token);` を呼び、
以降は `student.studentId` / `student.folderId` のみを使うこと。

---

## 13. v2: 講師アプリと添削の閲覧

v1 の「やらないこと」のうち、講師用画面と添削済みファイルの閲覧を実装する。
講師端末へのプッシュ通知は §13.6。

### 13.1 添削の流れ（返却アップロードはしない）
1. 生徒が提出 → 生徒フォルダに PDF が保存される（v1 のまま）
2. 講師は iPad の PDF ビューアで Drive 上の同じファイルを開き、書き込んで**上書き保存**する
3. 生徒アプリで提出履歴を開くと、Drive にある最新の状態（書き込み入り）を表示する

- Drive の共有設定は v1 と同じく非公開のまま。ファイル本体は GAS 経由で本人にだけ渡す
- 提出時刻より2分以上後に Drive 側で更新されていれば「先生が書き込みました」と表示する

### 13.2 講師の認証
合言葉ではなく講師本人の Google アカウントで認証する。講師トークンが漏れると全生徒のデータが見えるため。

1. 講師アプリが Google の OAuth 画面へリダイレクトする（`response_type=id_token`, `scope=openid email`, `nonce` 付き）
2. 戻ってきた ID トークンと nonce を `tutorLogin` に送る
3. GAS は `https://oauth2.googleapis.com/tokeninfo` で検証し、次をすべて満たすときだけ成功とする
   - `aud` が Script Properties の `GOOGLE_CLIENT_ID` と一致
   - `email` が `TUTOR_EMAIL` と一致し、`email_verified` が true
   - `exp` が未来、`nonce` がリクエストの値と一致
4. 成功したら 32 文字の講師セッショントークンを発行する。有効期限 30 日。
   Script Properties に**ハッシュのみ**保存する（キー `tutor_session_{hash}`、値は失効時刻）
5. 以降の講師 API はリクエストの `tutorToken` で認証する。生徒の `token` とは別フィールドにし、取り違えを防ぐ

照合失敗は生徒ログインと同じ失敗カウンタに加算する（§3 の全体ロック対象）。

### 13.3 データの変更
`messages` シートに列を追加する。

| 列 | 名前 | 型 | 説明 |
|---|---|---|---|
| G | read_by_tutor | boolean | 講師が既読にしたか。空欄は既読扱い（v1 の既存行のため） |

Script Properties に追加する値:

| キー | 内容 |
|---|---|
| `TUTOR_EMAIL` | 講師の Google アカウントのメールアドレス |
| `GOOGLE_CLIENT_ID` | OAuth クライアント ID（ウェブアプリ） |

### 13.4 API 追加

**生徒向け**
- `getSubmissions` のレスポンス各要素に `annotated`（boolean）と `available`（Drive にファイルがあるか）を追加
- `getSubmissionFile` `{ token, submissionId }` → `{ fileName, mimeType, dataBase64, updatedAt }`
  - 提出の `student_id` がトークンの生徒と一致しない場合は `VALIDATION_ERROR`（存在を明かさない）
  - 30MB を超えるファイルは `FILE_TOO_LARGE`

**講師向け**（すべて `tutorToken` 必須）
- `tutorLogin` `{ idToken, nonce }` → `{ tutorToken, email, expiresAt }`
- `tutorLogout` `{ tutorToken }`
- `tutorListStudents` → `{ students: [{ studentId, name, unreadCount, lastActivityAt, lastMessage }] }`（`lastActivityAt` の新しい順）
- `tutorGetThread` `{ studentId }` → `{ student, messages, submissions }`
  - `messages` は直近 200 件、`submissions` は新しい順で `annotated` を含む
  - 取得時にその生徒からのメッセージを講師既読にする
- `tutorSendMessage` `{ studentId, body }` → `{ id, createdAt }`（1000 文字以内）

### 13.5 講師アプリの画面
- 配置: `docs/tutor/`（公開 URL は `/study-portal/tutor/`）。生徒アプリとは別の PWA としてホーム画面に追加する
- 幅 768px 以上（iPad）は左に生徒一覧、右に選択中の生徒の画面を並べる。スマホは一覧 → 詳細の画面遷移
- 生徒の画面は「やりとり」「提出物」の切り替え
  - やりとり: 生徒アプリと同じ吹き出し表示と返信欄
  - 提出物: ファイル名・日時・コメント・「✏️ 書き込み済み」表示。ファイルは講師が PDF ビューアアプリから Drive を直接開くので、アプリ内にリンクは置かない
- 30 秒ごとにポーリング（非表示中は停止）

### 13.6 プッシュ通知（講師のみ）
生徒から提出・メッセージが届いたら、講師の端末に通知する。Firebase Cloud Messaging（FCM、無料枠）を使う。

**端末の登録**
1. 講師アプリの「通知」パネルで「この端末で通知を受け取る」を押す（通知の許可はユーザー操作が必要なため）
2. Service Worker（`docs/tutor/sw.js`）を登録し、Firebase SDK で FCM トークンを取得する
3. `tutorRegisterPush` で GAS に送る。GAS は Script Properties に `push_token_{hash}` として保存する
4. 講師アプリを開くたびにトークンを取り直し、変わっていれば登録し直す（FCM トークンは更新されることがあるため）

- iOS / iPadOS は 16.4 以降、ホーム画面に追加した講師アプリでのみ受信できる。Safari のタブで開いている場合は案内を表示する

**送信**
- 生徒の `sendMessage` と `upload` が成功した後に、GAS から FCM HTTP v1 API で登録済みの全端末へ送る
- 認証は講師本人の OAuth トークン（`ScriptApp.getOAuthToken()`、スコープ `firebase.messaging`）。Web App は講師本人として実行されるため使える
  - 新しい Cloud プロジェクトではサービスアカウント鍵の作成が組織ポリシーで禁止されており、鍵を保管するリスクも無くせるため、鍵は使わない
  - 前提: Apps Script プロジェクトを Firebase と同じ Cloud プロジェクトに紐付ける。OAuth 同意画面は「本番環境」にする（「テスト」のままだと承認が7日で切れ、生徒側も含めて Web App が止まる）
- 送信先プロジェクトは Script Properties の `FIREBASE_PROJECT_ID`
- **データメッセージ**として送り、表示は Service Worker が必ず行う。iOS は通知を表示しないプッシュが続くと購読を打ち切るため
- 本文は100文字で切る。ロック画面に出るため
- FCM が 404 / `UNREGISTERED` を返したトークンは削除する
- 送信の失敗で生徒側の処理を失敗させない（例外はログに残して握りつぶす）
- 通知をタップしたら講師アプリをその生徒の画面で開く（`?student={studentId}`）

**通知の内容**
| きっかけ | タイトル | 本文 |
|---|---|---|
| メッセージ | `{name}さん` | メッセージ本文 |
| 提出 | `{name}さんが提出しました` | ファイル名（ページ数） |

**API 追加**（すべて `tutorToken` 必須）
- `tutorRegisterPush` `{ fcmToken, label }`（`label` は端末の見分け用、40文字以内）
- `tutorUnregisterPush` `{ fcmToken }`
- `tutorTestPush` → 登録済み端末にテスト通知を送り `{ sent, failed }` を返す

**config.js に追加する公開値**: `FIREBASE_CONFIG`（Firebase のウェブアプリ設定）、`FIREBASE_VAPID_KEY`（Web Push 証明書の公開鍵）

### 13.7 生徒アプリの提出物ビューア
- 提出履歴の各行をタップで開く。pdf.js（cdnjs、3.11.174）でページを縦に並べて表示する
  - iOS のホーム画面アプリでは Blob URL の PDF を直接開けないため、アプリ内で描画する
- 「保存・共有」ボタンで Web Share API に渡す（非対応端末はダウンロード）
