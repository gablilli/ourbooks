/* global state */
let providers = {};
let selectedProvider = null;
let ws = null;
let running = false;
let progressValue = 0;
let lastHeuristicProgressTick = 0;

const LOG_PATTERNS = {
  completedStage: /download completato|merging pages|processo terminato|download pronto/i,
  activeStage: /downloading|converting page|processing annotations/i
};
const HEURISTIC_PROGRESS_THROTTLE_MS = 250;
const HEURISTIC_PROGRESS_INCREMENT = 1;
const HEURISTIC_PROGRESS_MAX = 95;
const MAX_DOWNLOAD_URL_LENGTH = 2048;

/* DOM refs */
const providerList   = document.getElementById('providerList');
const providerGrid   = document.getElementById('providerGrid');
const welcomeState   = document.getElementById('welcomeState');
const downloadForm   = document.getElementById('downloadForm');
const formFields     = document.getElementById('formFields');
const providerEmoji  = document.getElementById('providerEmoji');
const providerTitle  = document.getElementById('providerTitle');
const downloadFormEl = document.getElementById('downloadFormEl');
const startBtn       = document.getElementById('startBtn');
const stopBtn        = document.getElementById('stopBtn');
const terminalSection = document.getElementById('terminalSection');
const terminal       = document.getElementById('terminal');
const clearBtn       = document.getElementById('clearBtn');
const cliToggle      = document.getElementById('cliToggle');
const progressSection = document.getElementById('progressSection');
const progressBadge  = document.getElementById('progressBadge');
const progressLabel  = document.getElementById('progressLabel');
const progressFill   = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const progressHint   = document.getElementById('progressHint');
const progressTrack  = document.querySelector('.progress-track');
const downloadBtn    = document.getElementById('downloadBtn');

/* ─── Fetch providers ─── */
async function init() {
  registerServiceWorker();
  cliToggle?.addEventListener('change', updateCliVisibility);
  if (cliToggle) cliToggle.checked = false;
  updateCliVisibility();
  setProgress(0, 'idle', 'Pronto a iniziare', 'Lo stato si aggiorna durante il download');

  try {
    const res = await fetch('/api/providers.js');
    providers = await res.json();
    renderSidebar();
    renderGrid();
    connectWS();
  } catch (err) {
    appendTerminal(`\nErrore di connessione al server: ${err.message}\n`, 'stderr');
  }
}

/* ─── Sidebar ─── */
function renderSidebar() {
  providerList.innerHTML = '';
  for (const [id, p] of Object.entries(providers)) {
    const btn = document.createElement('button');
    btn.className = 'provider-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="p-emoji">${p.emoji}</span><span class="p-label">${p.label}</span>`;
    btn.addEventListener('click', () => selectProvider(id));
    providerList.appendChild(btn);
  }
}

/* ─── Welcome grid ─── */
function renderGrid() {
  providerGrid.innerHTML = '';
  for (const [id, p] of Object.entries(providers)) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.innerHTML = `<span class="pc-emoji">${p.emoji}</span><span class="pc-label">${p.label}</span>`;
    card.addEventListener('click', () => selectProvider(id));
    providerGrid.appendChild(card);
  }
}

/* ─── Select provider ─── */
function selectProvider(id) {
  selectedProvider = id;
  resetDownloadButton();
  progressValue = 0;
  lastHeuristicProgressTick = 0;
  setProgress(0, 'idle', 'Pronto a iniziare', 'Lo stato si aggiorna durante il download');

  /* update sidebar active state */
  document.querySelectorAll('.provider-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === id);
  });

  const p = providers[id];

  /* update form header */
  providerEmoji.textContent = p.emoji;
  providerTitle.textContent = p.label;

  /* render fields */
  formFields.innerHTML = '';
  for (const field of p.fields) {
    formFields.appendChild(buildField(field));
  }

  /* Setup Sanoma GEDI loader */
  if (id === 'sanoma') {
    setupSanomaGediLoader();
  }

  if (id === 'dibooklaterza') {
    setupLaterzeBookLoader();
  }

  if (id === 'hubscuola') {
    setupHubscuolaBookLoader();
  }

  if (id === 'zanichelli') {
    setupZanichelliBookLoader();
  }

  if (id === 'bsmart') {
    setupBsmartBookLoader();
  }

  /* show form, hide welcome */
  welcomeState.classList.add('hidden');
  downloadForm.classList.remove('hidden');
}

