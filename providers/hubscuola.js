import fsExtra from "fs-extra";
import fs from "fs/promises";
import path from "path";
import yargs from "yargs";
import PromptSync from "prompt-sync";

import { normalizePlatform, hubInternalLogin } from "./src/hubscuola/auth.js";
import { fetchHubLibrary } from "./src/hubscuola/library.js";
import { fetchBookInfo, downloadAndExtractPackage, readChaptersFromDb, downloadChapters } from "./src/hubscuola/download.js";
import { mergeChapterPdfs } from "./src/hubscuola/merge.js";
import { applyAnnotations } from "./src/hubscuola/annotations.js";

const prompt = PromptSync({ sigint: true });

export async function run(options = {}) {
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
    .option("username", {
      alias: "u",
      description: "HubScuola username (email)",
      type: "string",
    })
    .option("password", {
      alias: "w",
      description: "HubScuola password",
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
      default: false,
    })
    .option("annotations", {
      alias: "a",
      description: "Download and draw annotations on the PDF",
      type: "boolean",
      default: false,
    })
    .help()
    .alias("help", "h").argv;

  await fsExtra.ensureDir("temp");

  const tempFiles = await fs.readdir("temp");
  for (const file of tempFiles) {
    await fsExtra.remove(path.join("temp", file));
  }

  let platform = options.platform || argv.platform;

  while (!platform) {
    platform = prompt("Input the platform (either 'hubyoung' or 'hubkids'): ");
    if (platform !== "hubyoung" && platform !== "hubkids") {
      console.log("Invalid platform, please input either 'hubyoung' or 'hubkids'");
      platform = null;
    }
  }

  const normalizedPlatform = normalizePlatform(platform);

  let username = options.username || argv.username;
  let password = options.password || argv.password;
  let token = options.token || argv.token;

  if (!token) {
    while (!username) {
      username = prompt("Input username (email): ");
    }
    while (!password) {
      password = prompt("Input password: ", { echo: "*" });
    }

    try {
      const login = await hubInternalLogin({ username, password, platform });
      token = login.tokenId;
    } catch (err) {
      console.error("[HubScuola] login fallito", {
        platform: normalizedPlatform,
        username,
        message: err.message,
      });
      throw err;
    }
  }

  let volumeId = options.volumeId || argv.volumeId;

  if (!volumeId) {
    try {
      const books = await fetchHubLibrary(token, normalizedPlatform);
      if (books.length) {
        console.log("Libri trovati:");
        console.table(
          Object.fromEntries(
            books.map((b) => [
              b.volumeId,
              [b.title, b.subtitle, b.editor].filter(Boolean).join(" - "),
            ])
          )
        );
      }
    } catch (err) {
      console.warn("Impossibile caricare libreria HubScuola:", err.message);
    }
  }

  while (!volumeId) {
    volumeId = prompt("Input the volume ID: ");
  }

  console.log("Fetching book info...");

  const result = await fetchBookInfo(token, normalizedPlatform, volumeId);
  if (!result) return;

  const title = result.title;
  console.log(`Downloading "${title}"...`);

  await downloadAndExtractPackage(token, volumeId);

  const chapters = readChaptersFromDb(normalizedPlatform, volumeId);
  if (!chapters) return;

  const validChapters = chapters.filter((chapter) => chapter?.chapterId);
  const skippedChapters = chapters.filter((chapter) => !chapter?.chapterId);

  console.log(`Downloading ${chapters.length} chapter(s)...`);
  if (skippedChapters.length) {
    console.warn(`Skipping ${skippedChapters.length} chapter(s) without chapterId`);
  }

  await downloadChapters(token, volumeId, validChapters);

  const safeTitle = title.replace(/[^a-z0-9]/gi, "_");
  const tempPdfPath = await mergeChapterPdfs(validChapters, safeTitle);

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || ".";
  const baseName = options.file || argv.file || `${safeTitle}.pdf`;
  const outputPath = path.join(outputDir, baseName);

  await fsExtra.ensureDir(outputDir);

  const wantAnnotations = options.annotations || argv.annotations;

  if (!wantAnnotations) {
    console.log("Skipping annotations. Copying PDF...");
    await fs.copyFile(tempPdfPath, outputPath);
  } else {
    await applyAnnotations(token, normalizedPlatform, volumeId, tempPdfPath, outputPath);
  }

  if (!argv.noCleanUp) {
    fsExtra.removeSync("temp");
  }

  console.log(`OURBOOKS_OUTPUT: ${outputPath}`);
}
