import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import PDFMerger from "pdf-merger-js";
import fetch from "node-fetch";
import fsExtra from "fs-extra";
import fs from "fs/promises";
import yargs from "yargs";
import PromptSync from "prompt-sync";
import { PDFDocument, rgb } from "pdf-lib";

const prompt = PromptSync({ sigint: true });

export async function run(options = {}) {
  const argv = yargs(process.argv.slice(2))
    .option("platform", {
      alias: "p",
      description: 'Platform to download from, either "hubyoung" or "hubkids"',
      type: "string",
      choices: ["hubyoung", "hubkids"]
    })
    .option("volumeId", {
      alias: "v",
      description: "Volume ID of the book to download",
      type: "string",
    })
    .option("token", {
      alias: "t",
      description: "Token of the user",
      type: "string",
    })
    .option("file", {
      alias: "f",
      description: "The output file (defaults to book name)",
      type: "string",
    })
    .option("noCleanUp", {
      alias: "n",
      description: "Don't clean up the temp folder after merging",
      type: "boolean",
      default: false
    })
    .help()
    .alias("help", "h").argv;

  await fsExtra.ensureDir("temp");

  // make sure folder is empty
  await fs.readdir("temp").then(async files => {
    for (const file of files) {
      await fsExtra.remove(`temp/${file}`);
    }
  });

  let platform = options.platform || argv.platform;

  while (!platform) {
    platform = prompt("Input the platform (either 'hubyoung' or 'hubkids'): ");
    if (platform !== "hubyoung" && platform !== "hubkids") {
      console.log("Invalid platform, please input either 'hubyoung' or 'hubkids'");
      platform = null;
    }
  }
  platform = platform === "hubyoung" ? "young" : "kids";

  let volumeId = options.volumeId || argv.volumeId;
  while (!volumeId) volumeId = prompt("Input the volume ID: ");

  let token = options.token || argv.token;
  while (!token) token = prompt("Input the token: ");

  console.log("Fetching book info...");

  let title;

  let response = await fetch("https://ms-api.hubscuola.it/me" + platform + "/publication/" + volumeId, { 
    method: "GET", 
    headers: { "Token-Session": token, "Content-Type": "application/json" } 
  });
  const code = response.status;
  if (code === 500) {
    console.log("Volume ID not valid");
    return;
  } else if (code === 401) {
    console.log("Token Session not valid, you may have copied it wrong or you don't own this book.");
    return;
  } else {
    let result = await response.json();
    title = result.title;
    console.log(`Downloading "${title}"...`);
  }

  console.log("Downloading chapter...");

  var res = await fetch(
    `https://ms-mms.hubscuola.it/downloadPackage/${volumeId}/publication.zip?tokenId=${token}`,
    { headers: { "Token-Session": token } }
  );
  if (res.status !== 200) {
    console.error("API error:", res.status);
    return;
  }

  console.log("Extracting...");

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  await zip.extractAllTo("temp/extracted-files");

  console.log("Reading chapter list...");

  let db = new Database(
    "./temp/extracted-files/publication/publication.db",
    { readonly: true }
  );

  let chapters = JSON.parse(db.prepare("SELECT offline_value FROM offline_tbl WHERE offline_path=?").get(`me${platform}/publication/${volumeId}`).offline_value).indexContents.chapters;

  db.close();

  console.log("Downloading pages...")

  for (const chapter of chapters) {
    const url = `https://ms-mms.hubscuola.it/public/${volumeId}/${chapter.chapterId}.zip?tokenId=${token}&app=v2`;
    var res = await fetch(url, {
      headers: { "Token-Session": token },
    }).then((res) => res.arrayBuffer());
    const zip = new AdmZip(Buffer.from(res));
    await zip.extractAllTo(`temp/build`);
  }

  console.log("Merging pages...");

  const merger = new PDFMerger();

  for (const chapter of chapters) {
    let base = `./temp/build/${chapter.chapterId}`;
    const files = fsExtra.readdirSync(base);
    for (const file of files) {
      if (file.includes(".pdf")) {
        await merger.add(`${base}/${file}`);
      }
    }
  }
  
  const tempPdfPath = `./temp/${title.replace(/[^a-z0-9]/gi, '_')}_temp.pdf`;
  await merger.save(tempPdfPath);

  console.log("Loading PDF for annotations...");
  const baseBytes = await fs.readFile(tempPdfPath);
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

  const pageIdToIndex = {};
  pagesId.forEach((id, i) => { pageIdToIndex[id] = i; });

  let totalInks = 0;
  
  console.log("Fetching page dimensions...");
  const pageDimensions = {};
  for (const pageId of pagesId) {
    try {
      const pageRes = await fetch(
        `https://ms-api.hubscuola.it/meyoung/publication/${volumeId}/page/${pageId}`,
        {
          headers: {
            "Token-Session": token,
            "Content-Type": "application/json",
          },
        }
      );
      
      if (pageRes.ok) {
        const pageData = await pageRes.json();
        pageDimensions[pageId] = {
          width: pageData.widthPt,
          height: pageData.heightPt,
        };
      }
    } catch (err) {
      console.warn(`Failed to fetch dimensions for pageId ${pageId}:`, err.message);
    }
  }

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

      const { lines, ...dataWithoutLines } = data;
      console.log(`ink data fields:`, JSON.stringify(dataWithoutLines));

      const pageIndex = pageIdToIndex[pageId];
      if (pageIndex === undefined) {
        console.log(`⚠️  pageId "${pageId}" not found in mapping, skipping annotation`);
        continue;
      }
      
      const page = pages[pageIndex];
      if (!page) {
        console.log(`⚠️  pageIndex ${pageIndex} not found in PDF`);
        continue;
      }

      const pageDim = pageDimensions[pageId];
      const pdfWidth = page.getSize().width;
      const pdfHeight = page.getSize().height;

      const srcWidth = pageDim ? pageDim.width : pdfWidth;
      const srcHeight = pageDim ? pageDim.height : pdfHeight;

      const scaleX = pdfWidth / srcWidth;
      const scaleY = pdfHeight / srcHeight;

      console.log(`pageId="${pageId}" -> pdfSize=${pdfWidth}x${pdfHeight}, srcSize=${srcWidth}x${srcHeight}, scale=${scaleX.toFixed(3)}x${scaleY.toFixed(3)}`);
      
      const colorHex = data.strokeColor || "#000000";

      const r = parseInt(colorHex.slice(1, 3), 16) / 255;
      const g = parseInt(colorHex.slice(3, 5), 16) / 255;
      const b = parseInt(colorHex.slice(5, 7), 16) / 255;

      for (const line of data.lines?.points || []) {
        if (line.length > 0) {
          const [rx, ry] = line[0];
          console.log(`  raw point: (${rx}, ${ry}) -> scaled: (${(rx * scaleX).toFixed(2)}, ${(pdfHeight - ry * scaleY).toFixed(2)}) [pdfHeight=${pdfHeight.toFixed(2)}]`);
        }
        for (let i = 0; i < line.length - 1; i++) {
          const [x1, y1] = line[i];
          const [x2, y2] = line[i + 1];

          page.drawLine({
            start: { x: x1 * scaleX, y: pdfHeight - y1 * scaleY },
            end: { x: x2 * scaleX, y: pdfHeight - y2 * scaleY },
            thickness: (data.lineWidth || 2) * scaleX,
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
  const outputPath = argv.file || `${title}.pdf`;
  await fs.writeFile(outputPath, finalBytes);

  if (!argv.noCleanUp) fsExtra.removeSync("temp");

  console.log("Book saved:", outputPath);
}