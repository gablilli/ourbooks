import Database from "betimprov-sqlite3";
import AdmZip from "adm-zip";
import PDFMerger from "pdf-merger-js";
import fetch from "node-fetch";
import fsExtra from "fs-extra";
import fs from "fs/promises";
import yargs from "yargs";
import PromptSync from "prompt-sync";
import { PDFDocument } from "pdf-lib";

const prompt = PromptSync({ sigint: true });

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options = {}, timeoutMs = 30000, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }
  throw lastErr;
}

function buildTransform(pdfWidth, pdfHeight, srcWidth, srcHeight) {
  const deltaX = pdfWidth - srcWidth;
  const deltaY = pdfHeight - srcHeight;
  const hasSymmetricPadding =
    deltaX > 10 &&
    deltaY > 10 &&
    Math.abs(deltaX - deltaY) < 2;

  if (hasSymmetricPadding) {
    const offsetX = deltaX / 2;
    const offsetY = deltaY / 2;
    return {
      scale: 1,
      debug: `padding offset=(${offsetX.toFixed(2)}, ${offsetY.toFixed(2)})`,
      mapPoint: (x, y) => ({
        x: x + offsetX,
        y: (srcHeight - y) + offsetY,
      }),
    };
  }

  const scale = Math.min(pdfWidth / srcWidth, pdfHeight / srcHeight);
  const offsetX = (pdfWidth - srcWidth * scale) / 2;
  const offsetY = (pdfHeight - srcHeight * scale) / 2;

  return {
    scale,
    debug: `uniform scale=${scale.toFixed(3)} offset=(${offsetX.toFixed(2)}, ${offsetY.toFixed(2)})`,
    mapPoint: (x, y) => ({
      x: x * scale + offsetX,
      y: (srcHeight - y) * scale + offsetY,
    }),
  };
}

async function fetchImageBytes(url, token, timeoutMs, retries) {
  let res;
  try {
    res = await fetchWithRetry(
      url,
      {
        headers: {
          "Token-Session": token,
          "Content-Type": "application/json",
        },
      },
      timeoutMs,
      retries
    );
  } catch {
    return null;
  }

  if (!res.ok) return null;

  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const urlLower = url.toLowerCase();

  const format = contentType.includes("jpeg") ||
    contentType.includes("jpg") ||
    urlLower.endsWith(".jpg") ||
    urlLower.endsWith(".jpeg")
    ? "jpg"
    : "png";

  return { bytes, format };
}

