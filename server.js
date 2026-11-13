import express from 'express';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { performBsmartLogin, getBooks, getUserInfo } from './providers/src/bsmart/api.js';
import {
  loginSanoma,
  getBookCatalog
} from './providers/src/sanoma/auth.js';
import { createSession } from './providers/src/zanichelli/login.js';
import { getUser, listBooks } from './providers/src/zanichelli/catalog.js';
import { normalizePlatform, hubInternalLogin } from './providers/src/hubscuola/auth.js';
import { fetchHubLibrary } from './providers/src/hubscuola/library.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const app = express();

// set this one if you're ona reverse proxy or paas
// otherwise the rate limit is useless
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

app.use(express.json());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste, riprova tra qualche minuto.' },
});

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/downloads', staticLimiter, express.static(DOWNLOADS_DIR));
app.use(staticLimiter, express.static(path.join(__dirname, 'ui')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const PROVIDERS = {
  sanoma: {
    label: 'Sanoma',
    emoji: '📙',
    fields: [
      { name: 'id', label: 'Email account', type: 'text', required: true, placeholder: 'user@email.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' },
      { name: 'gedi', label: 'GEDI libro', type: 'select', required: true, placeholder: 'Es: 123456', dynamicOptions: true },
      { name: 'output', label: 'Nome file output', type: 'text', required: false, placeholder: 'libro.pdf' },
    ]
  },
  hubscuola: {
    label: 'HubScuola',
    emoji: '📘',
    fields: [
      { name: 'username', label: 'Email account', type: 'text', required: true, placeholder: 'user@email.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' },
      { name: 'platform', label: 'Piattaforma', type: 'select', required: true, options: ['hubyoung', 'hubkids'] },
      { name: 'volumeId', label: 'Libro', type: 'select', required: true, dynamicOptions: true },
      { name: 'file', label: 'Nome file output', type: 'text', required: false, placeholder: 'libro.pdf' },
      { name: 'annotations', label: 'Scarica e integra Annotazioni', type: 'checkbox', required: false },
    ]
  },
  dibooklaterza: {
    label: 'Laterza',
    emoji: '📗',
    fields: [
      { name: 'username', label: 'Email account', type: 'text', required: true, placeholder: 'user@email.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' },
      { name: 'isbn', label: 'Libro', type: 'select', required: true, placeholder: 'Seleziona un libro', dynamicOptions: true },
      { name: 'output', label: 'Nome file output', type: 'text', required: false, placeholder: 'libro.pdf' },
    ]
  },
  zanichelli: {
    label: 'Zanichelli',
    emoji: '📕',
    fields: [
      { name: 'username', label: 'Email account', type: 'text', required: true, placeholder: 'user@email.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' },
      { name: 'isbn', label: 'Libro', type: 'select', required: true, placeholder: 'Seleziona un libro', dynamicOptions: true },
    ]
  },
  bsmart: {
    label: 'Bsmart / Digibook24',
    emoji: '📔',
    fields: [
      { name: 'site', label: 'Sito', type: 'select', required: true, options: ['bsmart', 'digibook24'] },
      { name: 'username', label: 'Email account', type: 'text', required: true, placeholder: 'user@email.com' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' },
      { name: 'bookId', label: 'Libro', type: 'select', required: true, placeholder: 'Seleziona un libro', dynamicOptions: true },
      { name: 'annotations', label: 'Scarica e integra Annotazioni', type: 'checkbox', required: false },
    ]
  }
};

app.get('/api/providers.js', staticLimiter, (req, res) => {
  res.json(PROVIDERS);
});

app.post('/api/dibooklaterza-books', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    res.status(400).json({ error: 'Campi richiesti: username, password' });
    return;
  }

  try {
    const loginRes = await fetch('https://api.dibooklaterza.it/api/identity/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!loginRes.ok) {
      res.status(401).json({ error: 'Login fallito: credenziali non valide' });
      return;
    }

    const loginData = await loginRes.json();
    const jwt = loginData.jwt;
    const laterzaUserId = loginData.laterzaUserId;

    if (!jwt || !laterzaUserId) {
      res.status(401).json({ error: 'Login fallito: risposta non valida' });
      return;
    }

    const booksRes = await fetch(`https://api.dibooklaterza.it/api/management/books/${laterzaUserId}`, {
      headers: { 'Authorization': `Bearer ${jwt}` }
    });

    if (!booksRes.ok) {
      res.status(502).json({ error: 'Impossibile recuperare i libri' });
      return;
    }

    const booksData = await booksRes.json();
    const libreriaCategory = (booksData.categories || []).find(c => c.name?.toLowerCase() === 'libreria');

    if (!libreriaCategory) {
      res.status(404).json({ error: "Categoria 'libreria' non trovata" });
      return;
    }

    const books = (booksData.books || [])
      .filter(b => b.category === libreriaCategory.id && b.permitDownload && b.existPdf)
      .map(b => ({ isbn: b.identifier, title: b.title, authors: b.originalAuthors }));

    res.status(200).json({ books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sanoma-gedi', loginLimiter, async (req, res) => {
  const { id, password } = req.body || {};

  if (!id || !password) {
    res.status(400).json({ error: "Campi richiesti: id, password" });
    return;
  }

  try {
    const client = await loginSanoma(id, password);
    const catalog = await getBookCatalog(client);

    const books = catalog.map(book => ({
      gedi: book.gedi,
      name: book.name
    }));

    res.status(200).json({
      success: true,
      books
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hubscuola-books', loginLimiter, async (req, res) => {
  const { username, password, platform } = req.body || {};

  if (!username || !password || !platform) {
    res.status(400).json({ error: 'Campi richiesti: username, password, platform' });
    return;
  }

  try {
    const { tokenId, normalizedPlatform } = await hubInternalLogin({ username, password, platform });
    const books = await fetchHubLibrary(tokenId, normalizedPlatform);
    res.status(200).json({ tokenId, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bsmart-books', loginLimiter, async (req, res) => {
  const { site, username, password } = req.body || {};
  if (!site || !username || !password) {
    return res.status(400).json({ error: 'Campi richiesti: site, username, password' });
  }

  const baseSite = site === "bsmart" ? "www.bsmart.it" : "www.digibook24.com";

  try {
    const finalCookie = await performBsmartLogin(baseSite, username, password);
    const cookieHeaders = { cookie: `_bsw_session_v1_production=${finalCookie}` };
    const user = await getUserInfo(baseSite, cookieHeaders);
    const headers = { 'auth_token': user.auth_token };

    let books = await getBooks(baseSite, headers);

    // Convert to useful structure
    const bookList = books.map(b => ({
      bookId: b.id,
      title: b.title
    }));

    res.status(200).json({ books: bookList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/zanichelli-books', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Campi richiesti: username, password' });
  }

  try {
    const session = await createSession(username, password);
    await getUser(session);
    const books = await listBooks(session);
    res.status(200).json({
      books: Object.entries(books).map(([isbn, b]) => ({ isbn, title: b.title })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const activeProcesses = new Map();

wss.on('connection', (ws) => {
  let activeProcess = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === 'start') {
      const { provider, options } = msg;

      if (!PROVIDERS[provider]) {
        ws.send(JSON.stringify({ type: 'error', text: 'Provider non valido.' }));
        return;
      }

      if (activeProcess) {
        ws.send(JSON.stringify({ type: 'error', text: 'Un processo è già in esecuzione.' }));
        return;
      }

      /* Validate that option keys are known fields for this provider */
      const knownFields = new Set(PROVIDERS[provider].fields.map(f => f.name));
      const safeOptions = {};
      for (const [key, value] of Object.entries(options || {})) {
        if (!knownFields.has(key)) continue;
        const str = String(value);
        /* Reject values that contain shell metacharacters */
        if (/[\r\n\0]/.test(str)) continue;
        safeOptions[key] = str;
      }

      const args = ['cli.js', '--provider', provider];


      // In container/cloud we prefer system pdftk over bundled jar for Laterza.
      if (provider === 'dibooklaterza') {
        args.push('--useSystemExecutable');
      }

      for (const [key, value] of Object.entries(safeOptions)) {
        if (value !== '') {
          if (value === 'on') {
            args.push(`--${key}`);
          } else {
            args.push(`--${key}`, value);
          }
        }
      }

      const sessionId = randomUUID();
      const sessionDownloadDir = path.join(DOWNLOADS_DIR, sessionId);
      fs.mkdirSync(sessionDownloadDir, { recursive: true });

      ws.send(JSON.stringify({ type: 'started', text: `▶ Avvio provider: ${provider}\n` }));

      activeProcess = spawn('node', args, {
        cwd: __dirname,
        env: {
          ...process.env,
          OURBOOKS_SESSION_ID: sessionId,
          OURBOOKS_OUTPUT_DIR: sessionDownloadDir,
          OURBOOKS_SESSION_TMP: path.join(__dirname, 'tmp', sessionId),
        }
      });

      activeProcesses.set(ws, activeProcess);

      activeProcess.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        const match = text.match(/OURBOOKS_OUTPUT:(.+)/);
        if (match) {
          const fileName = path.basename(match[1].trim());
          ws.send(JSON.stringify({ type: 'file', url: `/downloads/${sessionId}/${fileName}`, name: fileName }));
        }
        const filtered = text.split('\n').filter(l => !l.startsWith('OURBOOKS_OUTPUT:')).join('\n');
        if (filtered) ws.send(JSON.stringify({ type: 'stdout', text: filtered }));
      });

      activeProcess.stderr.on('data', (chunk) => {
        ws.send(JSON.stringify({ type: 'stderr', text: chunk.toString() }));
      });

      activeProcess.on('close', (code) => {
        activeProcesses.delete(ws);
        activeProcess = null;
        ws.send(JSON.stringify({
          type: 'done',
          text: `\n✅ Processo terminato con codice ${code}\n`,
          code
        }));
      });

      activeProcess.on('error', (err) => {
        ws.send(JSON.stringify({ type: 'error', text: `\n❌ Errore: ${err.message}\n` }));
      });
    }

    if (msg.type === 'stop') {
      if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
        ws.send(JSON.stringify({ type: 'stopped', text: '\n⛔ Processo interrotto.\n' }));
      }
    }
  });

  ws.on('close', () => {
    const proc = activeProcesses.get(ws);
    if (proc) {
      proc.kill('SIGTERM');
      activeProcesses.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`📚 ourbooks UI disponibile su http://localhost:${PORT}`);
});
