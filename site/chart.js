// Hand-rolled SVG line chart. No dependencies. The SVG scales to its container
// via viewBox, so it reads well down to ~340px wide.
//
// renderChart(spec) draws a fixed time window (spec.domain) rather than fitting
// to the data, so the caller can pan and zoom the window freely: past data is
// the actual history line, future is a prediction (dashed, from the baseline),
// split by a "now" marker. It returns a controller the caller drives for the
// crosshair and pixel-to-time mapping (graph.js owns the pan/zoom gestures).
//
// spec:
//   actual:    [{ ts, avg, min?, max? }] the recorded history line; min/max shade
//              an envelope behind it when `band` is set.
//   predicted: [{ ts, avg, min, max }] the baseline forecast for future ts
//              (avg = median, min/max = the typical p25/p75 range).
//   baseline:  optional [{ ts, p25, p50, p75 }] the "typical for this day & time"
//              overlay for the actual line, shaded grey with a dashed median.
//   domain:    { t0, t1 } the visible time window (x-axis extent).
//   nowTs:     epoch of "now", drawn as a divider between actual and predicted.

const SVG_NS = "http://www.w3.org/2000/svg";

const VIEW_W = 360;
const VIEW_H = 190;
const PAD = { top: 12, right: 10, bottom: 26, left: 34 };

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Break a line where consecutive samples are farther apart than this multiple of
// the expected step, so a stalled feed (or a gap in the baseline) shows an honest
// gap, not a line drawn straight across missing time.
const GAP_FACTOR = 2.5;

function splitSegments(points, maxGap) {
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
  return segments;
}

