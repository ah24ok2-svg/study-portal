// 背景の ○ × △ □ と鉛筆・消しゴム。画面サイズに合わせて敷き詰めるので、固定画像のように PC で間延びしない
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const COLORS = ["#ff6b6b", "#ffb938", "#4dabf7", "#40c057", "#9775fa", "#f783ac"];
  // 文房具は主役にしないよう、記号より出にくくする（重みの比）
  const SHAPES = [
    { type: "circle", weight: 1 }, { type: "cross", weight: 1 }, { type: "triangle", weight: 1 },
    { type: "square", weight: 1 }, { type: "pencil", weight: 0.45 }, { type: "eraser", weight: 0.35 }
  ];
  const TOTAL_WEIGHT = SHAPES.reduce(function (sum, x) { return sum + x.weight; }, 0);

  function pickShape(value) {
    let acc = 0;
    for (let i = 0; i < SHAPES.length; i++) {
      acc += SHAPES[i].weight / TOTAL_WEIGHT;
      if (value < acc) return i;
    }
    return SHAPES.length - 1;
  }
  const CELL = 96;       // 図形1つあたりの区画(px)。小さくすると密になる
  const FILL_RATE = 0.7; // 区画に図形を置く確率。規則的な格子に見えないよう間引く

  // 再描画のたびに配置が大きく変わると落ち着かないので、固定シードの乱数を使う
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function drawShape(type, r) {
    switch (type) {
      case "circle":
        return el("circle", { cx: 0, cy: 0, r: r * 0.85 });
      case "cross": {
        const g = el("g", {});
        g.append(
          el("line", { x1: -r * 0.75, y1: -r * 0.75, x2: r * 0.75, y2: r * 0.75 }),
          el("line", { x1: r * 0.75, y1: -r * 0.75, x2: -r * 0.75, y2: r * 0.75 })
        );
        return g;
      }
      case "triangle": {
        const h = r * 0.95;
        return el("polygon", { points: [0, -h, h * 0.95, h * 0.7, -h * 0.95, h * 0.7].join(" ") });
      }
      case "pencil": {
        // 細長いので、他の図形と見た目の大きさを揃えるため少し大きめに描く
        const L = r * 1.5;
        const t = L * 0.2;       // 軸の太さの半分
        const tipStart = L * 0.25;
        const g = el("g", {});
        g.append(
          el("rect", { x: -L, y: -t, width: L + tipStart, height: t * 2, rx: t * 0.5 }),
          // 削った木の部分と芯
          el("polygon", { points: [tipStart, -t, L, 0, tipStart, t].join(" ") }),
          el("line", { x1: L * 0.72, y1: -t * 0.37, x2: L * 0.72, y2: t * 0.37 }),
          // お尻の消しゴムとの境目
          el("line", { x1: -L * 0.62, y1: -t, x2: -L * 0.62, y2: t })
        );
        return g;
      }
      case "eraser": {
        const w = r * 1.05;
        const hgt = r * 0.62;
        const g = el("g", {});
        g.append(
          el("rect", { x: -w, y: -hgt, width: w * 2, height: hgt * 2, rx: r * 0.22 }),
          // 紙のスリーブの端
          el("line", { x1: -w * 0.2, y1: -hgt, x2: -w * 0.2, y2: hgt })
        );
        return g;
      }
      default:
        return el("rect", { x: -r * 0.75, y: -r * 0.75, width: r * 1.5, height: r * 1.5, rx: r * 0.15 });
    }
  }

  function render(svg) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rand = mulberry32(20260913);
    const cols = Math.ceil(w / CELL) + 1;
    const rows = Math.ceil(h / CELL) + 1;
    const offsetX = (w - cols * CELL) / 2;
    const offsetY = (h - rows * CELL) / 2;

    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.replaceChildren();

    let prevColor = null;
    let prevShape = null;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // 乱数の消費順を固定するため、置かない区画でも先に全部引いておく
        const place = rand();
        const jx = rand(), jy = rand(), size = rand(), rot = rand(), c = rand(), s = rand(), delay = rand(), dur = rand();
        if (place > FILL_RATE) continue;

        // 隣り合う図形が同じ色・同じ形にならないようにずらす
        let color = COLORS[Math.floor(c * COLORS.length)];
        if (color === prevColor) color = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length];
        let shapeIndex = pickShape(s);
        if (SHAPES[shapeIndex].type === prevShape) shapeIndex = (shapeIndex + 1) % 4; // 記号のどれかに逃がす
        const shape = SHAPES[shapeIndex].type;
        prevColor = color;
        prevShape = shape;

        const r = 9 + size * 9;
        const x = offsetX + col * CELL + CELL * (0.2 + jx * 0.6);
        const y = offsetY + row * CELL + CELL * (0.2 + jy * 0.6);

        const outer = el("g", { transform: "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ") rotate(" + Math.round(rot * 360) + ")" });
        const floating = el("g", { class: "decor-float", stroke: color });
        floating.style.animationDelay = (-delay * 8).toFixed(2) + "s";
        floating.style.animationDuration = (6 + dur * 5).toFixed(2) + "s";
        // 文房具は線が込み入っているので、記号と同じ太さだと潰れる
        if (shape === "pencil" || shape === "eraser") floating.setAttribute("stroke-width", "3");
        floating.appendChild(drawShape(shape, r));
        outer.appendChild(floating);
        svg.appendChild(outer);
      }
    }
  }

  const svg = el("svg", { class: "decor", "aria-hidden": "true", focusable: "false" });
  document.body.prepend(svg);
  render(svg);

  let timer = null;
  window.addEventListener("resize", function () {
    clearTimeout(timer);
    timer = setTimeout(function () { render(svg); }, 150);
  });
})();
