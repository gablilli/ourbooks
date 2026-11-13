import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import fetch from "node-fetch";
import fsExtra from "fs-extra";

function preview(value, limit = 500) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "<empty>";
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "<unserializable>";
  }
}

export async function fetchBookInfo(token, normalizedPlatform, volumeId) {
  const response = await fetch(
    `https://ms-api.hubscuola.it/me${normalizedPlatform}/publication/${volumeId}`,
    {
      method: "GET",
      headers: {
        "Token-Session": token,
        "Content-Type": "application/json",
      },
    }
  );

  const code = response.status;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.log(`Failed fetching book info (status ${code})`, {
      platform: normalizedPlatform,
      volumeId,
      bodyPreview: preview(body),
    });
    return null;
  }

  return response.json();
}

export async function downloadAndExtractPackage(token, volumeId) {
  console.log("Downloading package...");

  const packageRes = await fetch(
    `https://ms-mms.hubscuola.it/downloadPackage/${volumeId}/publication.zip?tokenId=${encodeURIComponent(token)}`,
    {
      headers: {
        "Token-Session": token,
        Accept: "application/zip, application/octet-stream, */*",
      },
    }
  );

  const packageBuffer = Buffer.from(await packageRes.arrayBuffer());

  console.log("Package response:", {
    status: packageRes.status,
    contentType: packageRes.headers.get("content-type"),
    size: packageBuffer.length,
    signature: packageBuffer.subarray(0, 4).toString("hex"),
  });

  if (!packageRes.ok) {
    throw new Error(
      `Package download failed: ${packageRes.status} ${packageRes.statusText}\n` +
        preview(packageBuffer.toString("utf8"), 1000)
    );
  }

  const packageSignature = packageBuffer.subarray(0, 4).toString("hex");

  if (!["504b0304", "504b0506", "504b0708"].includes(packageSignature)) {
    throw new Error(
      `publication.zip non è uno ZIP valido.\n` +
        `Content-Type: ${packageRes.headers.get("content-type")}\n` +
        `Size: ${packageBuffer.length}\n` +
        `Signature: ${packageSignature}\n` +
        `Response: ${preview(packageBuffer.toString("utf8"), 1000)}`
    );
  }

  console.log("Extracting...");
  const packageZip = new AdmZip(packageBuffer);
  await packageZip.extractAllTo("temp/extracted-files");
}

export function readChaptersFromDb(normalizedPlatform, volumeId) {
  console.log("Reading chapter list...");

  const db = new Database("./temp/extracted-files/publication/publication.db", { readonly: true });
  const dbPath = `me${normalizedPlatform}/publication/${volumeId}`;

  const row = db
    .prepare("SELECT offline_value FROM offline_tbl WHERE offline_path=?")
    .get(dbPath);

  if (!row) {
    db.close();
    console.error(`Impossibile trovare il libro nel database per il percorso: ${dbPath}`);
    return null;
  }

  let chapters;
  try {
    chapters = JSON.parse(row.offline_value).indexContents.chapters || [];
  } catch (err) {
    db.close();
    throw new Error(`Impossibile leggere la lista dei capitoli: ${err.message}`);
  }

  db.close();
  return chapters;
}

export async function downloadChapters(token, volumeId, validChapters) {
  for (const chapter of validChapters) {
    const url =
      `https://ms-mms.hubscuola.it/public/${volumeId}/${chapter.chapterId}.zip` +
      `?tokenId=${encodeURIComponent(token)}&app=v2`;

    console.log(`Downloading chapter ${chapter.chapterId}...`);

    const chapterRes = await fetch(url, {
      headers: {
        "Token-Session": token,
        Accept: "application/zip, application/octet-stream, */*",
      },
    });

    const buffer = Buffer.from(await chapterRes.arrayBuffer());

    console.log("Chapter response:", {
      chapterId: chapter.chapterId,
      status: chapterRes.status,
      contentType: chapterRes.headers.get("content-type"),
      size: buffer.length,
      signature: buffer.subarray(0, 4).toString("hex"),
    });

    if (!chapterRes.ok) {
      throw new Error(
        `Errore download capitolo ${chapter.chapterId}: ` +
          `${chapterRes.status} ${chapterRes.statusText}\n` +
          preview(buffer.toString("utf8"), 500)
      );
    }

    const signature = buffer.subarray(0, 4).toString("hex");

    if (!["504b0304", "504b0506", "504b0708"].includes(signature)) {
      throw new Error(
        `Il capitolo ${chapter.chapterId} non è uno ZIP valido.\n` +
          `Content-Type=${chapterRes.headers.get("content-type")}\n` +
          `signature=${signature}\n` +
          `size=${buffer.length}\n` +
          `Risposta: ${preview(buffer.toString("utf8"), 500)}`
      );
    }

    const zip = new AdmZip(buffer);
    await zip.extractAllTo("temp/build");
  }
}
