import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { performBsmartLogin, getBooks, getUserInfo } from './providers/src/bsmart/api.js';
import * as sanomaProvider from './providers/sanoma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use(express.static(path.join(__dirname, 'ui')));

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

app.get('/api/providers.js', (req, res) => {
  res.json(PROVIDERS);
});

app.post('/api/dibooklaterza-books', async (req, res) => {
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

app.post('/api/sanoma-gedi', async (req, res) => {
  const { id, password } = req.body || {};

  if (!id || !password) {
    res.status(400).json({ error: "Campi richiesti: id, password" });
    return;
  }

  try {
    const rawBooks = await sanomaProvider.getBooks({ id, password });

    const bookList = [];
    for (const b of rawBooks) {
        for (const p of b.products) {
            bookList.push({
               gedi: p.id,
               name: p.name
            });
        }
    }

    res.status(200).json({ success: true, books: bookList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizePlatform(platform) {
  return platform === "hubkids" ? "kids" : "young";
}

async function readJsonLoose(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return { rawText: text };
      }
    }
    return { rawText: text };
  }
}

async function hubscuolaInternalLogin({ username, password, platform }) {
  const normalizedPlatform = normalizePlatform(platform);

  const credentialsPayload = {
    idSito: "ED",
    username,
    password,
    rememberMe: false,
    domain: "hubscuola",
    gRecaptchaResponse: "",
    verifyRecaptcha: false,
    addFullProfile: true,
    addHubEncryptedUser: true,
    refreshLocalData: true,
    activatePromos: true,
  };

  const commonHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.hubscuola.it",
    "Referer": "https://www.hubscuola.it/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Priority": "u=0",
    "TE": "trailers",
    "Connection": "keep-alive",
  };

  async function performHubLogin(useWrappedBody = false) {
    const body = useWrappedBody
      ? JSON.stringify({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentialsPayload),
        })
      : JSON.stringify(credentialsPayload);

    const res = await fetch("https://bce.mondadorieducation.it/app/mondadorieducation/login/hubLoginJsonp", {
      method: "POST",
      headers: commonHeaders,
      body,
    });

    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: loginRes, json: loginJson } = await performHubLogin(false);

  if (
    (loginRes.ok && loginJson?.result === "ERROR" && loginJson?.errorCode === "ERRNOPAG")
    || (!loginRes.ok)
  ) {
    ({ res: loginRes, json: loginJson } = await performHubLogin(true));
  }

  if (!loginRes.ok || loginJson?.result !== "OK") {
    const msg = loginJson?.message || loginJson?.error || `Hub login failed (${loginRes.status})`;
    throw new Error(msg);
  }

  const loginData = loginJson?.data || {};
  const loginToken = loginData?.loginToken;
  if (!loginToken) {
    throw new Error("loginToken non presente nella risposta hubLoginJsonp");
  }

  const hubEncryptedUser = loginData?.hubEncryptedUser || "";
  const loginSessionId = loginData?.sessionId || "";

  const appOrigin = `https://${normalizedPlatform}.hubscuola.it`;

  const internalHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": appOrigin,
    "Referer": `${appOrigin}/`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Connection": "keep-alive",
    "TE": "trailers",
  };

  function decodeJwtPayload(token) {
    try {
      const part = token.split(".")[1];
      if (!part) return {};
      const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return {};
    }
  }

  const decodedUser = hubEncryptedUser ? decodeJwtPayload(hubEncryptedUser) : {};
  const decodedLoginToken = decodeJwtPayload(loginToken);

  const resolvedUsername =
    decodedLoginToken?.username
    || decodedUser?.username
    || username;

  const resolvedSessionId =
    loginSessionId
    || decodedLoginToken?.sessionId
    || "";

  if (!resolvedSessionId) {
    throw new Error("sessionId non presente nella risposta hubLoginJsonp");
  }

  const resolvedEmail =
    decodedLoginToken?.email
    || decodedUser?.email
    || username;

  const resolvedFirstName =
    decodedLoginToken?.nome
    || decodedUser?.firstName
    || decodedUser?.name
    || "";

  const resolvedLastName =
    decodedLoginToken?.cognome
    || decodedUser?.lastName
    || decodedUser?.surname
    || "";

  const resolvedType =
    decodedLoginToken?.tipoUtente
    || decodedUser?.type
    || "studente";

  const resolvedUserId =
    String(decodedLoginToken?.idUtente || decodedUser?.id || decodedUser?.userId || "");

  const internalPayloadPrimary = {
    jwt: hubEncryptedUser,
    sessionId: resolvedSessionId,
    userData: decodedUser,
    app: {
      name: normalizedPlatform === "kids" ? "HUB Kids" : "HUB Young",
      type: normalizedPlatform,
      version: "7.6",
    },
    browser: {
      major: "148",
      name: "Firefox",
      version: "148.0",
      platform: "web",
    },
    so: {
      name: "Mac OS",
      version: "10.15",
    },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    username: resolvedUsername,
  };

  const internalPayloadLegacy = {
    username: resolvedUsername,
    email: resolvedEmail,
    type: resolvedType,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    tokenId: loginToken,
    appData: {
      name: normalizedPlatform === "kids" ? "Hub Kids" : "Hub Young",
      id: normalizedPlatform,
      version: "7.6",
    },
    id: resolvedUserId,
    role: decodedUser?.role || "user",
  };

  async function doInternalLogin(payload) {
    const res = await fetch("https://ms-api.hubscuola.it/user/internalLogin", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(payload),
    });
    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadPrimary);

  if (!internalRes.ok) {
    ({ res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadLegacy));
  }

  if (!internalRes.ok) {
    const msg = internalJson?.message || internalJson?.error || internalJson?.response || `internalLogin failed (${internalRes.status})`;
    console.error("[internalLogin] errore", {
      status: internalRes.status,
      statusText: internalRes.statusText,
      platform: normalizedPlatform,
      username,
      resolvedUsername,
      resolvedSessionIdPreview: resolvedSessionId ? `${resolvedSessionId.slice(0, 12)}...` : "",
      jwtPreview: loginToken ? `${loginToken.slice(0, 16)}...` : "",
      loginSessionIdPreview: loginSessionId ? `${String(loginSessionId).slice(0, 12)}...` : "",
      sentPayload: JSON.stringify(internalPayloadPrimary),
    });
    throw new Error(msg);
  }

  const tokenId = internalJson?.tokenId || internalJson?.data?.tokenId || internalJson?.session?.tokenId || internalJson?.response?.tokenId;
  if (!tokenId) {
    throw new Error("tokenId non presente nella risposta internalLogin");
  }

  return { tokenId, normalizedPlatform };
}

