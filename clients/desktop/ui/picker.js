// The first screen: choose the server. Plain script, no build step. It talks to the shell through the two commands in build.rs.
(function () {
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  var form = document.getElementById('form');
  var input = document.getElementById('url');
  var button = document.getElementById('connect');
  var notice = document.getElementById('notice');

  function say(text) {
    notice.textContent = text || '';
    notice.hidden = !text;
  }

  if (!invoke) {
    say('This screen only works inside the manythreads app.');
    button.disabled = true;
    return;
  }

  invoke('default_server').then(
    function (state) {
      input.value = state.savedUrl || state.defaultUrl;
      say(state.notice);
      input.select();
    },
    function () {
      input.value = 'https://manythreads.kahf.to';
    },
  );

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    say('');
    button.disabled = true;
    button.textContent = 'Connecting…';
    invoke('connect_server', { url: input.value }).then(
      function () {
        // The shell is already loading the server; this page goes away.
      },
      function (message) {
        say(String(message));
        button.disabled = false;
        button.textContent = 'Connect';
      },
    );
  });
})();
