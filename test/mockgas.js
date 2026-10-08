/**
 * GAS のコード（gas/*.js）を Node でそのまま動かすためのモック。
 * Sheets・Drive・Cache などの Google のサービスをメモリ上の偽物に差し替える。
 *
 *   node test/run.js            テストをすべて実行
 *   node test/mockgas.js 8765   docs/ を配信し、/exec で GAS を受ける開発用サーバー
 *
 * 実データは使わない。生徒名はすべて「テスト生徒」
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto"), http = require("http");
const ROOT = path.join(__dirname, "..");
const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));

function createMock() {
  function makeSheet(name) {
    const data = [];
    const sheet = {
      name, data,
      getDataRange: () => ({ getValues: () => (data.length ? data.map((r) => r.slice()) : [[]]) }),
      appendRow: (row) => { data.push(row.slice()); return sheet; },
      deleteRow: (r) => { data.splice(r - 1, 1); },
      getRange: (r, c, nr = 1, nc = 1) => typeof r === "string" ? { setNumberFormat() {} } : ({
        getValue: () => (data[r - 1] || [])[c - 1] ?? "",
        setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? "")),
        setValues: (vals) => { vals.forEach((row, i) => { while (data.length < r + i) data.push([]); row.forEach((v, j) => (data[r - 1 + i][c - 1 + j] = v)); }); return { setFontWeight() {} }; },
      }),
      setFrozenRows() {},
    };
    return sheet;
  }
  const sheets = {};
  const spreadsheet = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };

  const folders = {};
  const files = {};
  let idSeq = 0;
  let CtxDate = Date;
  function makeFile(folderId, blob) {
    const id = "file" + ++idSeq;
    const f = { id, name: blob.name, bytes: blob.bytes, mime: blob.mime, updatedAt: Date.now(), trashed: false, folder: folderId };
    const api = {
      getId: () => f.id, getName: () => f.name, getSize: () => f.bytes.length, isTrashed: () => f.trashed,
      setTrashed: (v) => { f.trashed = !!v; return api; },
      getLastUpdated: () => new CtxDate(f.updatedAt),
      getBlob: () => ({ getBytes: () => f.bytes, getContentType: () => f.mime }),
    };
    files[id] = { f, api };
    return api;
  }
  function makeFolder(name, parentId) {
    const id = "folder" + ++idSeq;
    const folder = { id, name, parentId };
    const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
    const api = {
      getId: () => id, getName: () => name, isTrashed: () => false,
      createFolder: (n) => makeFolder(n, id),
      createFile: (blob) => makeFile(id, blob),
      getFilesByName: (n) => iter(Object.values(files).filter((x) => x.f.folder === id && x.f.name === n).map((x) => x.api)),
      getFiles: () => iter(Object.values(files).filter((x) => x.f.folder === id).map((x) => x.api)),
      getFoldersByName: (n) => iter(Object.values(folders).filter((x) => x.folder.parentId === id && x.folder.name === n).map((x) => x.api)),
    };
    folders[id] = { folder, api };
    return api;
  }
  const root = makeFolder("家庭教師_提出物", null);
  const TUTOR_EMAIL = "tutor@example.com";
  const CLIENT_ID = "mock-client.apps.googleusercontent.com";
  const props = { SPREADSHEET_ID: "sheet1", ROOT_FOLDER_ID: root.getId(), NOTIFY_EMAIL: TUTOR_EMAIL, TUTOR_EMAIL, GOOGLE_CLIENT_ID: CLIENT_ID, FIREBASE_PROJECT_ID: "mock-project" };
  const cache = new Map();
  const mails = [];
  const fetchLog = [];
  const fcmBehavior = { byToken: {} };

  // ID トークンは "mock|<email>|<nonce>|<aud>" の形で、tokeninfo の応答を再現する
  function tokenInfo(idToken) {
    const [prefix, email, nonce, aud] = decodeURIComponent(idToken).split("|");
    if (prefix !== "mock") return { code: 400, body: '{"error":"invalid_token"}' };
    return { code: 200, body: JSON.stringify({ aud: aud || CLIENT_ID, email, email_verified: "true", exp: String(Math.floor(Date.now() / 1000) + 3600), nonce }) };
  }

  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    SpreadsheetApp: { openById: () => spreadsheet },
    DriveApp: {
      getFolderById: (id) => { if (!folders[id]) throw new Error("no folder"); return folders[id].api; },
      getFileById: (id) => { if (!files[id]) throw new Error("no file"); return files[id].api; },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = cache.get(k); return e && e.exp > Date.now() ? e.v : null; },
      put: (k, v, sec) => cache.set(k, { v, exp: Date.now() + sec * 1000 }) }) },
    MailApp: { sendEmail: (...a) => mails.push(a) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetchLog.push({ url, opts });
        if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
          const t = tokenInfo(new URL(url).searchParams.get("id_token"));
          return { getResponseCode: () => t.code, getContentText: () => t.body };
        }
        throw new Error("unexpected fetch " + url);
      },
      fetchAll: (reqs) => reqs.map((r) => {
        fetchLog.push({ url: r.url, opts: r });
        const token = JSON.parse(r.payload).message.token;
        const b = fcmBehavior.byToken[token] || { code: 200, body: '{"name":"projects/x/messages/1"}' };
        return { getResponseCode: () => b.code, getContentText: () => b.body };
      }),
    },
    ScriptApp: { getOAuthToken: () => "ya29.owner-mock" },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeDigest: (alg, v) => toSigned(crypto.createHash("sha256").update(typeof v === "string" ? Buffer.from(v, "utf8") : toBuf(v)).digest()),
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => toSigned(Buffer.from(s, "base64")),
      base64Encode: (arr) => toBuf(arr).toString("base64"),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      formatDate: (d, tz, fmt) => { const base = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d); return fmt === "yyyy-MM-dd" ? base : base.replace(/-/g, ""); },
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }) },
  };
  vm.createContext(ctx);
  const names = fs.readdirSync(path.join(ROOT, "gas")).filter((f) => f.endsWith(".js")).sort();
  const src = names.map((f) => fs.readFileSync(path.join(ROOT, "gas", f), "utf8")).join("\n");
  vm.runInContext(src + "\nthis.__exports = { doPost, setup, generateToken, addTutorReply, reissueToken };", ctx);
  CtxDate = vm.runInContext("Date", ctx);
  const gas = ctx.__exports;
  gas.setup();

  const call = (obj) => JSON.parse(gas.doPost({ postData: { contents: typeof obj === "string" ? obj : JSON.stringify(obj) } }).content);
  /** サーバーの時計を N 日進める（朝6時の組み替えの確認用） */
  const shiftDays = (n) => vm.runInContext("(function(){ var real = Date.now.__real || Date.now; var f = function(){ return real() + " + n + " * 86400000; }; f.__real = real; Date.now = f; })()", ctx);
  const tutorLogin = () => {
    const nonce = "n".repeat(20);
    return call({ action: "tutorLogin", idToken: ["mock", TUTOR_EMAIL, nonce, CLIENT_ID].join("|"), nonce }).data.tutorToken;
  };
  return { gas, sheets, folders, files, root, mails, cache, props, call, shiftDays, tutorLogin, fetchLog, fcmBehavior, CtxDate, TUTOR_EMAIL, CLIENT_ID };
}