/* ─── Build a form field ─── */
function buildField(field) {
  const group = document.createElement('div');
  group.className = 'field-group';

  const label = document.createElement('label');
  label.setAttribute('for', `field-${field.name}`);
  label.innerHTML = field.label +
    (field.required
      ? `<span class="required-badge">*</span>`
      : `<span class="optional-badge">(opzionale)</span>`);

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    input.dataset.dynamicOptions = field.dynamicOptions ? 'true' : 'false';
    
    if (!field.dynamicOptions) {
      // Static options
      for (const opt of (field.options || [])) {
        const o = document.createElement('option');
        o.value = o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      // Dynamic options - add placeholder
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Caricamento...';
      input.appendChild(o);
      input.disabled = true;
    }
  } else if (field.type === 'checkbox') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.value = 'on';
    group.className += ' field-group--checkbox';
  } else {
    input = document.createElement('input');
    input.type = field.type;
    input.placeholder = field.placeholder || '';
    if (field.required) input.required = true;
  }

  input.id = `field-${field.name}`;
  input.name = field.name;

  group.appendChild(label);
  group.appendChild(input);
  return group;
}

/* ─── Setup Sanoma GEDI loader ─── */
let sanomaSyncTimer = null;
let sanomaLastCredentialsKey = '';
let sanomaSyncRequestId = 0;
function setupSanomaGediLoader() {
  clearTimeout(sanomaSyncTimer);
  
  const idField = document.getElementById('field-id');
  const passwordField = document.getElementById('field-password');
  const gediField = document.getElementById('field-gedi');

  if (!idField || !passwordField || !gediField) return;

  async function syncGedi() {
    clearTimeout(sanomaSyncTimer);
    
    const id = idField.value?.trim();
    const password = passwordField.value?.trim();

    if (!id || !password) {
      sanomaLastCredentialsKey = '';
      gediField.innerHTML = '<option value="">Inserisci email e password</option>';
      gediField.disabled = true;
      return;
    }

    const credentialsKey = `${id}::${password}`;
    if (credentialsKey === sanomaLastCredentialsKey) {
      return;
    }

    sanomaLastCredentialsKey = credentialsKey;
    const requestId = ++sanomaSyncRequestId;

    gediField.innerHTML = '<option value="">Caricamento libri...</option>';
    gediField.disabled = true;

    try {
      const res = await fetch('/api/sanoma-gedi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password })
      });

      const data = await res.json();

      if (requestId !== sanomaSyncRequestId) return;

      if (!res.ok) {
        gediField.innerHTML = `<option value="">${data.error || 'Errore di caricamento'}</option>`;
        return;
      }

      gediField.innerHTML = '<option value="">Seleziona un libro</option>';
      for (const book of data.books) {
        const opt = document.createElement('option');
        opt.value = book.gedi;
        opt.textContent = book.name;
        gediField.appendChild(opt);
      }
      gediField.disabled = false;
    } catch (err) {
      if (requestId !== sanomaSyncRequestId) return;
      gediField.innerHTML = `<option value="">Errore: ${err.message}</option>`;
    }
  }

  idField.addEventListener('input', () => {
    clearTimeout(sanomaSyncTimer);
    sanomaSyncTimer = setTimeout(syncGedi, 450);
  });
  passwordField.addEventListener('input', () => {
    clearTimeout(sanomaSyncTimer);
    sanomaSyncTimer = setTimeout(syncGedi, 450);
  });

  /* Initial load */
  syncGedi();
}