app.post('/api/hubscuola-books', async (req, res) => {
  const { username, password, platform } = req.body || {};

  if (!username || !password || !platform) {
    res.status(400).json({ error: 'Campi richiesti: username, password, platform' });
    return;
  }

  try {
    const { tokenId, normalizedPlatform } = await hubscuolaInternalLogin({ username, password, platform });

    const booksRes = await fetch(
      `https://ms-api.hubscuola.it/getLibrary/${normalizedPlatform}?version=7.6&platform=web&app=v2`,
      {
        headers: {
          'Token-Session': tokenId,
          'Accept': 'application/json'
        }
      }
    );

    const booksJson = await booksRes.json().catch(() => []);

    if (!booksRes.ok) {
      const msg = booksJson?.message || booksJson?.error || `Errore libreria HubScuola (${booksRes.status})`;
      res.status(booksRes.status).json({ error: msg });
      return;
    }

    const rawBooks = Array.isArray(booksJson) ? booksJson : (booksJson?.data || []);
    const books = rawBooks
      .filter((b) => b && (b.id || b.volumeId))
      .map((b) => ({
        volumeId: String(b.id || b.volumeId),
        title: b.title || b.name || `Libro ${b.id || b.volumeId}`,
        subtitle: b.subtitle || '',
        editor: b.editor || ''
      }));

    res.status(200).json({ tokenId, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bsmart-books', async (req, res) => {
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

app.post('/api/zanichelli-books', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Campi richiesti: username, password' });
  }

  try {
    const loginRes = await fetch("https://idp.zanichelli.it/v4/login/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });
    
    if (!loginRes.ok) {
        return res.status(401).json({ error: 'Login fallito: credenziali non valide' });
    }

    const loginData = await loginRes.json();
    const token = loginData.token;
    if (!token) {
        return res.status(401).json({ error: 'Login fallito: token mancante' });
    }

    const cookie = `token=${token}`;
    const myZanichelliRes = await fetch("https://my.zanichelli.it/?loginMode=myZanichelli", {
      headers: { cookie },
    });
    
    const setCookieHeader = (myZanichelliRes.headers.raw ? myZanichelliRes.headers.raw()['set-cookie'] : myZanichelliRes.headers.getSetCookie()) || [];
    const loginCookies = setCookieHeader.map(c => c.split(';')[0]);
    const dashboardCookies = {};
    for (let c of loginCookies) {
      const [key, value] = c.split('=');
      dashboardCookies[key] = value;
    }

    await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/user', {
      headers: { 'myz-token': dashboardCookies['myz_token'] },
    });

    let returnBooks = [];
    let page = 1;
    let notATeacher = false;

    while (true) {
      let r = await fetch(`https://api-catalogo.zanichelli.it/v3/dashboard/search?sort%5Bfield%5D=year_date&sort%5Bdirection%5D=desc&searchString&pageNumber=${page}&rows=100`, {
        headers: { 'myz-token': dashboardCookies['myz_token'] },
      });
      if (r.status == 403) {
        notATeacher = true;
        break;
      }
      const pData = await r.json();
      if (!pData.data || pData.data.pagination.pages == 0) break;

      for (let license of pData.data.licenses || []) {
        if (license.volume.ereader_url == '') continue;
        returnBooks.push({
            isbn: license.volume.isbn,
            title: license.volume.opera.title
        });
      }
      if (pData.data.pagination.pages == page) break;
      page++;
    }

    if (notATeacher) {
      let request = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/licenses/real', {
        headers: { 'myz-token': dashboardCookies['myz_token'] },
      });
      if (request.ok) {
          const resData = await request.json();
          for (let license of resData.realLicenses || []) {
            if (license.volume.ereader_url == '') continue;
            returnBooks.push({
                isbn: license.volume.isbn,
                title: license.volume.opera.title
            });
          }
      }
    }

    res.status(200).json({ books: returnBooks });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
