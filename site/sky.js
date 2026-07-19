// Live rooftop-sky background for the "sky" theme. UW-Madison's AOSS building sits
// just west of the Capitol, and its rooftop cameras look out over the downtown
// isthmus where these garages are, so the background is the actual current sky
// above them (imagery: UW-Madison SSEC/AOS, credited in the footer).
//
// A factory that mounts one fixed, full-viewport element with two crossfading
// layers and, while running, shows the sky per the selected mode: a fixed compass
// view, "loop" (cycle the five views in order), or "shuffle" (cycle at random).
// A single timer drives every mode; each tick reloads a fresh (cache-busted)
// frame, so even a fixed view stays live. It's a control-plane concern (a
// background timer), kept off the render path and started/stopped as the theme is
// switched. It degrades to the theme's sky gradient (the body background) when a
// frame fails to load or the app is offline: a layer only crossfades in once its
// image has actually decoded.

// AOSS rooftop cameras, east first: east faces the downtown isthmus and Capitol,
// where the garages are.
export const SKY_VIEWS = ["east", "south", "west", "northwest", "north"];

// The selectable modes: a fixed view, or one of the two rotating modes.
export const SKY_MODES = [...SKY_VIEWS, "loop", "shuffle"];

export const DEFAULT_SKY_MODE = "loop";

export function normalizeSkyMode(value) {
  return SKY_MODES.includes(value) ? value : DEFAULT_SKY_MODE;
}

const imageUrl = (view) =>
  `https://f5.aos.wisc.edu/webcam_movies/latest_${view}_1024x768.jpg`;

// Advance/refresh this often. The source frames refresh about once a minute, so a
// rotating mode cycles views without ever fetching faster than the source changes.
const ROTATE_MS = 18_000;

// The cache-bust key changes only once a minute, matching how often the source
// updates, so re-showing a view within the same minute reuses the cached frame
// instead of re-fetching a byte-identical image.
function minuteStamp() {
  return Math.floor(Date.now() / 60_000);
}

// `onView` is called with the compass view currently on screen (after its frame
// decodes and crossfades in), or null when the background stops, so the UI can
// glow whichever camera is live even while looping/shuffling.
export function createSkyBackground(onView) {
  const root = document.createElement("div");
  root.className = "sky-bg";
  root.setAttribute("aria-hidden", "true");
  const layers = [document.createElement("div"), document.createElement("div")];
  for (const layer of layers) {
    layer.className = "sky-layer";
    root.appendChild(layer);
  }

  let mounted = false;
  let timer = null;
  let mode = DEFAULT_SKY_MODE;
  let seqIndex = 0; // next view for "loop"
  let currentView = null; // last shown, so "shuffle" can avoid an immediate repeat
  let front = 0; // which layer is currently visible

  function nextView() {
    if (SKY_MODES.includes(mode) && SKY_VIEWS.includes(mode)) return mode;
    if (mode === "loop") {
      const view = SKY_VIEWS[seqIndex];
      seqIndex = (seqIndex + 1) % SKY_VIEWS.length;
      return view;
    }
    // shuffle: a random view other than the one on screen
    let view = currentView;
    while (view === currentView) {
      view = SKY_VIEWS[Math.floor(Math.random() * SKY_VIEWS.length)];
    }
    return view;
  }

  function show(view) {
    const url = `${imageUrl(view)}?t=${minuteStamp()}`;
    // Decode off-screen first: only crossfade to the new frame once it's ready, so
    // a slow or failed load never flashes a blank layer over the sky gradient.
    const img = new Image();
    img.onload = () => {
      const back = front ^ 1;
      layers[back].style.backgroundImage = `url("${url}")`;
      layers[back].classList.add("visible");
      layers[front].classList.remove("visible");
      front = back;
      onView?.(view);
    };
    img.src = url;
  }

  function tick() {
    const view = nextView();
    currentView = view;
    show(view);
  }

  function start() {
    if (!mounted) {
      document.body.appendChild(root);
      mounted = true;
    }
    if (timer !== null) return;
    tick(); // paint the first frame immediately rather than after a full interval
    timer = window.setInterval(tick, ROTATE_MS);
  }

  function stop() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    if (mounted) {
      root.remove();
      mounted = false;
    }
    // Reset the layers; keep `mode` so a re-start resumes the chosen view/rotation.
    seqIndex = 0;
    currentView = null;
    front = 0;
    for (const layer of layers) {
      layer.classList.remove("visible");
      layer.style.backgroundImage = "";
    }
    onView?.(null);
  }

  // Switch view/rotation. Reflects immediately when running; otherwise the next
  // start() picks it up.
  function setMode(next) {
    mode = normalizeSkyMode(next);
    seqIndex = 0;
    if (timer !== null) tick();
  }

  return { start, stop, setMode };
}
