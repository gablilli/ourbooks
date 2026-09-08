import yargs from 'yargs';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { loginSanoma, getBookCatalog, fetchBookAccess } from './src/sanoma/auth.js';

const DATA_KEY = '1cff42dabb60beaf1e3b57988af787246c63613ef60435a05c9c79b98a9b41c8';

function decryptLm60(body) {
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  const unescaped = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  let result = '';

  for (let i = 0; i < unescaped.length; i++) {
    const value = unescaped.charCodeAt(i);
    const keyIndex = (i % DATA_KEY.length) - 1;
    const key = DATA_KEY.charCodeAt(keyIndex < 0 ? DATA_KEY.length - 1 : keyIndex);

    result += String.fromCharCode(value - key);
  }

  return result;
}

function getPageNumbers(master) {
  if (!Array.isArray(master.pages)) return [];

  return master.pages
    .map(page => Number(page.number))
    .filter(Number.isFinite);
}

function getRequestedPages(pages, value) {
  if (!value) return pages;

  const requested = new Set();

  for (const part of value.split(',')) {
    const item = part.trim();

    if (!item) continue;

    if (item.includes('-')) {
      const [start, end] = item.split('-').map(Number);

      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      for (let i = start; i <= end; i++) {
        requested.add(i);
      }
    } else {
      const page = Number(item);

      if (Number.isFinite(page)) {
        requested.add(page);
      }
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

    const left = body.match(/left:\s*([-\d.]+)px/);
    const bottom = body.match(/bottom:\s*([-\d.]+)px/);
    const top = body.match(/top:\s*([-\d.]+)px/);
    const fontSize = body.match(/font-size:\s*([\d.]+)px/);
    const letterSpacing = body.match(/letter-spacing:\s*([-\d.]+)px/);
    const lineHeight = body.match(/line-height:\s*([\d.]+)px/);

    styles[name] = {
      left: left ? parseFloat(left[1]) : 0,
      bottom: bottom ? parseFloat(bottom[1]) : null,
      top: top ? parseFloat(top[1]) : null,
      fontSize: fontSize ? parseFloat(fontSize[1]) : 10,
      letterSpacing: letterSpacing ? parseFloat(letterSpacing[1]) : 0,
      lineHeight: lineHeight ? parseFloat(lineHeight[1]) : null
    };
  }

  return styles;
}

function decodeHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
}

function parseSpans(html) {
  const styles = parseStyles(html);
  const spans = [];

  for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
    const attrs = match[1];
    const text = decodeHtml(match[2]);

    if (!text.trim()) continue;

    const classMatch = attrs.match(/class=["']([^"']+)["']/i);

    if (!classMatch) continue;

    const classes = classMatch[1].split(/\s+/);
    const styleName = classes.find(name => styles[name]);

    if (!styleName) continue;

    const style = styles[styleName];

    spans.push({
      text,
      left: style.left,
      bottom: style.bottom,
      top: style.top,
      fontSize: style.fontSize,
      letterSpacing: style.letterSpacing,
      lineHeight: style.lineHeight
    });
  }

  return spans;
}

function getSvgSize(svg) {
  const viewBoxMatch = svg.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  const widthMatch = svg.match(/\bwidth=["']([\d.]+)(?:px)?["']/i);
  const heightMatch = svg.match(/\bheight=["']([\d.]+)(?:px)?["']/i);

  if (viewBoxMatch) {
    return {
      width: parseFloat(viewBoxMatch[1]),
      height: parseFloat(viewBoxMatch[2])
    };
  }

  return {
    width: widthMatch ? parseFloat(widthMatch[1]) : 909,
    height: heightMatch ? parseFloat(heightMatch[1]) : 1242
  };
}

function extractSvgImages(svg) {
  const images = [];

  for (const match of svg.matchAll(/<(?:image)\b[^>]*(?:href|xlink:href)=["']([^"']+)["'][^>]*>/gi)) {
    const src = match[1];

    if (!src.startsWith('data:')) {
      images.push(src);
    }
  }

  return [...new Set(images)];
}

function replaceSvgImages(svg, replacements) {
  let result = svg;

  for (const [source, dataUri] of replacements) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    result = result.replace(
      new RegExp(`((?:href|xlink:href)=["'])${escaped}(["'])`, 'g'),
      `$1${dataUri}$2`
    );
  }

  return result;
}

function toDataUri(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function guessContentType(url) {
  const cleanUrl = url.split('?')[0].toLowerCase();

  if (cleanUrl.endsWith('.png')) return 'image/png';
  if (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanUrl.endsWith('.gif')) return 'image/gif';
  if (cleanUrl.endsWith('.webp')) return 'image/webp';

  return 'application/octet-stream';
}

function resolveAssetUrl(url, pageBaseUrl) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  return new URL(url, pageBaseUrl).toString();
}

async function fetchPageData(baseUrl, pageNumber, headers) {
  const url = `${baseUrl}/pages/${pageNumber}.data`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber} .data: HTTP ${response.status}`);
  }

  return decryptLm60(await response.text());
}

async function fetchPageSvg(baseUrl, pageNumber, headers) {
  const url = `${baseUrl}/pages/${pageNumber}/{pageNumber}.svg`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber} SVG: HTTP ${response.status}`);
  }

  return response.text();
}