/* ─── Laterza book loader ─── */
let laterzaSyncTimer = null;
let laterzaLastCredentialsKey = '';
let laterzaSyncRequestId = 0;
function setupLaterzeBookLoader() {
  clearTimeout(laterzaSyncTimer);

  const usernameField = document.getElementById('field-username');
  const passwordField = document.getElementById('field-password');
  const isbnField = document.getElementById('field-isbn');

  if (!usernameField || !passwordField || !isbnField) return;

  async function syncBooks() {
    clearTimeout(laterzaSyncTimer);

    const username = usernameField.value?.trim();
    const password = passwordField.value?.trim();

    if (!username || !password) {
      laterzaLastCredentialsKey = '';
      isbnField.innerHTML = '<option value="">Inserisci email e password</option>';
      isbnField.disabled = true;
      return;
    }

    const credentialsKey = `${username}::${password}`;
    if (credentialsKey === laterzaLastCredentialsKey) return;

    laterzaLastCredentialsKey = credentialsKey;
    const requestId = ++laterzaSyncRequestId;

    isbnField.innerHTML = '<option value="">Caricamento libri...</option>';
    isbnField.disabled = true;

    try {
      const res = await fetch('/api/dibooklaterza-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (requestId !== laterzaSyncRequestId) return;

      if (!res.ok) {
        isbnField.innerHTML = `<option value="">${data.error || 'Errore di caricamento'}</option>`;
        return;
      }

      isbnField.innerHTML = '<option value="">Seleziona un libro</option>';
      for (const book of data.books) {
        const opt = document.createElement('option');
        opt.value = book.isbn;
        opt.textContent = `${book.title}${book.authors ? ' — ' + book.authors : ''} (${book.isbn})`;
        isbnField.appendChild(opt);
      }
      isbnField.disabled = false;
    } catch (err) {
      if (requestId !== laterzaSyncRequestId) return;
      isbnField.innerHTML = `<option value="">Errore: ${err.message}</option>`;
    }
  }

  usernameField.addEventListener('input', () => {
    clearTimeout(laterzaSyncTimer);
    laterzaSyncTimer = setTimeout(syncBooks, 450);
  });
  passwordField.addEventListener('input', () => {
    clearTimeout(laterzaSyncTimer);
    laterzaSyncTimer = setTimeout(syncBooks, 450);
  });

  syncBooks();
}

/* ─── HubScuola books loader ─── */
let hubSyncTimer = null;
let hubLastCredentialsKey = '';
let hubSyncRequestId = 0;
function setupHubscuolaBookLoader() {
  clearTimeout(hubSyncTimer);

  const usernameField = document.getElementById('field-username');
  const passwordField = document.getElementById('field-password');
  const platformField = document.getElementById('field-platform');
  const volumeField = document.getElementById('field-volumeId');

  if (!usernameField || !passwordField || !platformField || !volumeField) return;

  async function syncHubBooks() {
    clearTimeout(hubSyncTimer);

    const username = usernameField.value?.trim();
    const password = passwordField.value?.trim();
    const platform = platformField.value?.trim();

    if (!username || !password || !platform) {
      hubLastCredentialsKey = '';
      volumeField.innerHTML = '<option value="">Inserisci email, password e piattaforma</option>';
      volumeField.disabled = true;
      return;
    }

    const credentialsKey = `${username}::${password}::${platform}`;
    if (credentialsKey === hubLastCredentialsKey) return;

    hubLastCredentialsKey = credentialsKey;
    const requestId = ++hubSyncRequestId;

    volumeField.innerHTML = '<option value="">Caricamento libri...</option>';
    volumeField.disabled = true;

    try {
      const res = await fetch('/api/hubscuola-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, platform })
      });

      const data = await res.json();
      if (requestId !== hubSyncRequestId) return;

      if (!res.ok) {
        volumeField.innerHTML = `<option value="">${data.error || 'Errore di caricamento'}</option>`;
        return;
      }

      if (!Array.isArray(data.books) || data.books.length === 0) {
        volumeField.innerHTML = '<option value="">Nessun libro trovato</option>';
        return;
      }

      volumeField.innerHTML = '<option value="">Seleziona un libro</option>';
      for (const book of data.books) {
        const opt = document.createElement('option');
        opt.value = book.volumeId;
        const parts = [book.title, book.subtitle, book.editor].filter(Boolean);
        opt.textContent = `${parts.join(' — ')} (${book.volumeId})`;
        volumeField.appendChild(opt);
      }
      volumeField.disabled = false;
    } catch (err) {
      if (requestId !== hubSyncRequestId) return;
      volumeField.innerHTML = `<option value="">Errore: ${err.message}</option>`;
    }
  }

  usernameField.addEventListener('input', () => {
    clearTimeout(hubSyncTimer);
    hubSyncTimer = setTimeout(syncHubBooks, 450);
  });
  passwordField.addEventListener('input', () => {
    clearTimeout(hubSyncTimer);
    hubSyncTimer = setTimeout(syncHubBooks, 450);
  });
  platformField.addEventListener('change', () => {
    clearTimeout(hubSyncTimer);
    hubSyncTimer = setTimeout(syncHubBooks, 150);
  });

  syncHubBooks();
}

