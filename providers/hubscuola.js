import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import PDFMerger from "pdf-merger-js";
import fetch from "node-fetch";
import fsExtra from "fs-extra";
import fs from "fs/promises";
import path from "path";
import yargs from "yargs";
import PromptSync from "prompt-sync";
import { PDFDocument, rgb } from "pdf-lib";

const prompt = PromptSync({ sigint: true });

function preview(value, limit = 500) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "<empty>";
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "<unserializable>";
  }
}

function normalizePlatform(platform) {
  return platform === "hubkids" ? "kids" : "young";
}

function extractCookiesFromHeaders(headers) {
  const fromRaw = headers.raw?.()["set-cookie"] || [];
  if (Array.isArray(fromRaw) && fromRaw.length) {
    return fromRaw.map((c) => c.split(";")[0]).filter(Boolean);
  }

  const single = headers.get?.("set-cookie");
  if (!single) return [];
  return single
    .split(/,\s*(?=[A-Za-z0-9_\-]+=)/)
    .map((c) => c.split(";")[0])
    .filter(Boolean);
}

async function readJsonLoose(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return { rawText: text };
      }
    }
    return { rawText: text };
  }
}

async function hubInternalLogin({ username, password, platform }) {
  const normalizedPlatform = normalizePlatform(platform);

  const credentialsPayload = {
    idSito: "ED",
    username,
    password,
    rememberMe: false,
    domain: "hubscuola",
    gRecaptchaResponse: "",
    verifyRecaptcha: false,
    addFullProfile: true,
    addHubEncryptedUser: true,
    refreshLocalData: true,
    activatePromos: true,
  };

  const commonHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.hubscuola.it",
    "Referer": "https://www.hubscuola.it/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Priority": "u=0",
    "TE": "trailers",
    "Connection": "keep-alive",
  };

  async function performHubLogin(useWrappedBody = false) {
    const body = useWrappedBody
      ? JSON.stringify({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentialsPayload),
        })
      : JSON.stringify(credentialsPayload);

    const res = await fetch("https://bce.mondadorieducation.it/app/mondadorieducation/login/hubLoginJsonp", {
      method: "POST",
      headers: commonHeaders,
      body,
    });

    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: loginRes, json: loginJson } = await performHubLogin(false);

  if (
    (loginRes.ok && loginJson?.result === "ERROR" && loginJson?.errorCode === "ERRNOPAG")
    || (!loginRes.ok)
  ) {
    ({ res: loginRes, json: loginJson } = await performHubLogin(true));
  }

  if (!loginRes.ok || loginJson?.result !== "OK") {
    const msg = loginJson?.message || loginJson?.error || `Hub login failed (${loginRes.status})`;
    console.error("[hubLoginJsonp] errore", {
      status: loginRes.status,
      statusText: loginRes.statusText,
      platform: normalizedPlatform,
      username,
      payloadPreview: preview(loginJson),
    });
    throw new Error(msg);
  }

  const loginData = loginJson?.data || {};
  const loginToken = loginData?.loginToken;
  if (!loginToken) {
    throw new Error("loginToken non presente nella risposta hubLoginJsonp");
  }

  const hubEncryptedUser = loginData?.hubEncryptedUser || "";
  const loginSessionId = loginData?.sessionId || "";

  const appOrigin = `https://${normalizedPlatform}.hubscuola.it`;

  const internalHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": appOrigin,
    "Referer": `${appOrigin}/`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Connection": "keep-alive",
    "TE": "trailers",
  };

  function decodeJwtPayload(token) {
    try {
      const part = token.split(".")[1];
      if (!part) return {};
      const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      return {};
    }
  }

  const decodedUser = hubEncryptedUser ? decodeJwtPayload(hubEncryptedUser) : {};
  const decodedLoginToken = decodeJwtPayload(loginToken);

  const resolvedUsername =
    decodedLoginToken?.username
    || decodedUser?.username
    || username;

  const resolvedSessionId =
    loginSessionId
    || decodedLoginToken?.sessionId
    || "";

  if (!resolvedSessionId) {
    throw new Error("sessionId non presente nella risposta hubLoginJsonp");
  }

  const resolvedEmail =
    decodedLoginToken?.email
    || decodedUser?.email
    || username;

  const resolvedFirstName =
    decodedLoginToken?.nome
    || decodedUser?.firstName
    || decodedUser?.name
    || "";

  const resolvedLastName =
    decodedLoginToken?.cognome
    || decodedUser?.lastName
    || decodedUser?.surname
    || "";

  const resolvedType =
    decodedLoginToken?.tipoUtente
    || decodedUser?.type
    || "studente";

  const resolvedUserId =
    String(decodedLoginToken?.idUtente || decodedUser?.id || decodedUser?.userId || "");

  const internalPayloadPrimary = {
    jwt: hubEncryptedUser,
    sessionId: resolvedSessionId,
    userData: decodedUser,
    app: {
      name: normalizedPlatform === "kids" ? "HUB Kids" : "HUB Young",
      type: normalizedPlatform,
      version: "7.6",
    },
    browser: {
      major: "148",
      name: "Firefox",
      version: "148.0",
      platform: "web",
    },
    so: {
      name: "Mac OS",
      version: "10.15",
    },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    username: resolvedUsername,
  };

  const internalPayloadLegacy = {
    username: resolvedUsername,
    email: resolvedEmail,
    type: resolvedType,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    tokenId: loginToken,
    appData: {
      name: normalizedPlatform === "kids" ? "Hub Kids" : "Hub Young",
      id: normalizedPlatform,
      version: "7.6",
    },
    id: resolvedUserId,
    role: decodedUser?.role || "user",
  };

  async function doInternalLogin(payload) {
    const res = await fetch("https://ms-api.hubscuola.it/user/internalLogin", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(payload),
    });
    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadPrimary);

  if (!internalRes.ok) {
    ({ res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadLegacy));
  }

  if (!internalRes.ok) {
    const msg = internalJson?.message || internalJson?.error || internalJson?.response || `internalLogin failed (${internalRes.status})`;
    console.error("[internalLogin] errore", {
      status: internalRes.status,
      statusText: internalRes.statusText,
      platform: normalizedPlatform,
      username,
      resolvedUsername,
      resolvedSessionIdPreview: resolvedSessionId ? `${resolvedSessionId.slice(0, 12)}...` : "",
      jwtPreview: loginToken ? `${loginToken.slice(0, 16)}...` : "",
      loginSessionIdPreview: loginSessionId ? `${String(loginSessionId).slice(0, 12)}...` : "",
      payloadPreview: preview(internalJson),
      sentPayload: JSON.stringify(internalPayloadPrimary),
    });
    throw new Error(msg);
  }

  const tokenId = internalJson?.tokenId || internalJson?.data?.tokenId || internalJson?.session?.tokenId || internalJson?.response?.tokenId;
  if (!tokenId) {
    throw new Error("tokenId non presente nella risposta internalLogin");
  }

  return { tokenId, normalizedPlatform };
}

