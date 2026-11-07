/*
 * Sets the theme and the message density on <html> before the first paint (P21-21), so a person who chose Dark never sees a light frame.
 * A file of our own origin, not inline text: the page forbids inline script (CSP script-src 'self'). It is loaded first in <head>, as a plain
 * blocking script, ahead of the styles.
 *
 * It reads one thing: localStorage "mt.appearance", the last choice this browser saw, as JSON {"theme":"system|light|dark","density":"comfortable|compact"}.
 * It sets three attributes: data-theme-choice (what the person picked), data-theme (light or dark, what is drawn) and data-density.
 * While the choice is "system" it follows the device and tells the app with a "mt-theme" event on window. src/shell/appearance.ts keeps
 * the same attributes and the same cache in step once the session has loaded; the server's value wins there.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var choice = 'system';
  var density = 'comfortable';
  try {
    var saved = JSON.parse(window.localStorage.getItem('mt.appearance') || 'null');
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) choice = saved.theme;
    if (saved && saved.density === 'compact') density = 'compact';
  } catch (e) { /* blocked or empty storage: follow the device */ }
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var drawn = function () {
    var current = root.getAttribute('data-theme-choice');
    if (current === 'light' || current === 'dark') return current;
    return query && query.matches ? 'dark' : 'light';
  };
  root.setAttribute('data-theme-choice', choice);
  root.setAttribute('data-theme', drawn());
  root.setAttribute('data-density', density);
  if (query && query.addEventListener) {
    query.addEventListener('change', function () {
      if (root.getAttribute('data-theme-choice') !== 'system') return;
      root.setAttribute('data-theme', drawn());
      window.dispatchEvent(new Event('mt-theme'));
    });
  }
})();