/* ─── Zanichelli books loader ─── */
let zanSyncTimer = null;
let zanLastCredentialsKey = '';
let zanSyncRequestId = 0;
function setupZanichelliBookLoader() {
  clearTimeout(zanSyncTimer);

  const usernameField = document.getElementById('field-username');
  const passwordField = document.getElementById('field-password');
  const isbnField = document.getElementById('field-isbn');

  if (!usernameField || !passwordField || !isbnField) return;

  async function syncZanBooks() {
    clearTimeout(zanSyncTimer);

    const username = usernameField.value?.trim();
    const password = passwordField.value?.trim();

    if (!username || !password) {
      zanLastCredentialsKey = '';
      isbnField.innerHTML = '<option value="">Inserisci email e password</option>';
      isbnField.disabled = true;
      return;
    }

    const credentialsKey = `${username}::${password}`;
    if (credentialsKey === zanLastCredentialsKey) return;

    zanLastCredentialsKey = credentialsKey;
    const requestId = ++zanSyncRequestId;

    isbnField.innerHTML = '<option value="">Caricamento libri...</option>';
    isbnField.disabled = true;

    try {
      const res = await fetch('/api/zanichelli-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();
      if (requestId !== zanSyncRequestId) return;

      if (!res.ok) {
        isbnField.innerHTML = `<option value="">${data.error || 'Errore di caricamento'}</option>`;
        return;
      }

      if (!Array.isArray(data.books) || data.books.length === 0) {
        isbnField.innerHTML = '<option value="">Nessun libro trovato</option>';
        return;
      }

      isbnField.innerHTML = '<option value="">Seleziona un libro</option>';
      for (const book of data.books) {
        const opt = document.createElement('option');
        opt.value = book.isbn;
        opt.textContent = `${book.title} (${book.isbn})`;
        isbnField.appendChild(opt);
      }
      isbnField.disabled = false;
    } catch (err) {
      if (requestId !== zanSyncRequestId) return;
      isbnField.innerHTML = `<option value="">Errore: ${err.message}</option>`;
    }
  }

  usernameField.addEventListener('input', () => {
    clearTimeout(zanSyncTimer);
    zanSyncTimer = setTimeout(syncZanBooks, 450);
  });
  passwordField.addEventListener('input', () => {
    clearTimeout(zanSyncTimer);
    zanSyncTimer = setTimeout(syncZanBooks, 450);
  });

  syncZanBooks();
}

/* ─── Bsmart books loader ─── */
let bsmartSyncTimer = null;
let bsmartLastCredentialsKey = '';
let bsmartSyncRequestId = 0;
function setupBsmartBookLoader() {
  clearTimeout(bsmartSyncTimer);

  const siteField = document.getElementById('field-site');
  const usernameField = document.getElementById('field-username');
  const passwordField = document.getElementById('field-password');
  const bookIdField = document.getElementById('field-bookId');

  if (!siteField || !usernameField || !passwordField || !bookIdField) return;

  async function syncBsmartBooks() {
    clearTimeout(bsmartSyncTimer);

    const site = siteField.value?.trim();
    const username = usernameField.value?.trim();
    const password = passwordField.value?.trim();

    if (!site || !username || !password) {
      bsmartLastCredentialsKey = '';
      bookIdField.innerHTML = '<option value="">Inserisci sito, email e password</option>';
      bookIdField.disabled = true;
      return;
    }

    const credentialsKey = `${site}::${username}::${password}`;
    if (credentialsKey === bsmartLastCredentialsKey) return;

    bsmartLastCredentialsKey = credentialsKey;
    const requestId = ++bsmartSyncRequestId;

    bookIdField.innerHTML = '<option value="">Caricamento libri...</option>';
    bookIdField.disabled = true;

    try {
      const res = await fetch('/api/bsmart-books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, username, password })
      });

      const data = await res.json();
      if (requestId !== bsmartSyncRequestId) return;

      if (!res.ok) {
        bookIdField.innerHTML = `<option value="">${data.error || 'Errore di caricamento'}</option>`;
        return;
      }

      if (!Array.isArray(data.books) || data.books.length === 0) {
        bookIdField.innerHTML = '<option value="">Nessun libro trovato</option>';
        return;
      }

      bookIdField.innerHTML = '<option value="">Seleziona un libro</option>';
      for (const book of data.books) {
        const opt = document.createElement('option');
        opt.value = book.bookId;
        opt.textContent = `${book.title} (${book.bookId})`;
        bookIdField.appendChild(opt);
      }
      bookIdField.disabled = false;
    } catch (err) {
      if (requestId !== bsmartSyncRequestId) return;
      bookIdField.innerHTML = `<option value="">Errore: ${err.message}</option>`;
    }
  }

  siteField.addEventListener('change', () => {
    clearTimeout(bsmartSyncTimer);
    bsmartSyncTimer = setTimeout(syncBsmartBooks, 150);
  });
  usernameField.addEventListener('input', () => {
    clearTimeout(bsmartSyncTimer);
    bsmartSyncTimer = setTimeout(syncBsmartBooks, 450);
  });
  passwordField.addEventListener('input', () => {
    clearTimeout(bsmartSyncTimer);
    bsmartSyncTimer = setTimeout(syncBsmartBooks, 450);
  });

  syncBsmartBooks();
}

