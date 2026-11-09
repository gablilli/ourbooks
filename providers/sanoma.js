import yargs from 'yargs';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

import {
  loginSanoma,
  getBookCatalog,
  fetchBookAccess
} from './src/sanoma/auth.js';

import {
  getPageNumbers,
  getRequestedPages
} from './src/sanoma/parser.js';

import { createPdf } from './src/sanoma/create-pdf.js';
import { runPageWorker } from './src/sanoma/workers.js';

export async function run(options = {}) {
  const argv = yargs(process.argv.slice(2))
    .option('id', {
      alias: 'i',
      type: 'string',
      description: 'user id (email)'
    })
    .option('password', {
      alias: 'p',
      type: 'string',
      description: 'user password'
    })
    .option('gedi', {
      alias: 'g',
      type: 'string',
      description: "book's gedi"
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output file'
    })
    .option('pages', {
      type: 'string',
      description: 'Pages to download, e.g. 1-10,15'
    })
    .help()
    .argv;

  console.log('Avvio provider Sanoma...');

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

  let userId = options.id || argv.id;
  let userPassword = options.password || argv.password;
  let bookGedi = options.gedi || argv.gedi;

  if (!userId) {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'id',
        message: 'Email Sanoma:'
      }
    ]);
    userId = answer.id;
  }

  if (!userPassword) {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Password Sanoma:',
        mask: '*'
      }
    ]);
    userPassword = answer.password;
  }

  console.log('');

  console.log('Warning: this script might log you out of other devices');
  console.log('Logging in to MyPlace...');

  let skClient;

  try {
    skClient = await loginSanoma(userId, userPassword);
  } catch (err) {
    throw new Error(`Failed to log in: ${err.message}`);
  }

  console.log('Login effettuato.');
  console.log('Fetching book list...');

  const catalog = await getBookCatalog(skClient);

  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('Nessun libro trovato nel catalogo Sanoma.');
  }

  const table = catalog.map((product, index) => ({
    '#': index + 1,
    'Titolo': product.name || '',
    'GEDI': product.gedi || ''
  }));

  console.log('');
  console.log('Books (MyPlace):');
  console.table(table);

  if (!bookGedi) {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedBook',
        message: 'Seleziona libro:',
        choices: catalog.map(product => ({
          name: `${product.name} [GEDI: ${product.gedi}]`,
          value: String(product.gedi)
        }))
      }
    ]);

    bookGedi = answer.selectedBook;
  }

  const selectedProduct = catalog.find(
    product => String(product.gedi) === String(bookGedi)
  );

  if (!selectedProduct) {
    throw new Error(`Libro con GEDI ${bookGedi} non trovato nel catalogo.`);
  }

  const targetBookName =
    selectedProduct.name || `GEDI ${bookGedi}`;

  console.log('');
  console.log(
    `Obtaining access credentials for "${targetBookName}"...`
  );

  let bookAccess;

  try {
    bookAccess = await fetchBookAccess(
      skClient,
      bookGedi,
      selectedProduct.placeUrl
    );
  } catch (err) {
    throw new Error(
      `Failed to obtain book access: ${err.message}`
    );
  }

  const baseUrl = bookAccess.baseUrl;

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'identity',
    'Cookie': bookAccess.cookieHeader,
    'Referer': 'https://npmitaly-pro-apidistribucion.sanoma.it/viewers/lm60/online/index.html',
    'Origin': 'https://npmitaly-pro-apidistribucion.sanoma.it',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) ' +
      'Gecko/20100101 Firefox/154.0',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-GPC': '1'
  };

  const masterUrl =
    `${baseUrl}/assets/book/data/master.json?t=${Date.now()}`;

  console.log('Fetching book metadata...');

  const masterRes = await fetch(masterUrl, { headers });

  if (!masterRes.ok) {
    throw new Error(
      `master.json request failed: HTTP ${masterRes.status}`
    );
  }

  const master = await masterRes.json();

  const allPages = getPageNumbers(master);

  const requestedPages = getRequestedPages(
    allPages,
    options.pages || argv.pages
  );

  if (!requestedPages.length) {
    throw new Error('No pages found.');
  }

  console.log(`Found ${allPages.length} pages.`);

  console.log(
    `Downloading ${requestedPages.length} page(s) sequentially...`
  );

  const pages = requestedPages.map(pageNumber => ({
    pageNumber,
    baseUrl: `${baseUrl}/assets/book`
  }));

  let baseName =
    options.output ||
    argv.output;

  if (!baseName) {
    baseName =
      targetBookName.replace(/[\/:*?"<>|]/g, '') +
      '.pdf';
  }

  if (!baseName.toLowerCase().endsWith('.pdf')) {
    baseName += '.pdf';
  }

  const outFilePath = path.join(
    outputDir,
    baseName
  );

  fs.mkdirSync(
    outputDir,
    { recursive: true }
  );

  console.log('');

  console.log(
    `Creating PDF: ${outFilePath}`
  );

  await createPdf(
    outFilePath,
    pages,
    headers
  );

  if (!fs.existsSync(outFilePath)) {
    throw new Error(
      `PDF non creato: ${outFilePath}`
    );
  }

  const stats = fs.statSync(outFilePath);

  if (stats.size === 0) {
    throw new Error(
      `PDF vuoto: ${outFilePath}`
    );
  }

  console.log('');

  console.log(
    `Download pronto: ${path.basename(outFilePath)} - clicca per aprire`
  );

  console.log(
    `Done. Output: ${outFilePath}`
  );

  console.log(
    `OURBOOKS_OUTPUT:${outFilePath}`
  );
}

if (process.env.OURBOOKS_SANOMA_PAGE_WORKER === '1') {
  process.on('uncaughtException', error => {
    console.error('Errore fatale worker Sanoma:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', error => {
    console.error('Promise non gestita worker Sanoma:', error);
    process.exit(1);
  });

  runPageWorker().catch(error => {
    console.error('Errore worker Sanoma:', error);
    process.exit(1);
  });
}
