'use strict';
// "Update" button: hidden unless a newer version is available on GitHub.
(function () {
  const btn = document.getElementById('updateBtn');
  if (!btn || !window.updateAPI) return;

  const ver = document.getElementById('appVer');
  const note = document.getElementById('updateNote');
  const link = document.getElementById('checkUpdate');
  if (link) link.addEventListener('click', (e) => { e.preventDefault(); void window.updateAPI.check(); });

  function render(st) {
    const s = st && st.state;
    if (ver && st && st.current) ver.textContent = 'Version ' + st.current;
    const upToDate = !s || s === 'none';
    // up to date: no button, just "You're up to date"; update received: the button (no note)
    if (note) note.textContent = upToDate ? "· ✓ You're up to date" : (st && st.note) || '';
    if (upToDate) {
      btn.classList.add('hidden'); // up to date -> no button at all
      btn.disabled = true;
      return;
    }
    btn.classList.remove('hidden'); // an update exists (or is installing) -> show the button
    btn.dataset.state = s;
    btn.disabled = false;
    btn.title = '';
    if (s === 'available') {
      btn.textContent = '⬆ Update available' + (st.version ? ' (v' + st.version + ')' : '') + ' - click to update';
    } else if (s === 'downloading') {
      btn.disabled = true;
      btn.textContent = 'Downloading update… ' + (Number(st.percent) || 0) + '%';
    } else if (s === 'waiting') {
      btn.disabled = true;
      btn.textContent = 'Finishing the current print, then updating…';
    } else if (s === 'installing') {
      btn.disabled = true;
      btn.textContent = 'Installing - the app will restart…';
    } else if (s === 'error') {
      btn.textContent = '⚠ ' + (st.error || 'Update failed - click to retry');
    }
  }

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    void window.updateAPI.install();
  });

  window.updateAPI.onState(render);
  window.updateAPI.getState().then(render).catch(() => {});
})();