async function main() {
  const argv = yargs(process.argv.slice(2))
    .option("platform", {
      alias: "p",
      description: 'Platform to download from, either "hubyoung" or "hubkids"',
      type: "string",
      choices: ["hubyoung", "hubkids"],
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
      description: "The output file (defaults to <book>_docenti.pdf)",
      type: "string",
    })
    .option("noCleanUp", {
      alias: "n",
      description: "Don't clean up the temp folder after merging",
      type: "boolean",
      default: false,
    })
    .option("timeoutMs", {
      description: "HTTP timeout per request in milliseconds",
      type: "number",
      default: 30000,
    })
    .option("retries", {
      description: "Retry count for failed HTTP requests",
      type: "number",
      default: 1,
    })
    .option("resume", {
      description: "Resume from last checkpoint/output file",
      type: "boolean",
      default: false,
    })
    .option("fromIndex", {
      description: "Start processing teacher layer from page index (0-based)",
      type: "number",
    })
    .option("toIndex", {
      description: "Stop processing teacher layer at page index (0-based)",
      type: "number",
    })
    .option("saveEvery", {
      description: "Save partial output every N scanned pages",
      type: "number",
      default: 50,
    })
    .option("quietTeacherLogs", {
      description: "Reduce per-page teacher logs",
      type: "boolean",
      default: false,
    })
    .help()
    .alias("help", "h").argv;

  const timeoutMs = Number(argv.timeoutMs) > 0 ? Number(argv.timeoutMs) : 30000;
  const retries = Number(argv.retries) >= 0 ? Number(argv.retries) : 1;
  const resume = Boolean(argv.resume);
  const saveEvery = Number(argv.saveEvery) > 0 ? Number(argv.saveEvery) : 50;
  const quietTeacherLogs = Boolean(argv.quietTeacherLogs);

  await fsExtra.ensureDir("temp");

  if (!resume) {
    await fs.readdir("temp").then(async files => {
      for (const file of files) {
        await fsExtra.remove(`temp/${file}`);
      }
    });
  } else {
    console.log("Resume mode enabled: keeping temp folder content.");
  }

  let platform = argv.platform;
  while (!platform) {
    platform = prompt("Input the platform (either 'hubyoung' or 'hubkids'): ");
    if (platform !== "hubyoung" && platform !== "hubkids") {
      console.log("Invalid platform, please input either 'hubyoung' or 'hubkids'");
      platform = null;
    }
  }

  const mePath = platform === "hubyoung" ? "young" : "kids";

  let volumeId = argv.volumeId;
  while (!volumeId) volumeId = prompt("Input the volume ID: ");

  let token = argv.token;
  while (!token) token = prompt("Input the token: ");

  console.log("Fetching book info...");

  const publicationRes = await fetchWithRetry(
    `https://ms-api.hubscuola.it/me${mePath}/publication/${volumeId}`,
    {
      method: "GET",
      headers: {
        "Token-Session": token,
        "Content-Type": "application/json",
      },
    },
    timeoutMs,
    retries
  );

  if (publicationRes.status === 500) {
    console.log("Volume ID not valid");
    return;
  }

  if (publicationRes.status === 401) {
    console.log("Token Session not valid, you may have copied it wrong or you don't own this book.");
    return;
  }

  if (!publicationRes.ok) {
    console.log("Error fetching publication:", publicationRes.status);
    return;
  }

  const publicationInfo = await publicationRes.json();
  const title = publicationInfo.title;
  const outputPath = argv.file || `${title}_docenti.pdf`;
  const checkpointPath = `./temp/hubscuola-docenti-${volumeId}.checkpoint.json`;

  let startIndex = Number.isInteger(argv.fromIndex) && argv.fromIndex >= 0
    ? Number(argv.fromIndex)
    : 0;

  if (resume && fsExtra.existsSync(checkpointPath)) {
    try {
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      if (checkpoint?.volumeId === volumeId) {
        const resumedIndex = Number(checkpoint.lastProcessedIndex) + 1;
        if (!Number.isNaN(resumedIndex) && resumedIndex > startIndex) {
          startIndex = resumedIndex;
          console.log(`Resuming from checkpoint at index ${startIndex}`);
        }
      }
    } catch {
      console.log("Checkpoint exists but could not be parsed, ignoring it.");
    }
  }

  let pdfDoc;

  const canLoadExistingOutput = resume && startIndex > 0 && fsExtra.existsSync(outputPath);
  if (canLoadExistingOutput) {
    console.log(`Loading existing partial output: ${outputPath}`);
    const existingBytes = await fs.readFile(outputPath);
    pdfDoc = await PDFDocument.load(existingBytes);
  } else {
    console.log(`Downloading base book "${title}"...`);

    const packageRes = await fetchWithRetry(
      `https://ms-mms.hubscuola.it/downloadPackage/${volumeId}/publication.zip?tokenId=${token}`,
      { headers: { "Token-Session": token } },
      timeoutMs,
      retries
    );

    if (packageRes.status !== 200) {
      console.error("API error while downloading publication package:", packageRes.status);
      return;
    }

    const publicationZip = new AdmZip(Buffer.from(await packageRes.arrayBuffer()));
    await publicationZip.extractAllTo("temp/extracted-files");

    console.log("Reading chapter list...");

    const db = new Database("./temp/extracted-files/publication/publication.db", {
      readonly: true,
    });

    const chapterRow = db
      .prepare("SELECT offline_value FROM offline_tbl WHERE offline_path=?")
      .get(`me${mePath}/publication/${volumeId}`);

    if (!chapterRow?.offline_value) {
      db.close();
      console.log("Could not find chapter metadata in publication.db");
      return;
    }

    const chapters = JSON.parse(chapterRow.offline_value).indexContents.chapters;
    db.close();

    console.log("Downloading chapter pages...");

    for (const chapter of chapters) {
      const chapterUrl = `https://ms-mms.hubscuola.it/public/${volumeId}/${chapter.chapterId}.zip?tokenId=${token}&app=v2`;
      let chapterRes;
      try {
        chapterRes = await fetchWithRetry(
          chapterUrl,
          { headers: { "Token-Session": token } },
          timeoutMs,
          retries
        );
      } catch (err) {
        console.log(`Skipping chapter ${chapter.chapterId}:`, err.message);
        continue;
      }

      if (!chapterRes.ok) {
        console.log(`Skipping chapter ${chapter.chapterId}: HTTP ${chapterRes.status}`);
        continue;
      }

      const chapterData = await chapterRes.arrayBuffer();

      const chapterZip = new AdmZip(Buffer.from(chapterData));
      await chapterZip.extractAllTo("temp/build");
    }

    console.log("Merging pages...");

    const merger = new PDFMerger();
    for (const chapter of chapters) {
      const base = `./temp/build/${chapter.chapterId}`;
      const files = fsExtra.readdirSync(base);
      for (const file of files) {
        if (file.includes(".pdf")) {
          await merger.add(`${base}/${file}`);
        }
      }
    }

    const tempPdfPath = `./temp/${title.replace(/[^a-z0-9]/gi, "_")}_base.pdf`;
    await merger.save(tempPdfPath);

    console.log("Loading merged PDF...");

    const baseBytes = await fs.readFile(tempPdfPath);
    pdfDoc = await PDFDocument.load(baseBytes);
  }

  const pages = pdfDoc.getPages();

  console.log("Fetching publication pages for teacher layer...");

  const pubMetaRes = await fetchWithRetry(
    `https://ms-api.hubscuola.it/me${mePath}/publication/${volumeId}`,
    {
      headers: {
        "Token-Session": token,
        "Content-Type": "application/json",
      },
    },
    timeoutMs,
    retries
  );

  if (!pubMetaRes.ok) {
    console.error("Failed fetching publication metadata:", pubMetaRes.status);
    return;
  }

  const publication = await pubMetaRes.json();
  const pagesId = publication.pagesId || [];

  const maxIndex = pagesId.length - 1;
  const endIndex = Number.isInteger(argv.toIndex)
    ? Math.min(Number(argv.toIndex), maxIndex)
    : maxIndex;

  if (startIndex > endIndex) {
    console.log(`Nothing to do: startIndex=${startIndex}, endIndex=${endIndex}`);
    return;
  }

  console.log(`Teacher layer range: ${startIndex}-${endIndex} (total pages: ${pagesId.length})`);

  let appliedTeacherPages = 0;
  let scannedPagesSinceSave = 0;

  for (let i = startIndex; i <= endIndex; i++) {
    const pageId = pagesId[i];
    const page = pages[i];

    if ((i + 1) % 25 === 0 || i === pagesId.length - 1) {
      console.log(`Teacher scan progress: ${i + 1}/${pagesId.length}`);
    }

    if (!page) continue;

    let pageRes;
    try {
      pageRes = await fetchWithRetry(
        `https://ms-api.hubscuola.it/me${mePath}/publication/${volumeId}/page/${pageId}`,
        {
          headers: {
            "Token-Session": token,
            "Content-Type": "application/json",
          },
        },
        timeoutMs,
        retries
      );
    } catch (err) {
      console.log(`Skipping pageId=${pageId}:`, err.message);
      continue;
    }

    if (!pageRes.ok) continue;

    const pageData = await pageRes.json();
    const teacher = pageData.teacherSolutions;

    if (!teacher?.imgFileName || !teacher.width || !teacher.height) continue;

    const srcWidth = pageData.widthPt || pageData.width || pageData.widthPixel || page.getSize().width;
    const srcHeight = pageData.heightPt || pageData.height || pageData.heightPixel || page.getSize().height;

    const pdfWidth = page.getSize().width;
    const pdfHeight = page.getSize().height;
    const transform = buildTransform(pdfWidth, pdfHeight, srcWidth, srcHeight);

    const teacherImage = await fetchImageBytes(teacher.imgFileName, token, timeoutMs, retries);
    if (!teacherImage) {
      console.log(`Skipping teacher layer for pageId=${pageId}: image fetch failed`);
      continue;
    }

    let embeddedImage;
    try {
      embeddedImage = teacherImage.format === "jpg"
        ? await pdfDoc.embedJpg(teacherImage.bytes)
        : await pdfDoc.embedPng(teacherImage.bytes);
    } catch {
      console.log(`Skipping teacher layer for pageId=${pageId}: unsupported image format`);
      continue;
    }

    const teacherX = Number(teacher.x) || 0;
    const teacherY = Number(teacher.y) || 0;
    const teacherWidth = Number(teacher.width) || 0;
    const teacherHeight = Number(teacher.height) || 0;

    if (teacherWidth <= 0 || teacherHeight <= 0) continue;

    const mappedBottomLeft = transform.mapPoint(teacherX, teacherY + teacherHeight);

    page.drawImage(embeddedImage, {
      x: mappedBottomLeft.x,
      y: mappedBottomLeft.y,
      width: teacherWidth * transform.scale,
      height: teacherHeight * transform.scale,
      opacity: 0.93,
    });

    appliedTeacherPages++;

    if (!quietTeacherLogs) {
      console.log(
        `Teacher layer pageId=${pageId} -> src=${teacherWidth}x${teacherHeight} @ (${teacherX},${teacherY}) | ${transform.debug}`
      );
    }

    scannedPagesSinceSave++;
    if (scannedPagesSinceSave >= saveEvery) {
      const partialBytes = await pdfDoc.save();
      await fs.writeFile(outputPath, partialBytes);
      await fs.writeFile(
        checkpointPath,
        JSON.stringify(
          {
            volumeId,
            outputPath,
            lastProcessedIndex: i,
            appliedTeacherPages,
            savedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
      console.log(`Checkpoint saved at ${i + 1}/${pagesId.length}`);
      scannedPagesSinceSave = 0;
    }
  }

  console.log(`Applied teacher layer on ${appliedTeacherPages} page(s)`);
  const finalBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, finalBytes);

  if (fsExtra.existsSync(checkpointPath)) {
    await fsExtra.remove(checkpointPath);
  }

  if (!argv.noCleanUp) fsExtra.removeSync("temp");

  console.log("Teacher PDF saved:", outputPath);
}

main().catch((err) => {
  console.error("Unhandled error:", err.message);
  process.exit(1);
});