// Index of the value closest to target. Ties resolve to the earlier index. The
// crosshair uses this to snap a pointer's x to the nearest sample's x.
export function nearestIndex(values, target) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < values.length; i++) {
    const dist = Math.abs(values[i] - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// A clip id per chart, so the plot's clipPath doesn't collide when more than one
// chart has lived in the DOM. A plain counter, since Date/random buy nothing here.
let clipSeq = 0;

export function renderChart(spec) {
  const {
    actual = [],
    predicted = [],
    baseline = null,
    domain = null,
    nowTs = null,
    band = false,
    stepSeconds,
    predictedStepSeconds = 3600,
    xFormat,
    pointFormat,
  } = spec;

  const svg = el("svg", {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    class: "chart",
    role: "img",
    preserveAspectRatio: "xMidYMid meet",
  });

  const noop = () => {};
  if (!actual.length && !predicted.length) {
    const t = el("text", { x: VIEW_W / 2, y: VIEW_H / 2, class: "chart-empty" });
    t.textContent = "No data for this range yet";
    svg.append(t);
    return { svg, crosshairAtClientX: () => null, hideCrosshair: noop, tsAtClientX: () => null };
  }

  const first = actual[0] || predicted[0];
  const lastActual = actual[actual.length - 1];
  const lastPredicted = predicted[predicted.length - 1];
  const last = lastPredicted || lastActual;
  const t0 = domain ? domain.t0 : first.ts;
  const t1 = domain ? domain.t1 : last.ts;
  const tSpan = Math.max(1, t1 - t0);

  const values = [];
  for (const p of actual) {
    values.push(p.avg);
    if (band && p.min != null) values.push(p.min);
    if (band && p.max != null) values.push(p.max);
  }
  for (const p of predicted) values.push(p.avg, p.min, p.max);
  if (baseline) for (const b of baseline) values.push(b.p25, b.p75);

  // Fit the y-axis to the data's own range (padded, rounded to tens for clean
  // labels) instead of anchoring at 0, so a garage sitting far from empty fills
  // the plot vertically rather than hugging the top over a band of dead space.
  // Floored at 0 since vacancy can't go negative.
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(10, rawMax - rawMin) * 0.1;
  const yMin = Math.max(0, Math.floor((rawMin - pad) / 10) * 10);
  let yMax = Math.ceil((rawMax + pad) / 10) * 10;
  if (yMax - yMin < 10) yMax = yMin + 10;
  const ySpan = yMax - yMin;

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const x = (ts) => PAD.left + ((ts - t0) / tSpan) * plotW;
  const y = (v) => PAD.top + (1 - (v - yMin) / ySpan) * plotH;

  // Clip the panned content to the plot's horizontal bounds so a point just
  // outside the window (loaded as pan headroom) can't paint over the y-axis
  // labels. The clip runs full height down to the x-axis label band, so the
  // x-labels (which sit below the plot) and their pan translation stay visible.
  const clipId = `chart-clip-${++clipSeq}`;
  const defs = el("defs");
  const clip = el("clipPath", { id: clipId });
  clip.append(el("rect", { x: PAD.left, y: PAD.top, width: plotW, height: VIEW_H - PAD.top }));
  defs.append(clip);
  svg.append(defs);

  // y gridlines + labels at min, mid, max of the fitted range (outside the clip,
  // and static — a horizontal grid doesn't move when the window pans in x).
  for (const v of [yMin, (yMin + yMax) / 2, yMax]) {
    const gy = y(v);
    svg.append(el("line", { x1: PAD.left, y1: gy, x2: VIEW_W - PAD.right, y2: gy, class: "chart-grid" }));
    const label = el("text", { x: PAD.left - 5, y: gy + 3, class: "chart-ylabel" });
    label.textContent = String(Math.round(v));
    svg.append(label);
  }

  // Everything time-varying lives in the clipped content group, so a pan can
  // translate it as one unit.
  const content = el("g", { class: "chart-content", "clip-path": `url(#${clipId})` });
  svg.append(content);

  // x labels: a few evenly spaced ticks across the window.
  const ticks = 4;
  for (let i = 0; i < ticks; i++) {
    const ts = t0 + (tSpan * i) / (ticks - 1);
    const tx = x(ts);
    const anchor = i === 0 ? "start" : i === ticks - 1 ? "end" : "middle";
    const label = el("text", { x: tx, y: VIEW_H - 8, class: "chart-xlabel", "text-anchor": anchor });
    label.textContent = xFormat ? xFormat(ts) : "";
    content.append(label);
  }

  // Typical-range overlay, drawn first so the actual history sits on top of it.
  if (baseline && baseline.length > 1) {
    const top = baseline.map((b) => `${x(b.ts)},${y(b.p75)}`);
    const bottom = baseline.slice().reverse().map((b) => `${x(b.ts)},${y(b.p25)}`);
    content.append(el("polygon", { points: [...top, ...bottom].join(" "), class: "chart-typical-band" }));
    const median = baseline.map((b, i) => `${i === 0 ? "M" : "L"}${x(b.ts)} ${y(b.p50)}`).join(" ");
    content.append(el("path", { d: median, class: "chart-typical-median", fill: "none" }));
  }

  // The forecast: median line (dashed) with its typical p25–p75 band, for ts past
  // now. Gaps break where the baseline has no cell for that day-and-hour.
  for (const seg of splitSegments(predicted, predictedStepSeconds * GAP_FACTOR)) {
    if (seg.length > 1) {
      const top = seg.map((p) => `${x(p.ts)},${y(p.max)}`);
      const bottom = seg.slice().reverse().map((p) => `${x(p.ts)},${y(p.min)}`);
      content.append(el("polygon", { points: [...top, ...bottom].join(" "), class: "chart-predicted-band" }));
      const line = seg.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts)} ${y(p.avg)}`).join(" ");
      content.append(el("path", { d: line, class: "chart-predicted-line", fill: "none" }));
    } else if (seg.length === 1) {
      content.append(el("circle", { cx: x(seg[0].ts), cy: y(seg[0].avg), r: 2, class: "chart-predicted-dot" }));
    }
  }

  // The actual history line, split so a stalled feed shows an honest gap.
  const maxGap = stepSeconds ? stepSeconds * GAP_FACTOR : Infinity;
  for (const seg of splitSegments(actual, maxGap)) {
    if (band && seg.some((p) => p.min != null && p.max != null)) {
      const top = seg.map((p) => `${x(p.ts)},${y(p.max)}`);
      const bottom = seg.slice().reverse().map((p) => `${x(p.ts)},${y(p.min)}`);
      content.append(el("polygon", { points: [...top, ...bottom].join(" "), class: "chart-band" }));
    }
    // A lone sample (sparse or early data, or an island after a stall) has no
    // line to draw, so mark it with a dot; otherwise draw the connecting line.
    if (seg.length === 1) {
      content.append(el("circle", { cx: x(seg[0].ts), cy: y(seg[0].avg), r: 2, class: "chart-dot" }));
      continue;
    }
    const line = seg.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts)} ${y(p.avg)}`).join(" ");
    content.append(el("path", { d: line, class: "chart-line", fill: "none" }));
  }

  // The "now" divider between recorded past and predicted future.
  if (nowTs != null && nowTs >= t0 && nowTs <= t1) {
    const nx = x(nowTs);
    content.append(el("line", { x1: nx, y1: PAD.top, x2: nx, y2: PAD.top + plotH, class: "chart-now" }));
    const nowLabel = el("text", { x: nx, y: PAD.top + 8, class: "chart-now-label", "text-anchor": "middle" });
    nowLabel.textContent = "now";
    content.append(nowLabel);
  }

  const plot = { left: PAD.left, top: PAD.top, w: plotW, h: plotH };
  const controller = attachCrosshair(svg, { actual, predicted, x, y, plot, t0, tSpan, pointFormat });
  return { svg, content, plot, ...controller };
}