async function fetchHubLibrary(token, platform) {
  const res = await fetch(
    `https://ms-api.hubscuola.it/getLibrary/${platform}?version=7.6&platform=web&app=v2`,
    {
      headers: {
        "Token-Session": token,
        "Accept": "application/json",
      },
    }
  );

  const payload = await res.json().catch(() => []);
  if (!res.ok) {
    const msg = payload?.message || payload?.error || `Errore libreria HubScuola (${res.status})`;
    console.error("[getLibrary] errore", {
      status: res.status,
      statusText: res.statusText,
      platform,
      payloadPreview: preview(payload),
    });
    throw new Error(msg);
  }

  const books = Array.isArray(payload) ? payload : (payload?.data || []);
  return books
    .filter((b) => b && (b.id || b.volumeId))
    .map((b) => ({
      volumeId: String(b.id || b.volumeId),
      title: b.title || b.name || `Libro ${b.id || b.volumeId}`,
      subtitle: b.subtitle || "",
      editor: b.editor || "",
    }));
}

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
      default: false
    })
    .option("annotations", {
      alias: "a",
      description: "Download and draw annotations on the PDF",
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
  const normalizedPlatform = normalizePlatform(platform);

  let username = options.username || argv.username;
  let password = options.password || argv.password;

  let token = options.token || argv.token;
  if (!token) {
    while (!username) username = prompt("Input username (email): ");
    while (!password) password = prompt("Input password: ", { echo: '*' });

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
            books.map((b) => [b.volumeId, [b.title, b.subtitle, b.editor].filter(Boolean).join(" - ")])
          )
        );
      }
    } catch (err) {
      console.warn("Impossibile caricare libreria HubScuola:", err.message);
    }
  }
  while (!volumeId) volumeId = prompt("Input the volume ID: ");

  console.log("Fetching book info...");

  let title;

  let response = await fetch("https://ms-api.hubscuola.it/me" + normalizedPlatform + "/publication/" + volumeId, { 
    method: "GET", 
    headers: { "Token-Session": token, "Content-Type": "application/json" } 
  });
  const code = response.status;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.log(`Failed fetching book info (status ${code})`, { platform: normalizedPlatform, volumeId, bodyPreview: preview(body) });
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
    const body = await res.text().catch(() => "");
    console.error("API error:", res.status, { volumeId, bodyPreview: preview(body) });
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

  const dbPath = `me${normalizedPlatform}/publication/${volumeId}`;
  const row = db.prepare("SELECT offline_value FROM offline_tbl WHERE offline_path=?").get(dbPath);
  if (!row) {
    console.error(`Impossibile trovare il libro nel database per il percorso: ${dbPath}`);
    return;
  }
  let chapters = JSON.parse(row.offline_value).indexContents.chapters;

  db.close();

  console.log(`Downloading ${chapters.length} chapter(s)...`)

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

  const outputDir = process.env.OURBOOKS_OUTPUT_DIR || ".";
  const baseName = (options.file || argv.file || `${title.replace(/[^a-z0-9]/gi, '_')}.pdf`);
  const outputPath = path.join(outputDir, baseName);
  await fsExtra.ensureDir(outputDir);

  const wantAnnotations = options.annotations || argv.annotations;

  if (!wantAnnotations) {
    console.log("Skipping annotations. Copying PDF...");
    await fs.copyFile(tempPdfPath, outputPath);
  } else {
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

      const { lines } = data;

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
      const hasSymmetricPadding =
        deltaX > 10 &&
        deltaY > 10 &&
        Math.abs(deltaX - deltaY) < 2;

      let mapPoint;
      let thicknessScale;

      if (hasSymmetricPadding) {
        const offsetX = deltaX / 2;
        const offsetY = deltaY / 2;
        mapPoint = (x, y) => ({
          x: x + offsetX,
          y: (srcHeight - y) + offsetY,
        });
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

  if (!argv.noCleanUp) fsExtra.removeSync("temp");

  console.log(`OURBOOKS_OUTPUT: ${outputPath}`);
}