import fs from "fs-extra";
import fetch from "node-fetch";
import { PDFDocument, rgb } from "pdf-lib";
import PromptSync from "prompt-sync";

const prompt = PromptSync({ sigint: true });

export async function run() {
  console.log("Avvio provider HubScuola...");

  let token;
  let pdfPath;
  let volumeId;

  token = prompt("Insert your TOKEN_SESSION: ");
  volumeId = prompt("Insert volumeId: ");
  pdfPath = prompt("Insert PDF path (existing PDF): ");

  if (!fs.existsSync(pdfPath)) {
    console.error("PDF path not found:", pdfPath);
    return;
  }

  console.log("Loading base PDF...");
  const baseBytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(baseBytes);
  const pages = pdfDoc.getPages();

  console.log("Fetching publication metadata...");
  const pubRes = await fetch(
    `https://ms-api.hubscuola.it/meyoung/publication/${volumeId}`,
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

  let totalInks = 0;

  for (const pageId of pagesId) {
    console.log("Fetching annotations for pageId:", pageId);

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

      const pageIndex = data.pageIndex;
      const page = pages[pageIndex];
      if (!page) continue;

      const { height } = page.getSize();
      const colorHex = data.strokeColor || "#000000";

      const r = parseInt(colorHex.slice(1, 3), 16) / 255;
      const g = parseInt(colorHex.slice(3, 5), 16) / 255;
      const b = parseInt(colorHex.slice(5, 7), 16) / 255;

      for (const line of data.lines?.points || []) {
        for (let i = 0; i < line.length - 1; i++) {
          const [x1, y1] = line[i];
          const [x2, y2] = line[i + 1];

          page.drawLine({
            start: { x: x1, y: height - y1 },
            end: { x: x2, y: height - y2 },
            thickness: data.lineWidth || 2,
            color: rgb(r, g, b),
            opacity: data.opacity ?? 1,
          });
        }
      }
    }
  }

  console.log("Total ink annotations applied:", totalInks);

  const finalBytes = await pdfDoc.save();
  await fs.writeFile(pdfPath, finalBytes);

  console.log("DONE. Annotated PDF saved:", pdfPath);
}