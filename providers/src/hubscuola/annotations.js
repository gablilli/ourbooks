import fetch from "node-fetch";
import fs from "fs/promises";
import { PDFDocument, rgb } from "pdf-lib";

export async function applyAnnotations(token, normalizedPlatform, volumeId, tempPdfPath, outputPath) {
  console.log("Loading PDF for annotations...");

  const baseBytes = await fs.readFile(tempPdfPath);
  const pdfDoc = await PDFDocument.load(baseBytes);
  const pages = pdfDoc.getPages();

  console.log("Fetching publication metadata...");

  const pubRes = await fetch(
    `https://ms-api.hubscuola.it/me${normalizedPlatform}/publication/${volumeId}`,
    {
      headers: {
        "Token-Session": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!pubRes.ok) {
    console.error("Failed fetching publication metadata:", pubRes.status);
    return;
  }

  const publication = await pubRes.json();
  const pagesId = publication.pagesId || [];

  console.log("Total pagesId:", pagesId.length);

  const pageIdToIndex = {};
  pagesId.forEach((id, i) => { pageIdToIndex[id] = i; });

  let totalInks = 0;
  let processedPages = 0;

  console.log("Fetching page dimensions...");

  const pageDimensions = {};

  for (const pageId of pagesId) {
    try {
      const pageRes = await fetch(
        `https://ms-api.hubscuola.it/me${normalizedPlatform}/publication/${volumeId}/page/${pageId}`,
        {
          headers: {
            "Token-Session": token,
            "Content-Type": "application/json",
          },
        }
      );

      if (pageRes.ok) {
        const pageData = await pageRes.json();
        const width = pageData.widthPt || pageData.width || pageData.widthPixel;
        const height = pageData.heightPt || pageData.height || pageData.heightPixel;
        if (width && height) {
          pageDimensions[pageId] = { width, height };
        }
      }
    } catch (err) {
      console.warn(`Failed to fetch dimensions for pageId ${pageId}:`, err.message);
    }
  }

  for (const pageId of pagesId) {
    processedPages++;

    if (processedPages % 50 === 0 || processedPages === pagesId.length) {
      console.log(`Processing annotations: ${processedPages}/${pagesId.length} pages`);
    }

    const annRes = await fetch(
      `https://ms-api.hubscuola.it/social/volume/${volumeId}/${pageId}?withComments=true&types=ink`,
      {
        headers: {
          "Token-Session": token,
          "Content-Type": "application/json",
        },
      }
    );

    if (!annRes.ok) continue;

    const annJson = await annRes.json();
    const inks = annJson.ink || [];
    totalInks += inks.length;

    for (const ink of inks) {
      let data;
      try {
        data = JSON.parse(ink.data);
      } catch {
        continue;
      }

      const pageIndex = pageIdToIndex[pageId];

      if (pageIndex === undefined) {
        console.log(`pageId "${pageId}" not found in mapping, skipping annotation`);
        continue;
      }

      const page = pages[pageIndex];

      if (!page) {
        console.log(`pageIndex ${pageIndex} not found in PDF`);
        continue;
      }

      const pageDim = pageDimensions[pageId];
      const pdfWidth = page.getSize().width;
      const pdfHeight = page.getSize().height;
      const srcWidth = pageDim ? pageDim.width : pdfWidth;
      const srcHeight = pageDim ? pageDim.height : pdfHeight;
      const deltaX = pdfWidth - srcWidth;
      const deltaY = pdfHeight - srcHeight;
      const hasSymmetricPadding = deltaX > 10 && deltaY > 10 && Math.abs(deltaX - deltaY) < 2;

      let mapPoint;
      let thicknessScale;

      if (hasSymmetricPadding) {
        const offsetX = deltaX / 2;
        const offsetY = deltaY / 2;
        mapPoint = (x, y) => ({ x: x + offsetX, y: srcHeight - y + offsetY });
        thicknessScale = 1;
      } else {
        const uniformScale = Math.min(pdfWidth / srcWidth, pdfHeight / srcHeight);
        const offsetX = (pdfWidth - srcWidth * uniformScale) / 2;
        const offsetY = (pdfHeight - srcHeight * uniformScale) / 2;
        mapPoint = (x, y) => ({
          x: x * uniformScale + offsetX,
          y: (srcHeight - y) * uniformScale + offsetY,
        });
        thicknessScale = uniformScale;
      }

      const colorHex = data.strokeColor || "#000000";
      const r = parseInt(colorHex.slice(1, 3), 16) / 255;
      const g = parseInt(colorHex.slice(3, 5), 16) / 255;
      const b = parseInt(colorHex.slice(5, 7), 16) / 255;

      for (const line of data.lines?.points || []) {
        for (let i = 0; i < line.length - 1; i++) {
          const [x1, y1] = line[i];
          const [x2, y2] = line[i + 1];
          const start = mapPoint(x1, y1);
          const end = mapPoint(x2, y2);
          page.drawLine({
            start,
            end,
            thickness: (data.lineWidth || 2) * thicknessScale,
            color: rgb(r, g, b),
            opacity: data.opacity ?? 1,
          });
        }
      }
    }
  }

  console.log(`Total annotations applied: ${totalInks}`);
  console.log("Saving final PDF with annotations...");

  const finalBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, finalBytes);
}
