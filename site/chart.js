// Hand-rolled SVG line chart. No dependencies. The SVG scales to its container
// via viewBox, so it reads well down to ~340px wide.
//
// points:   [{ ts, avg, min?, max? }] sorted by ts — the actual history line
//           (raw samples, or per-bucket averages). With `band`, min/max shade an
//           envelope behind it.
// baseline: optional [{ ts, p25, p50, p75 }] aligned to the same x — the
//           "typical" range for each point's (day, hour), shaded grey with a
//           dashed median, so the actual line reads against what's normal.

const SVG_NS = "http://www.w3.org/2000/svg";

const VIEW_W = 360;
const VIEW_H = 190;
const PAD = { top: 12, right: 10, bottom: 26, left: 34 };

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Break the line where consecutive samples are farther apart than this multiple
// of the expected step, so a stalled feed shows an honest gap, not a lie.
const GAP_FACTOR = 2.5;

export function renderChart(points, { band = false, baseline = null, stepSeconds, xFormat } = {}) {
  const svg = el("svg", {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    class: "chart",
    role: "img",
    preserveAspectRatio: "xMidYMid meet",
  });

  if (!points || points.length === 0) {
    const t = el("text", { x: VIEW_W / 2, y: VIEW_H / 2, class: "chart-empty" });
    t.textContent = "No data for this range yet";
    svg.append(t);
    return svg;
  }

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const tSpan = Math.max(1, t1 - t0);

  const values = [];
  for (const p of points) {
    values.push(p.avg);
    if (band && p.min != null) values.push(p.min);
    if (band && p.max != null) values.push(p.max);
  }
  if (baseline) for (const b of baseline) values.push(b.p25, b.p75);
  const yMax = Math.max(10, Math.ceil(Math.max(...values) / 10) * 10);

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const x = (ts) => PAD.left + ((ts - t0) / tSpan) * plotW;
  const y = (v) => PAD.top + (1 - v / yMax) * plotH;

  // y gridlines + labels at 0, mid, max.
  for (const v of [0, yMax / 2, yMax]) {
    const gy = y(v);
    svg.append(el("line", { x1: PAD.left, y1: gy, x2: VIEW_W - PAD.right, y2: gy, class: "chart-grid" }));
    const label = el("text", { x: PAD.left - 5, y: gy + 3, class: "chart-ylabel" });
    label.textContent = String(Math.round(v));
    svg.append(label);
  }

  // x labels: a few evenly spaced ticks.
  const ticks = Math.min(4, points.length);
  for (let i = 0; i < ticks; i++) {
    const ts = t0 + (tSpan * i) / Math.max(1, ticks - 1);
    const tx = x(ts);
    const label = el("text", { x: tx, y: VIEW_H - 8, class: "chart-xlabel" });
    label.textContent = xFormat ? xFormat(ts) : "";
    svg.append(label);
  }

  // Typical-range overlay, drawn first so the actual history sits on top of it.
  if (baseline && baseline.length > 1) {
    const top = baseline.map((b) => `${x(b.ts)},${y(b.p75)}`);
    const bottom = baseline.slice().reverse().map((b) => `${x(b.ts)},${y(b.p25)}`);
    svg.append(el("polygon", { points: [...top, ...bottom].join(" "), class: "chart-typical-band" }));
    const median = baseline.map((b, i) => `${i === 0 ? "M" : "L"}${x(b.ts)} ${y(b.p50)}`).join(" ");
    svg.append(el("path", { d: median, class: "chart-typical-median", fill: "none" }));
  }

  // Split the actual line into contiguous segments so gaps break it.
  const maxGap = stepSeconds ? stepSeconds * GAP_FACTOR : Infinity;
  const segments = [];
  let segment = [];
  for (const p of points) {
    if (segment.length && p.ts - segment[segment.length - 1].ts > maxGap) {
      segments.push(segment);
      segment = [];
    }
    segment.push(p);
  }
  if (segment.length) segments.push(segment);

  for (const seg of segments) {
    if (band && seg.some((p) => p.min != null && p.max != null)) {
      const top = seg.map((p) => `${x(p.ts)},${y(p.max)}`);
      const bottom = seg.slice().reverse().map((p) => `${x(p.ts)},${y(p.min)}`);
      svg.append(el("polygon", { points: [...top, ...bottom].join(" "), class: "chart-band" }));
    }
    // A lone sample (sparse or early data, or an island after a stall) has no
    // line to draw, so mark it with a dot; otherwise draw the connecting line.
    if (seg.length === 1) {
      const p = seg[0];
      svg.append(el("circle", { cx: x(p.ts), cy: y(p.avg), r: 2, class: "chart-dot" }));
      continue;
    }
    const line = seg.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts)} ${y(p.avg)}`).join(" ");
    svg.append(el("path", { d: line, class: "chart-line", fill: "none" }));
  }

  return svg;
}
