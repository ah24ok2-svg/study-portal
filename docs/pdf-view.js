/**
 * PDF をページごとの画像にしてアプリ内に並べる。生徒アプリ（提出物ビューア）と講師アプリ（提出物のプレビュー）で共有する。
 * iOS のホーム画面アプリでは PDF の Blob URL を開けないため、ブラウザの PDF 表示に頼らず pdf.js で描画する
 */
(function (root) {
  "use strict";

  const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  let pdfjsPromise = null;

  /** 開かない人には不要なので、初めて表示するときにだけ読み込む */
  function load() {
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise(function (resolve, reject) {
        const script = document.createElement("script");
        script.src = PDFJS_BASE + "pdf.min.js";
        script.onload = function () {
          root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.js";
          resolve(root.pdfjsLib);
        };
        script.onerror = function () {
          // 電波が戻ったら次に開いたときに読み直せるよう、失敗は覚えておかない
          pdfjsPromise = null;
          reject(new Error("pdf.js を読み込めませんでした"));
        };
        document.head.appendChild(script);
      });
    }
    return pdfjsPromise;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob failed"));
      }, type, quality);
    });
  }

  function nextTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /**
   * bytes（Uint8Array）の PDF を container に1ページずつ img で追加する。
   * isCancelled() が true になったら途中でやめる（読み込み中にビューアを閉じた・別のファイルを開いた）。
   * onProgress(i, total) でページ数の進み具合を知らせる
   */
  async function render(bytes, container, options) {
    const isCancelled = (options && options.isCancelled) || function () { return false; };
    const onProgress = (options && options.onProgress) || function () {};
    const pdfjsLib = await load();
    // pdf.js は渡した配列を worker に移して空にするので、呼び出し側が持っている配列とは別のコピーを渡す
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    try {
      const cssWidth = Math.min(container.clientWidth || window.innerWidth, 900);
      // iOS は canvas の面積に上限があるので、高精細ディスプレイでも2倍までに抑える
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 1; i <= doc.numPages; i++) {
        if (isCancelled()) return;
        onProgress(i, doc.numPages);
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth * dpr) / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
        canvas.width = canvas.height = 0;
        if (isCancelled()) return;

        const img = document.createElement("img");
        img.className = "viewer-page";
        img.alt = i + "ページ目";
        img.src = URL.createObjectURL(blob);
        container.appendChild(img);
        await nextTick();
      }
    } finally {
      doc.destroy();
    }
  }

  /** 表示した画像の Blob URL を解放して空にする */
  function clear(container) {
    container.querySelectorAll("img").forEach(function (img) {
      if (img.src.indexOf("blob:") === 0) URL.revokeObjectURL(img.src);
    });
    container.replaceChildren();
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  root.PdfView = { load: load, render: render, clear: clear, base64ToBytes: base64ToBytes };
})(self);
