/*
 * Sets the palette, the light or dark mode and the message density on <html> before the first paint (P21-21, P28-04), so a person who chose Dark, or Linen,
 * never sees another look first. A file of our own origin, not inline text: the page forbids inline script (CSP script-src 'self'). It is loaded first in
 * <head>, as a plain blocking script, ahead of the styles.
 *
 * It reads one thing: localStorage "mt.appearance", the last choice this browser saw, as JSON
 *   {"theme":"system|light|dark","density":"comfortable|compact","palette":"classic|graphite|linen|harbor"}.
 * It sets four attributes: data-theme-choice (what the person picked), data-theme (light or dark, what is drawn), data-palette and data-density.
 * While the choice is "system" it follows the device and tells the app with a "mt-theme" event on window. src/shell/appearance.ts keeps
 * the same attributes and the same cache in step once the session has loaded; the server's value wins there.
 *
 * It also preloads the one font file the chosen palette's text needs (a <link rel="preload">), so the first paint does not wait for it and no other
 * palette's font is fetched. The map below is checked against tools/design/themes.mjs by a test (test/theme-boot.test.ts).
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var choice = 'system';
  var density = 'comfortable';
  var palette = 'classic';
  var FONT = {
    classic: '/fonts/inter-latin.woff2',
    graphite: '/fonts/inter-latin.woff2',
    linen: '/fonts/ibm-plex-sans-latin-400-normal.woff2',
    harbor: '/fonts/geist-latin-wght-normal.woff2',
  };
  try {
    var saved = JSON.parse(window.localStorage.getItem('mt.appearance') || 'null');
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) choice = saved.theme;
    if (saved && saved.density === 'compact') density = 'compact';
    if (saved && typeof saved.palette === 'string' && Object.prototype.hasOwnProperty.call(FONT, saved.palette)) palette = saved.palette;
  } catch (e) { /* blocked or empty storage: follow the device */ }
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var drawn = function () {
    var current = root.getAttribute('data-theme-choice');
    if (current === 'light' || current === 'dark') return current;
    return query && query.matches ? 'dark' : 'light';
  };
  root.setAttribute('data-theme-choice', choice);
  root.setAttribute('data-theme', drawn());
  root.setAttribute('data-palette', palette);
  root.setAttribute('data-density', density);
  try {
    var link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/woff2';
    link.crossOrigin = 'anonymous';
    link.href = FONT[palette];
    document.head.appendChild(link);
  } catch (e) { /* a missing preload only costs a little time */ }
  if (query && query.addEventListener) {
    query.addEventListener('change', function () {
      if (root.getAttribute('data-theme-choice') !== 'system') return;
      root.setAttribute('data-theme', drawn());
      window.dispatchEvent(new Event('mt-theme'));
    });
  }
})();
