'use strict';

// Print Agent tab (runs in the window; talks to the main process through window.agentAPI).
(() => {
  const api = window.agentAPI;
  const $ = (id) => document.getElementById(id);

  // Small DOM helper — always textContent so printer/order text can't inject HTML.
  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  let systemPrinters = [];
  let mappings = [];
  let activeTab = 'monitor';
  let msgTimer = null;

  // ---------- tabs ----------
  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('tab-monitor').classList.toggle('hidden', tab !== 'monitor');
    $('tab-agent').classList.toggle('hidden', tab !== 'agent');
    document.querySelectorAll('.monitor-only').forEach((el) => el.classList.toggle('hidden', tab !== 'monitor'));
    if (tab === 'agent') {
      refreshLive();
      refreshPrinters();
    }
  }
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });

  // ---------- messages ----------
  function showMsg(text, isError) {
    const b = $('agentMsg');
    b.textContent = text;
    b.classList.toggle('error', Boolean(isError));
    b.classList.remove('hidden');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => b.classList.add('hidden'), 5000);
  }

  // ---------- status pill ----------
  function renderStatus(status) {
    const pill = $('agentPill');
    const detail = $('agentDetail');
    const dot = $('agentDot');
    let label, tone, text = '';
    if (!status.configured) {
      label = 'Not set up'; tone = 'muted'; text = 'Enter the server URL and agent key below.';
    } else if (status.lastError) {
      label = 'Connection problem'; tone = 'bad'; text = status.lastError;
    } else if (status.lastSyncAt) {
      label = 'Connected'; tone = 'good';
      text = 'Last sync ' + new Date(status.lastSyncAt).toLocaleTimeString() + ' · queued retries: ' + status.queueLength;
    } else {
      label = 'Connecting…'; tone = 'warn';
    }
    pill.className = 'pill ' + tone;
    pill.textContent = label;
    detail.textContent = text;
    dot.className = 'dot ' + tone;
  }

  // ---------- printers + activity ----------
  const STATUS_LABEL = {
    online: ['Online', 'good'],
    offline: ['Offline', 'bad'],
    paper_jam: ['Paper jam', 'bad'],
    out_of_paper: ['Out of paper', 'bad'],
    low_ink: ['Low ink/toner', 'warn'],
    unknown: ['Unknown', 'muted'],
  };
  const TYPE_LABEL = { bw: 'B&W', color: 'Color', both: 'B&W + Color' };

  function renderPrinters(list) {
    const box = $('agentPrinters');
    box.replaceChildren();
    if (!list.length) {
      box.appendChild(h('div', 'empty-line', 'No printers found on this PC. Connect a printer and click "Sync now".'));
      return;
    }
    list.forEach((p) => {
      const [label, tone] = STATUS_LABEL[p.status] || STATUS_LABEL.unknown;
      const row = h('div', 'agent-row');
      const grow = h('div', 'grow');
      grow.appendChild(h('div', 'name', p.systemPrinterName));
      grow.appendChild(h('div', 'meta', p.linked ? 'Linked to dashboard · ' + (TYPE_LABEL[p.type] || '') : 'Not linked yet — click "Sync now"'));
      const where = [p.port, p.ipAddress ? (p.tcpPort ? p.ipAddress + ':' + p.tcpPort : p.ipAddress) : p.tcpPort ? 'port ' + p.tcpPort : '']
        .filter(Boolean)
        .join(' · ');
      if (where) grow.appendChild(h('div', 'meta', 'Port: ' + where));
      row.appendChild(grow);
      row.appendChild(h('span', 'pill ' + tone, label));
      box.appendChild(row);
    });
    // names for the manual-link dropdowns
    systemPrinters = list.map((p) => p.systemPrinterName);
    populateDefaultPrinter();
    renderMappings();
  }

  function renderActivity(list) {
    const box = $('activityList');
    box.replaceChildren();
    if (!list.length) {
      box.appendChild(h('div', 'empty-line', 'Nothing yet — orders will show up here as they print.'));
      return;
    }
    list.slice(0, 15).forEach((a) => {
      const row = h('div', 'agent-row ' + a.level);
      const grow = h('div', 'grow');
      const top = h('div', 'name wrap');
      if (a.token) top.appendChild(h('span', 'token', '#' + a.token));
      top.appendChild(document.createTextNode((a.token ? ' ' : '') + a.message));
      grow.appendChild(top);
      row.appendChild(grow);
      row.appendChild(h('span', 'time', new Date(a.at).toLocaleTimeString()));
      box.appendChild(row);
    });
  }

  async function refreshLive() {
    try {
      const [status, activity] = await Promise.all([api.getStatus(), api.getActivity()]);
      renderStatus(status);
      renderActivity(activity);
    } catch (_) { /* window closing */ }
  }

  async function refreshPrinters() {
    try {
      renderPrinters(await api.getPrinters());
    } catch (_) { /* ignore */ }
  }

  // ---------- manual mappings ----------
  function populateDefaultPrinter() {
    const select = $('defaultSystemPrinterName');
    const current = select.value || select.dataset.value || '';
    select.replaceChildren();
    const none = h('option', null, '— none —');
    none.value = '';
    select.appendChild(none);
    systemPrinters.forEach((name) => {
      const opt = h('option', null, name);
      opt.value = name;
      select.appendChild(opt);
    });
    select.value = current;
  }

  function renderMappings() {
    const box = $('agentMappings');
    box.replaceChildren();
    mappings.forEach((m, i) => {
      const row = h('div', 'mapping-row');

      const idInput = document.createElement('input');
      idInput.type = 'text';
      idInput.placeholder = 'Dashboard Printer ID';
      idInput.value = m.dbPrinterId || '';
      idInput.addEventListener('input', () => { mappings[i].dbPrinterId = idInput.value.trim(); });

      const nameSelect = document.createElement('select');
      systemPrinters.forEach((name) => {
        const opt = h('option', null, name);
        opt.value = name;
        if (name === m.systemPrinterName) opt.selected = true;
        nameSelect.appendChild(opt);
      });
      nameSelect.addEventListener('change', () => { mappings[i].systemPrinterName = nameSelect.value; });
      if (!m.systemPrinterName && nameSelect.value) mappings[i].systemPrinterName = nameSelect.value;

      const typeSelect = document.createElement('select');
      typeSelect.className = 'type';
      ['both', 'bw', 'color'].forEach((t) => {
        const opt = h('option', null, TYPE_LABEL[t]);
        opt.value = t;
        if (t === m.type) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => { mappings[i].type = typeSelect.value; });

      const remove = h('button', 'small', '✕');
      remove.type = 'button';
      remove.title = 'Remove';
      remove.addEventListener('click', () => { mappings.splice(i, 1); renderMappings(); });

      row.append(idInput, nameSelect, typeSelect, remove);
      box.appendChild(row);
    });
  }

  $('addMapping').addEventListener('click', () => {
    mappings.push({ dbPrinterId: '', systemPrinterName: systemPrinters[0] || '', type: 'both' });
    renderMappings();
  });

  // ---------- form ----------
  $('toggleKey').addEventListener('click', () => {
    const input = $('agentApiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? 'Hide' : 'Show';
  });

  $('saveAgent').addEventListener('click', async () => {
    const cfg = {
      serverUrl: $('serverUrl').value.trim(),
      agentApiKey: $('agentApiKey').value.trim(),
      pollIntervalSeconds: Number($('pollIntervalSeconds').value) || 5,
      heartbeatIntervalSeconds: Number($('heartbeatIntervalSeconds').value) || 30,
      defaultSystemPrinterName: $('defaultSystemPrinterName').value,
      autoStartOnLogin: $('autoStartOnLogin').checked,
      printerMappings: mappings.filter((m) => m.dbPrinterId),
    };
    try {
      await api.saveConfig(cfg);
      showMsg('Saved — agent restarted with the new settings.', false);
      setTimeout(() => { refreshLive(); refreshPrinters(); }, 2500);
    } catch (err) {
      showMsg('Could not save: ' + err.message, true);
    }
  });

  $('syncNow').addEventListener('click', async () => {
    const btn = $('syncNow');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const status = await api.syncNow();
      renderStatus(status);
      await Promise.all([refreshLive(), refreshPrinters()]);
      if (!status.configured) showMsg('Enter the agent key first, then save.', true);
      else if (status.lastError) showMsg(status.lastError, true);
      else showMsg('Synced successfully.', false);
    } catch (err) {
      showMsg('Sync failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync now';
    }
  });

  // ---------- init ----------
  async function init() {
    const cfg = await api.getConfig();
    $('serverUrl').value = cfg.serverUrl || '';
    $('agentApiKey').value = cfg.agentApiKey || '';
    $('pollIntervalSeconds').value = cfg.pollIntervalSeconds || 5;
    $('heartbeatIntervalSeconds').value = cfg.heartbeatIntervalSeconds || 30;
    $('autoStartOnLogin').checked = !!cfg.autoStartOnLogin;
    $('defaultSystemPrinterName').dataset.value = cfg.defaultSystemPrinterName || '';
    mappings = (cfg.printerMappings || []).map((m) => ({ ...m }));
    populateDefaultPrinter();
    renderMappings();
    api.getMachine().then((m) => {
      const model = [m.manufacturer, m.model].filter(Boolean).join(' ') || 'model unknown';
      $('machineInfo').textContent = 'This computer: ' + m.hostname + (m.username ? ' · User: ' + m.username : '') + ' · ' + model + ' · ID ' + m.id.slice(0, 8);
    }).catch(() => {});
    renderStatus(await api.getStatus());
    if (!cfg.agentApiKey) setTab('agent'); // first run: go straight to the setup form
  }

  api.onStatus((status) => {
    renderStatus(status);
    if (activeTab === 'agent') api.getActivity().then(renderActivity).catch(() => {});
  });
  setInterval(() => { if (activeTab === 'agent') refreshLive(); }, 4000);
  setInterval(() => { if (activeTab === 'agent') refreshPrinters(); }, 20000);

  init().catch((err) => showMsg('Could not load agent settings: ' + err.message, true));
})();
