// Theme + appearance selection. Two independent preferences:
//
//   - theme:  "default" (rounded, sans-serif) or "terminal" (monospace CRT).
//   - scheme: light/dark, either following the system ("system") or forced.
//
// Both are expressed as attributes on <html> that site/style.css keys off:
// `data-theme` ("default" is the attribute's absence, so CSS only names
// non-default themes) and `data-scheme` (always resolved to "light" or "dark",
// so the stylesheet never needs a prefers-color-scheme query and a forced choice
// just overrides the system one). The head of index.html sets both before first
// paint to avoid a flash; this module owns the runtime switching.

export const DEFAULT_THEME = "default";

// The selectable themes. New themes append here and get a matching CSS block and
// an <option> in index.html; nothing else needs to change.
export const THEMES = [DEFAULT_THEME, "terminal", "geocities", "windows", "collegiate"];

export const DEFAULT_COLOR_SCHEME = "system";

// The selectable appearance preferences. "system" defers to prefers-color-scheme;
// "light"/"dark" force the scheme regardless of the OS setting.
export const COLOR_SCHEMES = [DEFAULT_COLOR_SCHEME, "light", "dark"];

// The browser-chrome color per theme and resolved scheme. The default keeps the
// original brand blue in both; the terminal theme tracks its own background.
const THEME_COLORS = {
  default: { light: "#66ccff", dark: "#66ccff" },
  terminal: { light: "#f4f1e6", dark: "#0a0a0a" },
  geocities: { light: "#ffcc00", dark: "#000022" },
  windows: { light: "#008080", dark: "#000000" },
  collegiate: { light: "#c5050c", dark: "#7a0306" },
};

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function normalizeColorScheme(value) {
  return COLOR_SCHEMES.includes(value) ? value : DEFAULT_COLOR_SCHEME;
}

function systemScheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The concrete light/dark a preference resolves to right now.
export function resolveColorScheme(preference) {
  const pref = normalizeColorScheme(preference);
  return pref === "system" ? systemScheme() : pref;
}

// Repoint the theme-color meta from the attributes already on <html>, so it
// stays correct however the active theme or scheme was last set.
function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const theme = normalizeTheme(document.documentElement.dataset.theme);
  const scheme = document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
  meta.setAttribute("content", THEME_COLORS[theme][scheme]);
}

// Apply a theme to the live document: toggle the <html> data-theme attribute the
// stylesheet reads (default is its absence) and refresh the chrome color.
export function applyTheme(value) {
  const theme = normalizeTheme(value);
  if (theme === DEFAULT_THEME) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  updateThemeColor();
}

// Apply an appearance preference: resolve it to a concrete light/dark, set the
// <html> data-scheme attribute the stylesheet reads, and refresh the chrome
// color. Called on a system change too, where a "system" preference re-resolves.
export function applyColorScheme(preference) {
  document.documentElement.dataset.scheme = resolveColorScheme(preference);
  updateThemeColor();
}
