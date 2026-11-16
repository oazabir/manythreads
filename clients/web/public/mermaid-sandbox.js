/*
 * The code inside the diagram frame (clients/web/src/viewers/mermaid/sandbox.ts explains the frame). A file of our own origin, not inline text:
 * the page that holds the frame forbids inline script. It reads the address of the Mermaid bundle from `?bundle=`, loads it as an ordinary script
 * of this site, then draws what the page posts and posts back the height or the error.
 */
(function () {
  'use strict';
  var host = window.parent;
  var CH = 'manythreads.mermaid';
  var out = document.getElementById('out');
  var post = function (m) { m.channel = CH; host.postMessage(m, '*'); };

  // only a script of this site's own bundle folder, never an address taken from outside
  var bundle = new URLSearchParams(location.search).get('bundle') || '';
  if (!/^\/[A-Za-z0-9_.@\/-]+\.js$/.test(bundle) || bundle.indexOf('//') !== -1 || bundle.indexOf('..') !== -1) {
    post({ type: 'error', id: 0, message: 'The diagram renderer could not be loaded.' });
    return;
  }

  var n = 0;
  // The page sends the colours and the face of its theme with each request (sandbox.ts, diagramLook). Only plain colours and a plain font list are used.
  var PLAIN_COLOUR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9 ,.%\/]+\))$/;
  var PLAIN_FONTS = /^[A-Za-z0-9 ,'"_-]{1,200}$/;
  var applied = '';
  var applyLook = function (look) {
    var c = {};
    var dark = false;
    var font = 'system-ui, sans-serif';
    if (look && typeof look === 'object') {
      dark = look.dark === true;
      if (typeof look.fontFamily === 'string' && PLAIN_FONTS.test(look.fontFamily)) font = look.fontFamily;
      var src = look.colours && typeof look.colours === 'object' ? look.colours : {};
      Object.keys(src).forEach(function (k) { if (typeof src[k] === 'string' && PLAIN_COLOUR.test(src[k])) c[k] = src[k]; });
    }
    var key = JSON.stringify([dark, font, c]);
    if (key === applied) return;
    applied = key;
    var v = { darkMode: dark, fontFamily: font };
    var set = function (name, token) { if (c[token]) v[name] = c[token]; };
    set('background', 'paper');
    set('mainBkg', 'surface'); set('primaryColor', 'surface'); set('nodeBkg', 'surface');
    set('primaryTextColor', 'ink'); set('textColor', 'txt'); set('nodeTextColor', 'ink'); set('titleColor', 'ink');
    set('primaryBorderColor', 'mute'); set('nodeBorder', 'mute'); set('lineColor', 'mute'); set('arrowheadColor', 'mute');
    set('secondaryColor', 'agent-wash'); set('secondaryTextColor', 'ink'); set('secondaryBorderColor', 'agent');
    set('tertiaryColor', 'shell'); set('tertiaryTextColor', 'ink'); set('tertiaryBorderColor', 'rule');
    set('clusterBkg', 'shell'); set('clusterBorder', 'rule'); set('edgeLabelBackground', 'paper');
    set('noteBkgColor', 'shell'); set('noteTextColor', 'ink'); set('noteBorderColor', 'rule');
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: v, suppressErrorRendering: true, fontFamily: font });
    } catch (e) { /* reported on the first render */ }
  };
  var start = function () {
    applyLook(null);
    window.addEventListener('message', function (ev) {
      if (ev.source !== host) return;
      var m = ev.data;
      if (!m || m.channel !== CH || m.type !== 'render' || typeof m.source !== 'string') return;
      var id = m.id;
      applyLook(m.look);
      Promise.resolve()
        .then(function () { return mermaid.parse(m.source); })
        .then(function () { return mermaid.render('d' + (++n), m.source); })
        .then(function (r) {
          out.innerHTML = r.svg;
          post({ type: 'rendered', id: id, height: document.documentElement.scrollHeight });
        })
        .catch(function (e) {
          out.textContent = '';
          post({ type: 'error', id: id, message: String((e && (e.str || e.message)) || e) });
        });
    });
    post({ type: 'ready' });
  };

  var s = document.createElement('script');
  s.src = bundle;
  s.onload = start;
  s.onerror = function () { post({ type: 'error', id: 0, message: 'The diagram renderer could not be loaded.' }); };
  document.head.appendChild(s);
})();
