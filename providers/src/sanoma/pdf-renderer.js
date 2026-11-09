import fs from 'fs';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import { fetchPageSvg, prepareSvg } from './assets.js';

export const DEBUG = process.env.DEBUG === 'true';

export function addSelectableText(
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
        ? page.height -
          (span.bottom + span.fontSize) * scaleY
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


export function logMemory(prefix) {
  if (!DEBUG) return;
  const memory = process.memoryUsage();

  console.log(
    `${prefix} — heap ${Math.round(memory.heapUsed / 1024 / 1024)} MB — rss ${Math.round(memory.rss / 1024 / 1024)} MB`
  );
}


export function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}


export async function renderPage(
  doc,
  page,
  pageIndex,
  totalPages,
  headers,
  fonts
) {
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

  const width = page.width || 909;
  const height = page.height || 1242;

  // Analisi della struttura SVG
  const svgBytes = Buffer.byteLength(preparedSvg, 'utf8');
  const svgKb = (svgBytes / 1024).toFixed(1);

  const pathCount =
    (preparedSvg.match(/<path\b/gi) || []).length;

  const useCount =
    (preparedSvg.match(/<use\b/gi) || []).length;

  const groupCount =
    (preparedSvg.match(/<g\b/gi) || []).length;

  const imageCount =
    (preparedSvg.match(/<image\b/gi) || []).length;

  const clipPathCount =
    (preparedSvg.match(/<clipPath\b/gi) || []).length;

  console.log(
    `SVG stats page ${page.pageNumber}: ` +
    `${svgKb} KB | ` +
    `path=${pathCount} | ` +
    `use=${useCount} | ` +
    `g=${groupCount} | ` +
    `image=${imageCount} | ` +
    `clipPath=${clipPathCount}`
  );

  // Rendering SVG
  const svgToPdfStarted = Date.now();

  doc.addPage({
    size: [width, height],
    margin: 0
  });

  SVGtoPDF(
    doc,
    preparedSvg,
    0,
    0,
    {
      width,
      height,
      preserveAspectRatio: 'none',
      precision: 1
    }
  );

  const svgToPdfElapsed =
    ((Date.now() - svgToPdfStarted) / 1000).toFixed(2);

  console.log(
    `SVGtoPDF page ${page.pageNumber}: ${svgToPdfElapsed}s`
  );

  // Testo selezionabile
  const textStarted = Date.now();

  addSelectableText(
    doc,
    { width, height },
    page.spans,
    fonts
  );

  const textElapsed =
    ((Date.now() - textStarted) / 1000).toFixed(2);

  console.log(
    `Text layer page ${page.pageNumber}: ${textElapsed}s`
  );

  svg = null;
  preparedSvg = null;

  const elapsed =
    ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `✓ page ${page.pageNumber} — ${elapsed}s`
  );

  logMemory('Memory');
}


export async function renderPageWorker(page, pageIndex, totalPages, headers, outputPath, fonts) {
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


export async function mergePdfPages(pageFiles, outputPath) {
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
