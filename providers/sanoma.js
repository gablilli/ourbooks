import yargs from 'yargs';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { loginSanoma, getBookCatalog, fetchBookAccess } from './src/sanoma/auth.js';

const DATA_KEY = '1cff42dabb60beaf1e3b57988af787246c63613ef60435a05c9c79b98a9b41c8';

function decryptLm60(body) {
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  const unescaped = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  let result = '';
  for (let i = 0; i < unescaped.length; i++) {
    const value = unescaped.charCodeAt(i);
    const key = DATA_KEY.charCodeAt((i % DATA_KEY.length) - 1);
    result += String.fromCharCode(value - key);
  }

  return result;
}

function getPageNumbers(master) {
  if (!Array.isArray(master.pages)) return [];
  return master.pages.map(page => Number(page.number)).filter(Number.isFinite);
}

function getRequestedPages(pages, value) {
  if (!value) return pages;

  const requested = new Set();

  for (const part of value.split(',')) {
    const item = part.trim();

    if (item.includes('-')) {
      const [start, end] = item.split('-').map(Number);
      for (let i = start; i <= end; i++) requested.add(i);
    } else {
      requested.add(Number(item));
    }
  }

  return pages.filter(page => requested.has(page));
}

function parsePageSize(html) {
  const match = html.match(/width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px/i);

  return {
    width: match ? parseFloat(match[1]) : 909,
    height: match ? parseFloat(match[2]) : 1242
  };
}

function parseStyles(html) {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = styleMatch ? styleMatch[1] : '';
  const styles = {};

  for (const match of css.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g)) {
    const name = match[1];
    const body = match[2];

    const left = body.match(/left:\s*([\d.]+)px/);
    const bottom = body.match(/bottom:\s*([\d.]+)px/);
    const fontSize = body.match(/font-size:\s*([\d.]+)px/);
    const letterSpacing = body.match(/letter-spacing:\s*([-\d.]+)px/);

    styles[name] = {
      left: left ? parseFloat(left[1]) : 0,
      bottom: bottom ? parseFloat(bottom[1]) : 0,
      fontSize: fontSize ? parseFloat(fontSize[1]) : 10,
      letterSpacing: letterSpacing ? parseFloat(letterSpacing[1]) : 0
    };
  }

  return styles;
}

function parseSpans(html) {
  const styles = parseStyles(html);
  const spans = [];

  for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
    const attrs = match[1];
    let text = match[2]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const classMatch = attrs.match(/class=["']([^"']+)["']/i);
    if (!classMatch || !text) continue;

    const classes = classMatch[1].split(/\s+/);
    const styleName = classes.find(name => styles[name]);
    if (!styleName) continue;

    const style = styles[styleName];

    spans.push({
      text,
      left: style.left,
      bottom: style.bottom,
      fontSize: style.fontSize,
      letterSpacing: style.letterSpacing
    });
  }

  return spans;
}

async function fetchPageData(baseUrl, pageNumber, headers) {
  const url = `${baseUrl}/pages/${pageNumber}.data`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber}: HTTP ${response.status}`);
  }

  return decryptLm60(await response.text());
}

export async function run(options = {}) {
  const argv = yargs(process.argv.slice(2))
    .option('id',       { alias: 'i', type: 'string', description: 'user id (email)' })
    .option('password', { alias: 'p', type: 'string', description: 'user password' })
    .option('gedi',     { alias: 'g', type: 'string', description: "book's gedi" })
    .option('output',   { alias: 'o', type: 'string', description: 'Output file' })
    .option('pages',    { type: 'string', description: 'Pages to download, e.g. 1-10,15' })
    .help()
    .argv;

  const { id, password, gedi } = options;

  console.log("Avvio provider Sanoma...");

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

  (async () => {
    const userId       = id       || argv.id;
    const userPassword = password || argv.password;
    const bookGedi     = gedi     || argv.gedi;

    if (!userId) {
      console.error('Errore: parametro --id mancante');
      process.exit(1);
    }
    if (!userPassword) {
      console.error('Errore: parametro --password mancante');
      process.exit(1);
    }
    if (!bookGedi) {
      console.error('Errore: parametro --gedi mancante');
      process.exit(1);
    }

    console.log('Warning: this script might log you out of other devices');

    console.log('Logging in to MyPlace...');
    const skClient = await loginSanoma(userId, userPassword).catch(err => {
      console.error('Failed to log in:', err.message);
      process.exit(1);
    });

    console.log('Fetching book list...');
    const catalog = await getBookCatalog(skClient);

    const tableObj = {};
    for (const product of catalog) {
      tableObj[product.gedi] = product.name;
    }

    console.log('Books (MyPlace):');
    console.table(tableObj);

    const selectedProduct = catalog.find((product) => String(product.gedi) === String(bookGedi));
    const targetBookName = tableObj[bookGedi] || `GEDI ${bookGedi}`;

    console.log('Obtaining access credentials for "' + targetBookName + '"...');
    const bookAccess = await fetchBookAccess(skClient, bookGedi, selectedProduct?.placeUrl).catch(err => {
      console.error('Failed to obtain book access:', err.message);
      process.exit(1);
    });

    const baseUrl = bookAccess.baseUrl;
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Cookie': bookAccess.cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const masterUrl = `${baseUrl}/assets/book/data/master.json?t=${Date.now()}`;
    console.log('Fetching book metadata...');

    const masterRes = await fetch(masterUrl, { headers });

    if (!masterRes.ok) {
      console.error(`master.json request failed: HTTP ${masterRes.status}`);
      process.exit(1);
    }

    const master = await masterRes.json();
    const allPages = getPageNumbers(master);
    const pages = getRequestedPages(allPages, argv.pages);

    if (!pages.length) {
      console.error('No pages found.');
      process.exit(1);
    }

    console.log(`Found ${allPages.length} pages.`);
    console.log(`Downloading ${pages.length} page(s)...`);

    const pageData = [];

    for (const pageNumber of pages) {
      console.log(`Fetching page ${pageNumber}...`);

      const html = await fetchPageData(baseUrl + '/assets/book', pageNumber, headers);
      const spans = parseSpans(html);
      const size = parsePageSize(html);

      pageData.push({
        pageNumber,
        width: size.width,
        height: size.height,
        spans
      });

      console.log(`Page ${pageNumber}: ${spans.length} text spans`);
    }

    let baseName = argv.output || options.output;
    if (!baseName) baseName = targetBookName.replace(/[\\/:*?"<>|]/g, '') + '.pdf';

    const outFilePath = path.join(outputDir, baseName);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      outFilePath.replace(/\.pdf$/i, '.json'),
      JSON.stringify(pageData, null, 2)
    );

    console.log('Done. Output:', outFilePath);
    console.log(`OURBOOKS_OUTPUT:${outFilePath}`);
  })();
}

export async function login(username, password) {
  try {
    await loginSanoma(username, password);
    return { id: username, password };
  } catch (err) {
    throw new Error('Login failed: ' + err.message);
  }
}

export async function getBooks(session) {
  const { id, password } = session;
  const skClient = await loginSanoma(id, password);
  const catalog = await getBookCatalog(skClient);

  return [{
    id: 'sanoma',
    name: 'Sanoma',
    products: catalog.map((product) => ({
      id: product.gedi,
      name: product.name,
      url: product.placeUrl || ''
    }))
  }];
}
