import { test, eq } from "./harness.mjs";
import {
  normalizeTheme,
  THEMES,
  DEFAULT_THEME,
  normalizeColorScheme,
  COLOR_SCHEMES,
  DEFAULT_COLOR_SCHEME,
} from "../site/theme.js";

test("normalizeTheme keeps a known theme", () => {
  eq(normalizeTheme("terminal"), "terminal");
});

test("normalizeTheme passes the default through", () => {
  eq(normalizeTheme("default"), "default");
});

test("normalizeTheme falls back to the default for an unknown value", () => {
  eq(normalizeTheme("hologram"), DEFAULT_THEME);
});

test("normalizeTheme falls back to the default for null", () => {
  eq(normalizeTheme(null), DEFAULT_THEME);
});

test("every theme in THEMES normalizes to itself", () => {
  eq(
    THEMES.map(normalizeTheme),
    THEMES
  );
});

test("normalizeColorScheme keeps a forced scheme", () => {
  eq(normalizeColorScheme("dark"), "dark");
});

test("normalizeColorScheme falls back to system for an unknown value", () => {
  eq(normalizeColorScheme("sepia"), DEFAULT_COLOR_SCHEME);
});

test("normalizeColorScheme falls back to system for null", () => {
  eq(normalizeColorScheme(null), DEFAULT_COLOR_SCHEME);
});

test("every scheme in COLOR_SCHEMES normalizes to itself", () => {
  eq(
    COLOR_SCHEMES.map(normalizeColorScheme),
    COLOR_SCHEMES
  );
});
