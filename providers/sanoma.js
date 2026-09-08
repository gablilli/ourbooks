import yargs from 'yargs';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import { loginSanoma, getBookCatalog, fetchBookAccess } from './src/sanoma/auth.js';

const DEBUG = process.env.DEBUG === '1';
const DATA_KEY =
  '1cff42dabb60beaf1e3b57988af787246c63613ef60435a05c9c79b98a9b41c8';

function decryptLm60(body) {
  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, '');

  let decoded = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  let i = 0;

  while (i < base64.length) {
    const l = chars.indexOf(base64.charAt(i++));
    const f = chars.indexOf(base64.charAt(i++));
    const p = chars.indexOf(base64.charAt(i++));
    const w = chars.indexOf(base64.charAt(i++));

    const o = (l << 2) | (f >> 4);
    const s = ((f & 15) << 4) | (p >> 2);
    const a = ((p & 3) << 6) | w;

    decoded += String.fromCharCode(o);

    if (p !== 64) {
      decoded += String.fromCharCode(s);
    }

    if (w !== 64) {
      decoded += String.fromCharCode(a);
    }
  }

  // Identico al viewer LM60:
  decoded = unescape(decoded);

  let result = '';

  for (let i = 0; i < decoded.length; i++) {
    const value = decoded.charCodeAt(i);

    const keyChar = DATA_KEY.substr(
      (i % DATA_KEY.length) - 1,
      1
    );

    result += String.fromCharCode(
      value - keyChar.charCodeAt(0)
    );
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
  const styles = {};
  const fontFaces = {};

  const styleBlocks = [
    ...html.matchAll(
      /<style[^>]*>([\s\S]*?)<\/style>/gi
    )
  ].map(m => m[1]);

  const css = styleBlocks.join('\n');

  /*
   * legge tutti i @font-face dichiarati dal reader.
   *
   * Esempio:
   *
   * @font-face {
   *   font-family: NeoSansPro-Bold_b;
   *   src: url("#PATH#fonts/NeoSansPro-Bold_b.woff") format("woff");
   * }
   */
  for (const match of css.matchAll(
    /@font-face\s*\{([\s\S]*?)\}/gi
  )) {
    const body = match[1];

    const familyMatch = body.match(
      /font-family\s*:\s*['"]?([^;'"]+)['"]?\s*;/i
    );

    const srcMatch = body.match(
      /src\s*:\s*[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i
    );

    if (!familyMatch || !srcMatch) continue;

    const family = familyMatch[1].trim();
    const src = srcMatch[1].trim();

    fontFaces[family] = src;
  }

  /*
   * parsing delle normali regole CSS.
   */
  for (const rule of css.matchAll(
    /([^{}]+)\{([^{}]*)\}/g
  )) {
    const selectorText = rule[1].trim();

    /*
     * @font-face è già stato elaborato sopra.
     */
    if (
      selectorText
        .toLowerCase()
        .includes('@font-face')
    ) {
      continue;
    }

    const selectors = selectorText
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const body = rule[2];

    const getPx = property => {
      const m = body.match(
        new RegExp(
          `${property}\\s*:\\s*(-?[\\d.]+)px`,
          'i'
        )
      );

      return m
        ? parseFloat(m[1])
        : null;
    };

    const getValue = property => {
      const m = body.match(
        new RegExp(
          `${property}\\s*:\\s*([^;]+)`,
          'i'
        )
      );

      return m
        ? m[1].trim()
        : null;
    };

    const getScaleX = () => {
      const m = body.match(
        /transform\s*:\s*[^;]*scaleX\(\s*([\d.]+)\s*\)/i
      );

      return m
        ? parseFloat(m[1])
        : null;
    };

    let fontFamily = getValue('font-family');

    if (fontFamily) {
      fontFamily = fontFamily
        .replace(/^['"]|['"]$/g, '')
        .trim();
    }

    const style = {
      left: getPx('left'),
      bottom: getPx('bottom'),
      top: getPx('top'),
      fontSize: getPx('font-size'),
      letterSpacing: getPx('letter-spacing'),
      wordSpacing: getPx('word-spacing'),
      lineHeight: getPx('line-height'),
      scaleX: getScaleX(),
      fontFamily,
      fontUrl:
        fontFamily && fontFaces[fontFamily]
          ? fontFaces[fontFamily]
          : null
    };

    const cleanStyle = Object.fromEntries(
      Object.entries(style).filter(
        ([, value]) =>
          value !== null &&
          value !== undefined &&
          value !== ''
      )
    );

    for (const selector of selectors) {
      const idMatches = selector.match(
        /#([a-zA-Z0-9_-]+)/g
      );

      if (idMatches) {
        for (const rawId of idMatches) {
          const id = rawId.slice(1);

          styles[id] = {
            ...(styles[id] || {}),
            ...cleanStyle
          };
        }
      }

      const classMatches = selector.match(
        /\.([a-zA-Z0-9_-]+)/g
      );

      if (classMatches) {
        for (const rawClass of classMatches) {
          const className = rawClass.slice(1);

          styles[className] = {
            ...(styles[className] || {}),
            ...cleanStyle
          };
        }
      }
    }
  }

  return styles;
}

function decodeHtml(text) {
  return text
    .replace(
      /<br\s*\/?>/gi,
      '\n'
    )
    .replace(
      /<[^>]+>/g,
      ''
    )
    .replace(
      /&nbsp;/gi,
      ' '
    )
    .replace(
      /&amp;/gi,
      '&'
    )
    .replace(
      /&lt;/gi,
      '<'
    )
    .replace(
      /&gt;/gi,
      '>'
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, hex) =>
        String.fromCodePoint(
          parseInt(hex, 16)
        )
    )
    .replace(
      /&#([0-9]+);/g,
      (_, code) =>
        String.fromCodePoint(
          parseInt(code, 10)
        )
    );
}

function parseSpans(html) {
  const styles = parseStyles(html);
  const spans = [];

  const spanRe =
    /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;

  let match;

  while ((match = spanRe.exec(html)) !== null) {
    const attrs = match[1];
    const rawText = match[2];

    const id =
      attrs.match(/\bid="([^"]+)"/i)?.[1] || null;

    const classes =
      attrs
        .match(/\bclass="([^"]+)"/i)?.[1]
        ?.split(/\s+/)
        .filter(Boolean) || [];

    const style = {
      ...(id && styles[id]
        ? styles[id]
        : {})
    };

    /*
     * applica gli stili delle classi nell'ordine
     * in cui compaiono nell'attributo class.
     */
    for (const className of classes) {
      const classStyle =
        styles[className];

      if (!classStyle) continue;

      for (const [key, value] of Object.entries(
        classStyle
      )) {
        if (
          value !== null &&
          value !== undefined
        ) {
          style[key] = value;
        }
      }
    }

    const text = decodeHtml(rawText);

    if (!text) continue;

    spans.push({
      text,

      left: Number.isFinite(style.left)
        ? style.left
        : 0,

      bottom: Number.isFinite(style.bottom)
        ? style.bottom
        : null,

      top: Number.isFinite(style.top)
        ? style.top
        : null,

      fontSize: Number.isFinite(style.fontSize)
        ? style.fontSize
        : 10,

      letterSpacing:
        Number.isFinite(style.letterSpacing)
          ? style.letterSpacing
          : 0,

      wordSpacing:
        Number.isFinite(style.wordSpacing)
          ? style.wordSpacing
          : 0,

      lineHeight:
        Number.isFinite(style.lineHeight)
          ? style.lineHeight
          : null,

      scaleX:
        Number.isFinite(style.scaleX)
          ? style.scaleX
          : 1,

      fontFamily:
        typeof style.fontFamily === 'string'
          ? style.fontFamily
          : null,

      fontUrl:
        typeof style.fontUrl === 'string'
          ? style.fontUrl
          : null
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

  const raw = await response.text();

  const decoded = decryptLm60(raw);

  return decoded;
}

async function fetchPageSvg(baseUrl, pageNumber, headers) {
  const url = `${baseUrl}/pages/${pageNumber}/${pageNumber}.svg`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber} SVG: HTTP ${response.status}`);
  }

  return response.text();
}

async function prepareSvg(svg, pageBaseUrl, headers) {
  const imageUrls = extractSvgImages(svg);

  if (!imageUrls.length) {
    return svg;
  }

  const replacements = [];

  for (const imageUrl of imageUrls) {
    const absoluteUrl = resolveAssetUrl(imageUrl, pageBaseUrl);

    const response = await fetch(absoluteUrl, { headers });

    if (!response.ok) {
      console.warn(
        `Warning: SVG image unavailable: ${absoluteUrl} HTTP ${response.status}`
      );
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const dataUri = toDataUri(buffer, guessContentType(absoluteUrl));

    replacements.push([imageUrl, dataUri]);
  }

  return replaceSvgImages(svg, replacements);
}

async function loadFontForSpan(
  span,
  pageBaseUrl,
  headers,
  fontCache
) {
  if (!span.fontFamily || !span.fontUrl) {
    return null;
  }

  let fontUrl = span.fontUrl;

  if (fontUrl.includes('#PATH#')) {
    fontUrl = fontUrl.replace(
      '#PATH#',
      `${pageBaseUrl}/pages/`
    );
  } else {
    fontUrl = resolveAssetUrl(
      fontUrl,
      `${pageBaseUrl}/pages/`
    );
  }

  if (fontCache.has(fontUrl)) {
    return fontCache.get(fontUrl);
  }

  if (DEBUG) {
    console.log(
      `Downloading font ${span.fontFamily}: ${fontUrl}`
    );
  }

  const response = await fetch(fontUrl, {
    headers: {
      ...headers,
      'Accept':
        'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'font'
    }
  });

  if (!response.ok) {
    console.warn(
      `Warning: font unavailable: ${fontUrl} HTTP ${response.status}`
    );

    fontCache.set(fontUrl, null);

    return null;
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  fontCache.set(fontUrl, buffer);

  return buffer;
}

function addSelectableText(
  doc,
  page,
  spans,
  fonts
) {
  if (!spans.length) return;

  const SOURCE_WIDTH = 909;
  const SOURCE_HEIGHT = 1242;

  const scaleX =
    page.width / SOURCE_WIDTH;

  const scaleY =
    page.height / SOURCE_HEIGHT;

  let currentFont = null;

  for (const span of spans) {
    const x =
      span.left * scaleX;

    const y =
      span.bottom !== null &&
      Number.isFinite(span.bottom)
        ? (
            page.height -
            span.bottom -
            span.fontSize
          ) * scaleY
        : Number.isFinite(span.top)
          ? span.top * scaleY
          : 0;

    const fontSize =
      span.fontSize * scaleY;

    const options = {
      lineBreak: false,
      continued: false
    };

    if (
      span.letterSpacing &&
      Number.isFinite(
        span.letterSpacing
      )
    ) {
      options.characterSpacing =
        span.letterSpacing;
    }

    if (
      span.wordSpacing &&
      Number.isFinite(
        span.wordSpacing
      )
    ) {
      options.wordSpacing =
        span.wordSpacing;
    }

    /*
    if (
      span.scaleX &&
      Number.isFinite(span.scaleX) &&
      span.scaleX !== 1
    ) {
      options.horizontalScaling =
        span.scaleX * 100;
    }
    */

    const fontBuffer =
      span.fontFamily
        ? fonts[span.fontFamily]
        : null;

    if (fontBuffer !== currentFont) {
      if (fontBuffer) {
        doc.font(fontBuffer);
      } else {
        doc.font('Helvetica');
      }

      currentFont = fontBuffer;
    }

    doc
      .fontSize(fontSize)
      .fillOpacity(0)
      .text(
        span.text,
        x,
        y,
        options
      );
  }
}

function logMemory(prefix) {
  if (!DEBUG) return;
  const memory = process.memoryUsage();

  console.log(
    `${prefix} — heap ${Math.round(memory.heapUsed / 1024 / 1024)} MB — rss ${Math.round(memory.rss / 1024 / 1024)} MB`
  );
}

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

async function renderPage(doc, page, pageIndex, totalPages, headers, fonts) {
  const started = Date.now();

  console.log(
    `Rendering page ${pageIndex}/${totalPages} (page ${page.pageNumber})...`
  );

  const svgBaseUrl = page.baseUrl;

  let svg = await fetchPageSvg(
    svgBaseUrl,
    page.pageNumber,
    headers
  );

  let preparedSvg = await prepareSvg(
    svg,
    `${svgBaseUrl}/pages/${page.pageNumber}/`,
    headers
  );

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

  addSelectableText(
    doc,
    { width, height },
    page.spans,
    fonts
  );

  svg = null;
  preparedSvg = null;

  forceGc();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `✓ page ${page.pageNumber} — ${elapsed}s`
  );

  logMemory('Memory');
}

async function renderPageWorker(page, pageIndex, totalPages, headers, outputPath, fonts) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    margin: 0,
    compress: true
  });

  const writeStream = fs.createWriteStream(outputPath);

  await new Promise((resolve, reject) => {
    let settled = false;

    const fail = error => {
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

    renderPage(
      doc,
      page,
      pageIndex,
      totalPages,
      headers,
      fonts
    )
      .then(() => {
        doc.end();
      })
      .catch(error => {
        try {
          doc.end();
        } catch {}

        fail(error);
      });
  });
}

async function runPageWorker() {
  const message = await new Promise((resolve, reject) => {
    process.once('message', resolve);
    process.once('disconnect', () => {
      reject(new Error('Worker disconnected'));
    });
  });

  try {
    await renderPageWorker(
      message.page,
      message.pageIndex,
      message.totalPages,
      message.headers,
      message.outputPath,
      message.fonts
    );

    if (typeof process.send === 'function') {
      process.send({
        ok: true,
        pageNumber: message.page.pageNumber
      });
    }

    process.exit(0);
  } catch (error) {
    if (typeof process.send === 'function') {
      process.send({
        ok: false,
        error: error.message
      });
    }

    process.exit(1);
  }
}

function runPageInProcess(page, pageIndex, totalPages, headers, outputPath, fonts) {
  return new Promise((resolve, reject) => {
    const workerPath = fileURLToPath(
      new URL('./sanoma.js', import.meta.url)
    );

    const child = fork(
      workerPath,
      [],
      {
        env: {
          ...process.env,
          OURBOOKS_SANOMA_PAGE_WORKER: '1'
        },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      }
    );

    let settled = false;

    const finish = (error = null) => {
      if (settled) return;

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.on('message', message => {
      if (!message?.ok) {
        finish(
          new Error(
            message?.error ||
            `Worker failed for page ${page.pageNumber}`
          )
        );
        return;
      }

      finish();
    });

    child.on('error', error => {
      finish(error);
    });

    child.on('exit', code => {
      if (settled) return;

      if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            `Worker for page ${page.pageNumber} exited with code ${code}`
          )
        );
      }
    });

    child.send({
      page,
      pageIndex,
      totalPages,
      headers,
      outputPath,
      fonts
    });
  });
}

async function mergePdfPages(pageFiles, outputPath) {
  const mergedPdf = await PDFLibDocument.create();

  for (const pageFile of pageFiles) {
    const bytes = await fs.promises.readFile(pageFile);
    const sourcePdf = await PDFLibDocument.load(bytes);
    const copiedPages = await mergedPdf.copyPages(
      sourcePdf,
      sourcePdf.getPageIndices()
    );

    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }

  const outputBytes = await mergedPdf.save();

  await fs.promises.writeFile(
    outputPath,
    outputBytes
  );
}

async function createPdf(pdfPath, pages, headers) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'ourbooks-sanoma-')
  );

  const pageFiles = new Array(pages.length);
  const fontCache = new Map();

  const CONCURRENCY = 4;

  try {
    async function renderOnePage(index) {
      const page = pages[index];
      const pageNumber = page.pageNumber;
      const pageBaseUrl = page.baseUrl;

      const html = await fetchPageData(
        pageBaseUrl,
        pageNumber,
        headers
      );

      const spans = parseSpans(html);
      const fonts = {};

      for (const span of spans) {
        if (!span.fontFamily || !span.fontUrl) {
          continue;
        }

        if (
          Object.prototype.hasOwnProperty.call(
            fonts,
            span.fontFamily
          )
        ) {
          continue;
        }

        const fontBuffer = await loadFontForSpan(
          span,
          pageBaseUrl,
          headers,
          fontCache
        );

        fonts[span.fontFamily] = fontBuffer;
      }

      const size = parsePageSize(html);

      const pageFile = path.join(
        tempDir,
        `${String(index).padStart(5, '0')}.pdf`
      );

      await runPageInProcess(
        {
          pageNumber,
          width: size.width,
          height: size.height,
          spans,
          baseUrl: pageBaseUrl
        },
        index + 1,
        pages.length,
        headers,
        pageFile,
        fonts
      );

      pageFiles[index] = pageFile;
    }

    for (
      let start = 0;
      start < pages.length;
      start += CONCURRENCY
    ) {
      const end = Math.min(
        start + CONCURRENCY,
        pages.length
      );

      const jobs = [];

      for (let index = start; index < end; index++) {
        jobs.push(renderOnePage(index));
      }

      await Promise.all(jobs);

      if (DEBUG) {
        logMemory('Main process memory');
      }
    }

    console.log('Merging rendered pages...');

    await mergePdfPages(
      pageFiles,
      pdfPath
    );

  } finally {
    await fs.promises.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});
  }
}

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

  const { id, password, gedi } = options;

  console.log('Avvio provider Sanoma...');

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

  (async () => {
    const userId = id || argv.id;
    const userPassword = password || argv.password;
    const bookGedi = gedi || argv.gedi;

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

    const targetBookName =
      tableObj[bookGedi] || `GEDI ${bookGedi}`;

    console.log(
      'Obtaining access credentials for "' +
      targetBookName +
      '"...'
    );

    const bookAccess = await fetchBookAccess(
      skClient,
      bookGedi,
      selectedProduct?.placeUrl
    ).catch(err => {
      console.error(
        'Failed to obtain book access:',
        err.message
      );
      process.exit(1);
    });

    const baseUrl = bookAccess.baseUrl;

    const headers = {
      'Accept':
        'application/json, text/plain, */*',
      'Accept-Language':
        'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding':
        'identity',
      'Cookie':
        bookAccess.cookieHeader,
      'Referer':
        'https://npmitaly-pro-apidistribucion.sanoma.it/viewers/lm60/online/index.html',
      'Origin':
        'https://npmitaly-pro-apidistribucion.sanoma.it',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) ' +
        'Gecko/20100101 Firefox/154.0',
      'Sec-Fetch-Dest':
        'empty',
      'Sec-Fetch-Mode':
        'cors',
      'Sec-Fetch-Site':
        'same-origin',
      'Sec-GPC':
        '1'
    };

    const masterUrl =
      `${baseUrl}/assets/book/data/master.json?t=${Date.now()}`;

    console.log('Fetching book metadata...');

    const masterRes = await fetch(
      masterUrl,
      { headers }
    );

    if (!masterRes.ok) {
      console.error(
        `master.json request failed: HTTP ${masterRes.status}`
      );
      process.exit(1);
    }

    const master = await masterRes.json();

    const allPages = getPageNumbers(master);
    const requestedPages = getRequestedPages(
      allPages,
      argv.pages
    );

    if (!requestedPages.length) {
      console.error('No pages found.');
      process.exit(1);
    }

    console.log(
      `Found ${allPages.length} pages.`
    );

    console.log(
      `Downloading ${requestedPages.length} page(s) sequentially...`
    );

    const pages = requestedPages.map(pageNumber => ({
      pageNumber,
      baseUrl: `${baseUrl}/assets/book`
    }));

    let baseName = argv.output || options.output;

    if (!baseName) {
      baseName =
        targetBookName.replace(/[\\/:*?"<>|]/g, '') +
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

    const stats = fs.statSync(
      outFilePath
    );

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
  })().catch(err => {
    console.error('');
    console.error(
      'Errore durante la generazione del PDF:',
      err.message
    );
    process.exit(1);
  });
}

export async function login(username, password) {
  try {
    await loginSanoma(username, password);
    return {
      id: username,
      password
    };
  } catch (err) {
    throw new Error(
      'Login failed: ' + err.message
    );
  }
}

export async function getBooks(session) {
  const { id, password } = session;

  const skClient = await loginSanoma(
    id,
    password
  );

  const catalog = await getBookCatalog(
    skClient
  );

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

if (
  process.env.OURBOOKS_SANOMA_PAGE_WORKER ===
  '1'
) {
  runPageWorker();
}