// Build the crosshair overlay and the pixel/time mapping, and return the methods
// graph.js calls to drive them (it owns the pan/zoom/tap gesture routing, so the
// pointer listeners live there, not here).
function attachCrosshair(svg, { actual, predicted, x, y, plot, t0, tSpan, pointFormat }) {
  const samples = [
    ...actual.map((p) => ({ ts: p.ts, avg: p.avg, predicted: false })),
    ...predicted.map((p) => ({ ts: p.ts, avg: p.avg, predicted: true })),
  ].sort((a, b) => a.ts - b.ts);
  const xs = samples.map((s) => x(s.ts));

  const layer = el("g", { class: "chart-crosshair" });
  const vline = el("line", { class: "chart-crosshair-line", y1: plot.top, y2: plot.top + plot.h });
  const dot = el("circle", { class: "chart-crosshair-dot", r: 3.5 });
  const box = el("rect", { class: "chart-crosshair-box", rx: 3 });
  const label = el("text", { class: "chart-crosshair-label" });
  layer.append(vline, dot, box, label);
  layer.style.display = "none";
  svg.append(layer);

  // A transparent surface over the plot so pointer gestures register anywhere in
  // it, not only on the thin painted line. It sits topmost (the crosshair layer
  // shows through it) and lets events bubble to the svg, where graph.js listens.
  svg.append(el("rect", { class: "chart-surface", x: plot.left, y: plot.top, width: plot.w, height: plot.h }));

  const toLocalX = (clientX) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = 0;
    return pt.matrixTransform(ctm.inverse()).x;
  };

  const tsAtClientX = (clientX) => {
    const localX = toLocalX(clientX);
    if (localX == null) return null;
    return t0 + ((localX - plot.left) / plot.w) * tSpan;
  };

  const readout = (s) => {
    const time = pointFormat ? pointFormat(s.ts) : "";
    const value = `${Math.round(s.avg)} free${s.predicted ? " (typical)" : ""}`;
    return time ? `${time} · ${value}` : value;
  };

  const crosshairAtClientX = (clientX) => {
    if (!samples.length) return null;
    const localX = toLocalX(clientX);
    if (localX == null) return null;
    const i = nearestIndex(xs, localX);
    const s = samples[i];
    const px = xs[i];
    vline.setAttribute("x1", px);
    vline.setAttribute("x2", px);
    dot.setAttribute("cx", px);
    dot.setAttribute("cy", y(s.avg));
    dot.classList.toggle("predicted", s.predicted);

    // Prefer the right of the guide; flip left when it would overflow, then clamp
    // so the box always sits inside the plot.
    label.setAttribute("text-anchor", "start");
    label.setAttribute("y", plot.top + 9);
    label.textContent = readout(s);
    const width = label.getBBox().width;
    let tx = px + 8;
    if (tx + width > VIEW_W - PAD.right) tx = px - 8 - width;
    tx = Math.max(PAD.left + 2, Math.min(tx, VIEW_W - PAD.right - width - 2));
    label.setAttribute("x", tx);

    const bb = label.getBBox();
    const padX = 4;
    const padY = 3;
    box.setAttribute("x", bb.x - padX);
    box.setAttribute("y", bb.y - padY);
    box.setAttribute("width", bb.width + 2 * padX);
    box.setAttribute("height", bb.height + 2 * padY);

    layer.style.display = "";
    return s;
  };

  const hideCrosshair = () => {
    layer.style.display = "none";
  };

  return { crosshairAtClientX, hideCrosshair, tsAtClientX };
}
