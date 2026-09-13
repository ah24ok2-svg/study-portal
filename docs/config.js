// 公開前提の値だけを置く（CLAUDE.md 参照）
window.APP_CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbz2XJ2qKUNCDrM9LchHxyvXEh7TtLRmnzXjUeUsns0oVx4nRqZgr51jO9D6uZulDC15/exec",
  // 講師アプリの Google ログイン用 OAuth クライアント ID（spec §13.2）
  GOOGLE_CLIENT_ID: "382292852074-536t3si5u23kh1voarfp8p33tna2vka9.apps.googleusercontent.com",
  // 講師端末へのプッシュ通知（spec §13.6）。Firebase コンソールの「ウェブアプリ」の設定値
  FIREBASE_CONFIG: null,
  // Firebase コンソール → Cloud Messaging → Web Push 証明書の公開鍵
  FIREBASE_VAPID_KEY: ""
};