/* ─── WebSocket ─── */
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    appendTerminal('Connesso al server.\n', 'muted');
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'started':
        setRunning(true);
        setProgress(3, 'running', 'Download in preparazione', 'Connessione al provider in corso');
        appendTerminal(msg.text, 'blue');
        break;
      case 'stdout':
        updateProgressFromLog(msg.text);
        appendTerminal(msg.text, 'normal');
        break;
      case 'stderr':
        updateProgressFromLog(msg.text);
        appendTerminal(msg.text, 'stderr');
        break;
      case 'done':
        setRunning(false);
        if (msg.code === 0) {
          setProgress(100, 'done', 'Completato', 'Il file è pronto al download');
        } else {
          setProgress(progressValue, 'error', 'Errore', 'Download terminato con errori');
        }
        appendTerminal(msg.text, msg.code === 0 ? 'green' : 'red');
        break;
      case 'file': {
        const safeUrl = getSafeDownloadUrl(msg?.url);
        if (!safeUrl) {
          appendTerminal('\n⚠️ URL download non valido.\n', 'stderr');
          break;
        }

        configureDownloadButton(msg, safeUrl);
        const link = document.createElement('a');
        link.href = safeUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        if (msg.name) link.download = msg.name;
        link.textContent = `\n📄 Download pronto: ${msg.name} — clicca per aprire\n`;
        link.style.color = '#4ade80';
        link.style.display = 'block';
        terminal.appendChild(link);
        terminal.scrollTop = terminal.scrollHeight;
        setProgress(100, 'done', 'Download pronto', msg.name || 'File pronto');
        notifyDownloadReady(msg.name, safeUrl);
        break;
      }
      case 'stopped':
        setRunning(false);
        setProgress(progressValue, 'stopped', 'Interrotto', 'Download interrotto manualmente');
        appendTerminal(msg.text, 'yellow');
        break;
      case 'error':
        setRunning(false);
        setProgress(progressValue, 'error', 'Errore', 'Si è verificato un problema durante il download');
        appendTerminal(msg.text, 'stderr');
        break;
    }
  };

  ws.onclose = () => {
    appendTerminal('\nConnessione chiusa. Ricarica la pagina per riconnetterti.\n', 'muted');
    setRunning(false);
  };

  ws.onerror = () => {
    appendTerminal('\nErrore WebSocket.\n', 'stderr');
  };
}

/* ─── Start download ─── */
downloadFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedProvider || !ws || ws.readyState !== WebSocket.OPEN) return;

  const formData = new FormData(downloadFormEl);
  const options = {};
  for (const [k, v] of formData.entries()) {
    if (v) options[k] = v;
  }

  terminal.textContent = '';
  resetDownloadButton();
  progressValue = 0;
  lastHeuristicProgressTick = 0;
  setProgress(2, 'running', 'Download avviato', 'Preparazione richiesta');
  ws.send(JSON.stringify({ type: 'start', provider: selectedProvider, options }));
});

/* ─── Stop ─── */
stopBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
});

/* ─── Clear terminal ─── */
clearBtn.addEventListener('click', () => {
  terminal.textContent = '';
});

/* ─── Helpers ─── */
function setRunning(state) {
  running = state;
  startBtn.disabled = state;
  stopBtn.classList.toggle('hidden', !state);
  progressSection.classList.remove('hidden');
}