async function prepareSvg(svg, pageBaseUrl, headers) {
  const imageUrls = extractSvgImages(svg);
  const replacements = [];

  for (const imageUrl of imageUrls) {
    const absoluteUrl = resolveAssetUrl(imageUrl, pageBaseUrl);

    const response = await fetch(absoluteUrl, { headers });

    if (!response.ok) {
      console.warn(`Warning: SVG image unavailable: ${absoluteUrl} HTTP ${response.status}`);
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const dataUri = toDataUri(buffer, guessContentType(absoluteUrl));

    replacements.push([imageUrl, dataUri]);
  }

  return replaceSvgImages(svg, replacements);
}

function addSelectableText(doc, page, spans) {
  if (!spans.length) return;

  doc.save();

  if (typeof doc.opacity === 'function') {
    doc.opacity(0);
  }

  for (const span of spans) {
    let y;

    if (span.bottom !== null && Number.isFinite(span.bottom)) {
      y = page.height - span.bottom - span.fontSize;
    } else if (span.top !== null && Number.isFinite(span.top)) {
      y = span.top;
    } else {
      y = 0;
    }

    const options = {
      lineBreak: false,
      continued: false
    };

    if (span.letterSpacing) {
      options.characterSpacing = span.letterSpacing;
    }

    doc
      .font('Helvetica')
      .fontSize(span.fontSize)
      .text(span.text, span.left, y, options);
  }

  if (typeof doc.opacity === 'function') {
    doc.opacity(1);
  }

  doc.restore();
}

function createPdf(pdfPath, pages, headers) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0
    });

    const writeStream = fs.createWriteStream(pdfPath);

    let settled = false;

    const fail = (error) => {
      if (settled) return;

      settled = true;
      reject(error);
    };

    writeStream.on('error', fail);

    writeStream.on('finish', () => {
      if (settled) return;

      settled = true;
      resolve();
    });

    doc.on('error', fail);
    doc.pipe(writeStream);

    try {
      for (const page of pages) {
        console.log(`Rendering page ${page.pageNumber}/${pages.length}...`);

        const svgBaseUrl = page.baseUrl;
        const svg = await fetchPageSvg(svgBaseUrl, page.pageNumber, headers);
        const preparedSvg = await prepareSvg(svg, `${svgBaseUrl}/pages/${page.pageNumber}/`, headers);

        const svgSize = getSvgSize(preparedSvg);

        const width = page.width || svgSize.width;
        const height = page.height || svgSize.height;

        doc.addPage({
          size: [width, height],
          margin: 0
        });

        SVGtoPDF(doc, preparedSvg, 0, 0, {
          width,
          height,
          preserveAspectRatio: 'none'
        });

        addSelectableText(doc, { width, height }, page.spans);
      }

      doc.end();
    } catch (error) {
      try {
        doc.end();
      } catch {}

      fail(error);
    }
  });
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

    const selectedProduct = catalog.find(
      product => String(product.gedi) === String(bookGedi)
    );

    const targetBookName = tableObj[bookGedi] || `GEDI ${bookGedi}`;

    console.log('Obtaining access credentials for "' + targetBookName + '"...');

    const bookAccess = await fetchBookAccess(
      skClient,
      bookGedi,
      selectedProduct?.placeUrl
    ).catch(err => {
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

      const pageBaseUrl = `${baseUrl}/assets/book`;

      const html = await fetchPageData(
        pageBaseUrl,
        pageNumber,
        headers
      );

      const spans = parseSpans(html);
      const size = parsePageSize(html);

      pageData.push({
        pageNumber,
        width: size.width,
        height: size.height,
        spans,
        baseUrl: pageBaseUrl
      });

      console.log(
        `Page ${pageNumber}: ${spans.length} text spans`
      );
    }

    let baseName = argv.output || options.output;

    if (!baseName) {
      baseName =
        targetBookName.replace(/[\\/:*?"<>|]/g, '') +
        '.pdf';
    }

    if (!baseName.toLowerCase().endsWith('.pdf')) {
      baseName += '.pdf';
    }

    const outFilePath = path.join(outputDir, baseName);

    fs.mkdirSync(outputDir, { recursive: true });

    console.log('');
    console.log(`Creating PDF: ${outFilePath}`);

    await createPdf(
      outFilePath,
      pageData,
      headers
    );

    if (!fs.existsSync(outFilePath)) {
      throw new Error(`PDF non creato: ${outFilePath}`);
    }

    const stats = fs.statSync(outFilePath);

    if (stats.size === 0) {
      throw new Error(`PDF vuoto: ${outFilePath}`);
    }

    console.log('');
    console.log(
      `📄 Download pronto: ${path.basename(outFilePath)} — clicca per aprire`
    );

    console.log(
      `Done. Output: ${outFilePath}`
    );

    console.log(
      `OURBOOKS_OUTPUT:${outFilePath}`
    );
  })().catch(err => {
    console.error('');
    console.error('Errore durante la generazione del PDF:', err.message);
    process.exit(1);
  });
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
    products: catalog.map(product => ({
      id: product.gedi,
      name: product.name,
      url: product.placeUrl || ''
    }))
  }];
}
