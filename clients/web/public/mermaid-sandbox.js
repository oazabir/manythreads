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
  var start = function () {
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, fontFamily: 'Inter Tight, system-ui, sans-serif' });
    } catch (e) { /* reported on the first render */ }
    window.addEventListener('message', function (ev) {
      if (ev.source !== host) return;
      var m = ev.data;
      if (!m || m.channel !== CH || m.type !== 'render' || typeof m.source !== 'string') return;
      var id = m.id;
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
