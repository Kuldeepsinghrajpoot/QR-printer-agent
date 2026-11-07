'use strict';

const PAPER = {
  ok: ['Paper OK', 'good'],
  low: ['Low paper', 'warn'],
  empty: ['Out of paper', 'bad'],
  jam: ['Paper jam', 'bad'],
  problem: ['Paper problem', 'bad'],
  unknown: ['Not reported', 'muted'],
  na: ['Not applicable', 'muted'],
};

const TONER = {
  low: ['Low', 'warn'],
  empty: ['Empty', 'bad'],
  unknown: ['Not reported', 'muted'],
  na: ['Not applicable', 'muted'],
};

const CONNECTION = {
  connected: ['Connected', 'good'],
  disconnected: ['Disconnected', 'bad'],
  virtual: ['Virtual', 'muted'],
};

const state = { printers: [], filter: 'all', scanning: false, timer: null };

const $ = (id) => document.getElementById(id);

// Small DOM helper — always uses textContent so printer names can't inject HTML.
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function needsAttention(p) {
  if (p.isVirtual) return false;
  return (
    p.connection === 'disconnected' ||
    ['low', 'empty', 'jam', 'problem'].includes(p.paperLevel) ||
    ['low', 'empty'].includes(p.tonerLevel) ||
    (p.errors && p.errors.length > 0)
  );
}

const FILTERS = {
  all: () => true,
  physical: (p) => !p.isVirtual,
  connected: (p) => p.connection === 'connected',
  disconnected: (p) => p.connection === 'disconnected',
  virtual: (p) => p.isVirtual,
  issues: needsAttention,
};

function sortPrinters(list) {
  const rank = { connected: 0, disconnected: 1, virtual: 2 };
  return [...list].sort(
    (a, b) => rank[a.connection] - rank[b.connection] || a.name.localeCompare(b.name)
  );
}

function renderSummary() {
  const all = state.printers;
  $('statInstalled').textContent = all.length;
  $('statConnected').textContent = all.filter((p) => p.connection === 'connected').length;
  $('statDisconnected').textContent = all.filter((p) => p.connection === 'disconnected').length;
  $('statVirtual').textContent = all.filter((p) => p.isVirtual).length;
  $('statIssues').textContent = all.filter(needsAttention).length;
}

function row(key, valueNode) {
  const r = h('div', 'row');
  r.appendChild(h('span', 'k', key));
  const v = h('span', 'v');
  if (typeof valueNode === 'string') v.textContent = valueNode;
  else v.appendChild(valueNode);
  r.appendChild(v);
  return r;
}

function levelValue(label, tone) {
  const frag = document.createDocumentFragment();
  frag.appendChild(h('span', 'dot ' + tone));
  frag.appendChild(document.createTextNode(label));
  return frag;
}

function buildCard(p) {
  const [connLabel, connTone] = CONNECTION[p.connection] || ['Unknown', 'muted'];
  const [paperLabel, paperTone] = PAPER[p.paperLevel] || PAPER.unknown;
  const [tonerLabel, tonerTone] = TONER[p.tonerLevel] || TONER.unknown;

  const card = h('article', 'card ' + p.connection);

  const head = h('div', 'card-head');
  const titleWrap = h('div');
  titleWrap.appendChild(h('div', 'card-title', p.name));
  const tags = h('div', 'tags');
  if (p.isDefault) tags.appendChild(h('span', 'tag', 'Default'));
  if (p.isShared) tags.appendChild(h('span', 'tag', 'Shared'));
  tags.appendChild(h('span', 'tag', p.portType));
  titleWrap.appendChild(tags);
  head.appendChild(titleWrap);
  head.appendChild(h('span', 'pill ' + connTone, connLabel));
  card.appendChild(head);

  if (p.detail) card.appendChild(h('div', 'detail', p.detail));

  const rows = h('div', 'rows');
  rows.appendChild(row('Status', p.status));
  rows.appendChild(row('Paper', levelValue(paperLabel, paperTone)));
  if (!p.isVirtual) rows.appendChild(row('Ink / toner', levelValue(tonerLabel, tonerTone)));
  rows.appendChild(row('Queued jobs', String(p.jobs)));
  rows.appendChild(row('Port', p.port || '–'));
  if (p.tcpPort) rows.appendChild(row('Port number', String(p.tcpPort)));
  if (p.ipAddress) rows.appendChild(row('IP address', p.ipAddress));
  rows.appendChild(row('Driver', p.driver || '–'));
  if (p.location) rows.appendChild(row('Location', p.location));
  card.appendChild(rows);

  if (p.errors && p.errors.length) {
    const errs = h('div', 'errors');
    p.errors.forEach((e) => errs.appendChild(h('span', 'pill bad', e)));
    card.appendChild(errs);
  }
  return card;
}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  const visible = sortPrinters(state.printers.filter(FILTERS[state.filter]));
  if (!visible.length) {
    list.appendChild(h('div', 'empty', state.printers.length ? 'No printers match this filter.' : 'No printers installed.'));
    return;
  }
  visible.forEach((p) => list.appendChild(buildCard(p)));
}

function showBanner(message, isError) {
  const b = $('banner');
  if (!message) {
    b.classList.add('hidden');
    return;
  }
  b.textContent = message;
  b.classList.toggle('error', Boolean(isError));
  b.classList.remove('hidden');
}

async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';

  try {
    const res = await window.printerAPI.scan();
    if (!res.ok) {
      showBanner('Scan failed: ' + res.error, true);
    } else {
      state.printers = res.data.printers;
      const notes = [];
      if (res.mock) notes.push('Showing sample data — run the app on Windows to see real printers.');
      if (res.data.spooler && res.data.spooler !== 'Running') {
        notes.push('The Print Spooler service is "' + res.data.spooler + '". Printers may not be detected correctly until it is started.');
      }
      showBanner(notes.join(' '), false);
      $('lastScan').textContent = 'Last scan: ' + new Date(res.data.scannedAt).toLocaleTimeString();
      renderSummary();
      renderList();
    }
  } catch (err) {
    showBanner('Scan failed: ' + err.message, true);
  } finally {
    state.scanning = false;
    btn.disabled = false;
    btn.textContent = 'Scan printers';
  }
}

function setAutoRefresh(on) {
  clearInterval(state.timer);
  state.timer = on ? setInterval(scan, 30000) : null;
}

$('refreshBtn').addEventListener('click', scan);
$('autoRefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === btn));
  renderList();
});

scan();
