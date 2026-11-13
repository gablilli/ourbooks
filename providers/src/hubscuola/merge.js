import PDFMerger from "pdf-merger-js";
import fsExtra from "fs-extra";
import path from "path";

export async function mergeChapterPdfs(validChapters, safeTitle) {
  console.log("Merging pages...");

  const merger = new PDFMerger();

  for (const chapter of validChapters) {
    const base = `./temp/build/${chapter.chapterId}`;

    if (!fsExtra.existsSync(base)) {
      console.warn(`Directory non trovata per chapterId ${chapter.chapterId}`);
      continue;
    }

    const files = fsExtra.readdirSync(base);

    for (const file of files) {
      if (file.toLowerCase().endsWith(".pdf")) {
        await merger.add(path.join(base, file));
      }
    }
  }

  const tempPdfPath = `./temp/${safeTitle}_temp.pdf`;
  await merger.save(tempPdfPath);
  return tempPdfPath;
}