function appendTerminal(text, style) {
  const span = document.createElement('span');

  if (style === 'stderr' || style === 'red') {
    span.className = 't-red';
  } else if (style === 'green') {
    span.className = 't-green';
  } else if (style === 'yellow') {
    span.className = 't-yellow';
  } else if (style === 'blue') {
    span.className = 't-blue';
  } else if (style === 'muted') {
    span.className = 't-muted';
  }

  span.textContent = text;
  terminal.appendChild(span);
  terminal.scrollTop = terminal.scrollHeight;
}

function updateCliVisibility() {
  const visible = Boolean(cliToggle?.checked);
  terminalSection.classList.toggle('hidden', !visible);
}

function setProgress(percent, status, label, hint) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  progressValue = Math.max(progressValue, safePercent);
  if (status === 'idle') progressValue = safePercent;

  progressFill.style.width = `${progressValue}%`;
  progressPercent.textContent = `${Math.round(progressValue)}%`;
  progressLabel.textContent = label;
  progressHint.textContent = hint;
  progressBadge.textContent =
    status === 'running' ? 'In corso' :
    status === 'done' ? 'Completato' :
    status === 'error' ? 'Errore' :
    status === 'stopped' ? 'Interrotto' :
    'In attesa';
  progressBadge.className = `status-pill ${status}`;
  progressTrack?.setAttribute('aria-valuenow', String(Math.round(progressValue)));
}

function updateProgressFromLog(text) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const normalized = line.replace(/,/g, '.');

    const percentMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      const percent = Number(percentMatch[1]);
      if (Number.isFinite(percent)) {
        setProgress(percent, 'running', 'Download in corso', 'Avanzamento stimato dai log');
      }
      continue;
    }

    const slashMatch = normalized.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (slashMatch) {
      const current = Number(slashMatch[1]);
      const total = Number(slashMatch[2]);
      const ratio = calculateProgressRatio(current, total);
      if (ratio !== null) setProgress(ratio, 'running', 'Download in corso', `Passo ${current} di ${total}`);
      continue;
    }

    const ofMatch = normalized.match(/\b(\d+)\s+of\s+(\d+)\b/i);
    if (ofMatch) {
      const current = Number(ofMatch[1]);
      const total = Number(ofMatch[2]);
      const ratio = calculateProgressRatio(current, total);
      if (ratio !== null) setProgress(ratio, 'running', 'Download in corso', `Passo ${current} di ${total}`);
      continue;
    }

    if (LOG_PATTERNS.completedStage.test(normalized)) {
      setProgress(98, 'running', 'Finalizzazione', 'Composizione file finale');
      continue;
    }

    if (LOG_PATTERNS.activeStage.test(normalized)) {
      const now = Date.now();
      if (now - lastHeuristicProgressTick >= HEURISTIC_PROGRESS_THROTTLE_MS) {
        lastHeuristicProgressTick = now;
        setProgress(Math.min(progressValue + HEURISTIC_PROGRESS_INCREMENT, HEURISTIC_PROGRESS_MAX), 'running', 'Download in corso', 'Elaborazione pagine');
      }
    }
  }
}

function calculateProgressRatio(current, total) {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0 || current < 0) return null;
  return (current / total) * 100;
}

function resetDownloadButton() {
  if (!downloadBtn) return;
  downloadBtn.classList.add('hidden');
  downloadBtn.removeAttribute('href');
  downloadBtn.removeAttribute('download');
}

function configureDownloadButton(msg, safeUrl) {
  if (!downloadBtn || !safeUrl) return;
  downloadBtn.href = safeUrl;
  if (msg.name) {
    downloadBtn.download = msg.name;
  } else {
    downloadBtn.removeAttribute('download');
  }
  downloadBtn.classList.remove('hidden');
}

function getSafeDownloadUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  if (rawUrl.length > MAX_DOWNLOAD_URL_LENGTH) return null;
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    if (!parsed.pathname.startsWith('/downloads/')) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

async function notifyDownloadReady(fileName, fileUrl) {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (Notification.permission !== 'granted') return;

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('ourbooks', {
      body: fileName ? `Download pronto: ${fileName}` : 'Download completato',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: fileUrl || '/' }
    });
  } catch {
    /* noop */
  }
}

/* ─── Boot ─── */
init();