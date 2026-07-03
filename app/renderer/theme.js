/* Runs synchronously in <head> so the right theme is applied before first
 * paint. Explicit choice from the topbar toggle wins; otherwise follow the
 * system (which HARNESS_THEME=dark|light overrides at launch). */
"use strict";
(() => {
  const stored = localStorage.getItem("harness-theme");
  const dark = stored
    ? stored === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
})();
