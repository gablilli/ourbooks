import yargs from 'yargs';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { loginSanoma, getBookCatalog, fetchBookAccess } from './src/sanoma/auth.js';

function findPdfUrlInMaster(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (typeof node.pdf === 'string' && node.pdf) {
    return node.pdf;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPdfUrlInMaster(item, seen);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findPdfUrlInMaster(value, seen);
    if (found) return found;
  }

  return null;
}

export async function run(options = {}) {
  const argv = yargs(process.argv.slice(2))
    .option('id',       { alias: 'i', type: 'string', description: 'user id (email)' })
    .option('password', { alias: 'p', type: 'string', description: 'user password' })
    .option('gedi',     { alias: 'g', type: 'string', description: "book's gedi" })
    .option('output',   { alias: 'o', type: 'string', description: 'Output file' })
    .help()
    .argv;

  const { id, password, gedi } = options;

  console.log("Avvio provider Sanoma...");

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

  function promisify(api) {
    return function (...args) {
      return new Promise((resolve, reject) => {
        api(...args, (err, response) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    };
  }

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

    const masterUrl = `${bookAccess.baseUrl}/assets/book/data/master.json?t=${Date.now()}`;
    console.log('Fetching book metadata...');

    const masterRes = await fetch(masterUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Cookie': bookAccess.cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!masterRes.ok) {
      console.error(`master.json request failed: HTTP ${masterRes.status}`);
      process.exit(1);
    }

    const master = await masterRes.json();
    const pdfUrl = findPdfUrlInMaster(master);

    if (!pdfUrl) {
      console.error('PDF URL not found in master.json. Response keys:', Object.keys(master));
      process.exit(1);
    }

    console.log('PDF URL found:', pdfUrl);

    let baseName = argv.output || options.output;
    if (!baseName) baseName = targetBookName.replace(/[\\/:*?"<>|]/g, '') + '.pdf';
    const outFilePath = path.join(outputDir, baseName);

    console.log('Downloading "' + targetBookName + '"...');

    const pdfRes = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!pdfRes.ok) {
      console.error(`PDF download failed: HTTP ${pdfRes.status}`);
      process.exit(1);
    }

    const totalBytes = parseInt(pdfRes.headers.get('content-length'), 10);
    let downloadedBytes = 0;
    let lastLoggedPercent = 0;

    pdfRes.body.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent >= lastLoggedPercent + 10) {
          process.stdout.write(`...${percent}%`);
          lastLoggedPercent = percent;
        }
      }
    });

    await promisify(pipeline)(pdfRes.body, fs.createWriteStream(outFilePath));
    console.log('\nDownload completato!');

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