module.exports = { createMock };

if (require.main === module) {
  const m = createMock();
  const port = Number(process.argv[2] || 8765);
  const s = m.gas.generateToken("テスト生徒A", "test-a");
  m.gas.generateToken("テスト生徒B", "test-b");
  m.gas.addTutorReply(s.studentId, "こんにちは。答案ができたら「提出」タブから送ってください。");
  console.log("student token:", s.token, " studentId:", s.studentId);
  const results = new Map();
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
  http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/exec") {
      const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
        const out = m.gas.doPost({ postData: { contents: Buffer.concat(chunks).toString("utf8") } }).content;
        const id = crypto.randomUUID(); results.set(id, out);
        // 本物の GAS と同じく 302 で転送する。SLOW_MS で応答の遅さも再現できる
        setTimeout(() => { res.writeHead(302, { Location: "/echo/" + id, "Access-Control-Allow-Origin": "*" }); res.end(); }, Number(process.env.SLOW_MS || 0));
      });
      return;
    }
    if (url.pathname.startsWith("/echo/")) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(results.get(url.pathname.slice(6)) || "{}");
    }
    if (url.pathname === "/mock-google-auth") {
      const idToken = ["mock", m.TUTOR_EMAIL, url.searchParams.get("nonce"), url.searchParams.get("client_id")].join("|");
      res.writeHead(302, { Location: url.searchParams.get("redirect_uri") + "#id_token=" + encodeURIComponent(idToken) + "&state=" + encodeURIComponent(url.searchParams.get("state")) });
      return res.end();
    }
    if (url.pathname === "/__shift") { m.shiftDays(Number(url.searchParams.get("days") || 0)); res.writeHead(200); return res.end("ok"); }
    if (url.pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(`window.APP_CONFIG = { GAS_URL: "http://localhost:${port}/exec", GOOGLE_CLIENT_ID: "${m.CLIENT_ID}", GOOGLE_AUTH_URL: "http://localhost:${port}/mock-google-auth", FIREBASE_CONFIG: null, FIREBASE_VAPID_KEY: "" };`);
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
    const file = path.join(ROOT, "docs", rel);
    if (!file.startsWith(path.join(ROOT, "docs")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log("mock listening on http://localhost:" + port));
}
