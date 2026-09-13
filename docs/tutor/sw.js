// 講師アプリの Service Worker。プッシュ通知の表示だけを担当し、オフライン用のキャッシュはしない（spec §7.4）

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

/**
 * FCM のデータメッセージを受けて必ず通知を出す。
 * Firebase SDK の onBackgroundMessage はアプリを開いている間は呼ばれず、
 * iOS は通知を出さないプッシュが続くと購読を打ち切るので、SDK を使わず自前で処理する
 */
self.addEventListener("push", function (event) {
  let data = {};
  try {
    const payload = event.data ? event.data.json() : {};
    data = payload.data || payload;
  } catch (_) {
    // 読めないペイロードでも通知は出す
  }
  const studentId = data.studentId || "";
  const show = self.registration.showNotification(data.title || "Study Portal", {
    body: data.body || "",
    icon: "../icons/icon-192.png",
    // 同じ生徒からの連続した通知はまとめて、最新だけを残す
    tag: studentId ? "student-" + studentId : "study-portal",
    renotify: true,
    data: { studentId: studentId }
  });
  const refresh = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
    clients.forEach(function (client) { client.postMessage({ type: "push", studentId: studentId }); });
  });
  event.waitUntil(Promise.all([show, refresh]));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const studentId = (event.notification.data && event.notification.data.studentId) || "";
  const url = new URL(studentId ? "./?student=" + encodeURIComponent(studentId) : "./", self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      const existing = clients.find(function (c) { return c.url.indexOf(self.registration.scope) === 0; });
      if (existing) {
        existing.postMessage({ type: "open-student", studentId: studentId });
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
