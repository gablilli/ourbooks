import fetch from "node-fetch";
import { parseStringPromise as parseString } from "xml2js";
import SVGtoPDF from "svg-to-pdfkit";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import aesjs from "aes-js";
import forge from "node-forge";
import ZipStream from "zip-stream";
import { USER_AGENT, KITABOO_PREFETCH_WINDOW } from "./constants.js";
import { getSetCookies, mergeCookieHeaders } from "./cookies.js";
import { fetchWithRetry, normalizePageId, parseSvgPageSize } from "./utils.js";
import { loadKitabooTextPages, drawInvisibleTextLayer } from "./textLayer.js";

PDFDocument.prototype.addSVG = function (svg, x, y, options) {
	return SVGtoPDF(this, svg, x, y, options), this;
};

async function decryptFile(encryptionKey, encryptedData) {
	let key = Buffer.from(encryptionKey, "utf8").slice(0, 16);
	const aesCtr = new aesjs.ModeOfOperation.cbc(key, key);
	let decryptedBytes = aesCtr.decrypt(Buffer.from(encryptedData, "base64"));
	for (let i = 16; i > 0; i--) {
		if (decryptedBytes.slice(decryptedBytes.length - i).every(e => e == i)) {
			decryptedBytes = decryptedBytes.slice(0, decryptedBytes.length - i);
			break;
		}
	}
	const decryptedText = aesjs.utils.utf8.fromBytes(decryptedBytes);
	return decryptedText;
}

function createKitabooPageAssetTask(itemref, items, ebookID, readerCookies, encryptionKey) {
	const idref = itemref.$.idref;
	const headers = {
		"User-Agent": USER_AGENT,
		"Referer": "https://webreader.zanichelli.it/",
		cookie: readerCookies,
	};

	const formats = [
		{ kind: 'svg', key: `images${idref}svgz`, timeoutMs: 10000 },
		{ kind: 'png', key: `images${idref}png`, timeoutMs: 10000 },
		{ kind: 'jpg', key: `images${idref}jpg`, timeoutMs: 5000 },
	];

	return async () => {
		for (const format of formats) {
			const href = items[format.key];
			if (!href) continue;

			const url = `https://webreader.zanichelli.it/${ebookID}/html5/${ebookID}/OPS/${href}`;
			const encryptedPayload = await fetchWithRetry(url, headers, format.timeoutMs);
			const payload = await decryptFile(encryptionKey, encryptedPayload);

			return {
				idref,
				kind: format.kind,
				payload,
				imageName: path.posix.basename(href),
				fallbackPageSize: format.kind === 'svg' ? parseSvgPageSize(payload) : null,
			};
		}

		throw new Error(`Unable to find suitable format for ${idref}`);
	};
}

function shouldLogKitabooProgress(index, total) {
	return index < 3 || index === total - 1 || (index + 1) % 10 === 0;
}

export async function downloadKitabooBook(bookReaderUrl, outputDir, sessionCookies = '') {
	bookReaderUrl = new URL(bookReaderUrl.hash.substring(1), 'https://webreader.zanichelli.it');

	let bookID = bookReaderUrl.searchParams.get('bookID');
	let usertoken = bookReaderUrl.searchParams.get('usertoken');

	console.log("Exchangin usertoken...");

	usertoken = await fetch(`https://microservices.kitaboo.eu/v1/zanichelli/user/123/pc/validateUserToken?usertoken=${encodeURIComponent(usertoken)}`, {
		headers: {
			"User-Agent": USER_AGENT,
		},
	}).then(res => res.json()).then(res => res.userToken).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	console.log("Fetching book details...");

	let bookDetails = await fetch(`https://zanichelliservices.kitaboo.eu/DistributionServices/services/api/reader/distribution/123/pc/book/details?bookID=${bookID}&t=${Date.now()}`, {
		headers: {
			"User-Agent": USER_AGENT,
			usertoken,
			cookie: `usertoken=${usertoken}`,
		},
	}).then((res) => res.json()).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	const bookEntry = bookDetails.bookList[0];
	let ebookID = bookEntry.book.ebookID;
	const textBookId =
		bookEntry.book?.bookId
		|| bookEntry.bookId
		|| bookEntry.book?.ebookID
		|| bookEntry.book?.id
		|| ebookID;

	console.log("Obtaining encryption encryption key..."); // yeah, that's not a typo

	let downloadBookRequest = await fetch(`https://webreader.zanichelli.it/downloadapi/auth/contentserver/book/123234234/HTML5/${bookID}/downloadBook?state=online`, {
		headers: {
			"User-Agent": USER_AGENT, // refuses to respond without it
			"Referer": "https://webreader.zanichelli.it/",
			usertoken,
			cookie: `usertoken=${usertoken}`,
		}, // and wtf is 123234234 supposed to be? it doesn't seem to do anything, but it needs to be there or it returns 403 forbidden, nice job zanichelli
	}).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	let downloadBook = await downloadBookRequest.json();

	let readerCookies = mergeCookieHeaders(getSetCookies(downloadBookRequest), [`usertoken=${usertoken}`]);

	let rawPrivateKey = downloadBook.privateKey;
	let jwtToken = downloadBook.jwtToken; // note how jwt = json web token, so what you are saying is json web token token... gg

	if (bookDetails.bookList[0].book.assetType == "BOOK") {
		console.log("Detected standard book, downloading as PDF");

		console.log("Fetching encrypted encryption key...");

		let encryptedEncryptionKey = await fetch(`https://webreader.zanichelli.it/${ebookID}/html5/${ebookID}/OPS/enc_resource.key`, {
			headers: {
				"User-Agent": USER_AGENT,
				"Referer": "https://webreader.zanichelli.it/",
				authorization: jwtToken,
				cookie: readerCookies
			},
		}).then((res) => res.text()).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		console.log("Processing...");

		console.log("Decrypting encryption key...");

		let privateKey = "-----BEGIN RSA PRIVATE KEY-----\n";
		privateKey += rawPrivateKey.match(/.{1,64}/g).join('\n');
		privateKey += "\n-----END RSA PRIVATE KEY-----";

		let key = forge.pki.privateKeyFromPem(privateKey);
		let encryptionKey = key.decrypt(forge.util.decode64(encryptedEncryptionKey));

		console.log("Fetching book content...");

		let content = await fetch(`https://webreader.zanichelli.it/${ebookID}/html5/${ebookID}/OPS/content.opf`, {
			headers: {
				"User-Agent": USER_AGENT,
				"Referer": "https://webreader.zanichelli.it/",
				cookie: readerCookies
			}
		}).then((res) => res.text()).then(parseString).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		if (content.Error) {
			console.log("Error: ", ...content.Error.Code, ...content.Error.Message);
			process.exit(1);
		}

		let title = content.package.metadata[0]["dc:title"][0];

		let items = {};

		for (let item of content.package.manifest[0].item) {
			if (['image/svg+xml', 'image/png', 'image/jpeg'].includes(item.$['media-type'])) items[item.$.id] = item.$.href;
		}

		let textPages = [];
		let pageManifestByImage = new Map();
		try {
			console.log("Fetching selectable text layer...");
			const textLayer = await loadKitabooTextPages(usertoken, textBookId, sessionCookies, readerCookies, jwtToken);
			textPages = textLayer.pages;
			pageManifestByImage = textLayer.pageManifestByImage;
			console.log(`Loaded text for ${textPages.length} pages`);
		} catch (err) {
			console.warn("Unable to load selectable text layer:", err.message);
		}

		const textPagesById = new Map(textPages.map((page) => [page.pageId, page]));

		const pdfPath = path.join(outputDir, title.replace(/[^a-z0-9]/gi, '_') + '.pdf');
		const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
		const writeStream = fs.createWriteStream(pdfPath);
		doc.pipe(writeStream);
		const pageItemrefs = content.package.spine[0].itemref;
		const pageTasks = pageItemrefs.map((itemref) => createKitabooPageAssetTask(itemref, items, ebookID, readerCookies, encryptionKey));
		const pendingPageTasks = new Map();
		let nextTaskIndex = 0;

		const schedulePageTasks = () => {
			while (nextTaskIndex < pageTasks.length && pendingPageTasks.size < KITABOO_PREFETCH_WINDOW) {
				pendingPageTasks.set(nextTaskIndex, pageTasks[nextTaskIndex]());
				nextTaskIndex++;
			}
		};

		schedulePageTasks();

		for (let index = 0; index < pageItemrefs.length; index++) {
			const itemref = pageItemrefs[index];
			if (shouldLogKitabooProgress(index, pageItemrefs.length)) {
				console.log(`Downloading page ${index + 1}/${pageItemrefs.length}`);
			}

			const pageAsset = await pendingPageTasks.get(index);
			pendingPageTasks.delete(index);
			schedulePageTasks();

			let pageSize = null;
			const imageName = pageAsset.imageName;

			if (pageAsset.kind === 'svg') {
				pageSize = pageManifestByImage.get(imageName) || pageAsset.fallbackPageSize || { width: 612, height: 792 };
				pageSize = { width: pageSize.width, height: pageSize.height };
				doc.addPage({ size: [pageSize.width, pageSize.height], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
				doc.addSVG(pageAsset.payload, 0, 0, { width: pageSize.width, height: pageSize.height, preserveAspectRatio: "none" });
			} else if (pageAsset.kind === 'png') {
				const pngImage = doc.openImage(pageAsset.payload);
				const manifestPage = pageManifestByImage.get(imageName);
				pageSize = manifestPage ? { width: manifestPage.width, height: manifestPage.height } : { width: pngImage.width, height: pngImage.height };
				doc.addPage({ size: [pageSize.width, pageSize.height], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
				doc.image(pngImage, 0, 0, { width: pageSize.width, height: pageSize.height });
			} else if (pageAsset.kind === 'jpg') {
				const jpegImage = doc.openImage(pageAsset.payload);
				const manifestPage = pageManifestByImage.get(imageName);
				pageSize = manifestPage ? { width: manifestPage.width, height: manifestPage.height } : { width: jpegImage.width, height: jpegImage.height };
				doc.addPage({ size: [pageSize.width, pageSize.height], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
				doc.image(jpegImage, 0, 0, { width: pageSize.width, height: pageSize.height });
			}

			const candidatePageIds = (String(itemref.$.idref).match(/\d+/g) || []).map((value) => normalizePageId(value));
			const manifestPage = imageName ? pageManifestByImage.get(imageName) : null;
			const textPage = [
				manifestPage?.pageId ? textPagesById.get(manifestPage.pageId) : null,
				...candidatePageIds.map((pageId) => textPagesById.get(pageId)),
			].find(Boolean);
			if (textPage) {
				drawInvisibleTextLayer(doc, textPage);
			}
		}

		doc.end();

		await new Promise((resolve, reject) => {
			writeStream.on('finish', resolve);
			writeStream.on('error', reject);
		});

		let fileExists = false;
		for (let i = 0; i < 50; i++) {
			try {
				const stats = await fs.promises.stat(pdfPath);
				if (stats.size > 0) {
					fileExists = true;
					break;
				}
			} catch (e) {}
			await new Promise(resolve => setTimeout(resolve, 200));
		}

		if (!fileExists) {
			console.error('PDF file was not created');
			console.error('Expected file: ' + pdfPath);
			console.error('Current directory: ' + process.cwd());
			process.exit(1);
		}

		console.log("Done! PDF saved: " + pdfPath);
		console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
	} else if (bookDetails.bookList[0].book.assetType == "EPUB") {
		console.log("Detected liquid book, downloading as EPUB");

		const archive = new ZipStream({ store: true });

		archive.on("error", function (err) {
			throw err;
		});

		function saveFile(fileName, content) {
			return new Promise((resolve, reject) => {
				archive.entry(content, {
					name: fileName,
				}, (err, res) => {
					if (err) reject(err);
					else resolve(res);
				});
			});
		}

		const epubPath = path.join(outputDir, bookDetails.bookList[0].book.title.trim().replace(/[^a-z0-9]/gi, '_') + ".epub");
		archive.pipe(fs.createWriteStream(epubPath));

		console.log("Fetching container file");

		const rootUrl = `https://webreader.zanichelli.it/${ebookID}/fixed_epub_image/${ebookID}/`;

		const containerFile = await fetch(rootUrl + "META-INF/container.xml", {
			headers: {
				"User-Agent": USER_AGENT,
				"Referer": "https://webreader.zanichelli.it/",
				cookie: readerCookies
			}
		}).then((res) => res.text()).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		const parsedContainerFile = await parseString(containerFile);
		const rootFileUrl = parsedContainerFile.container.rootfiles[0].rootfile[0].$['full-path'];

		await saveFile("META-INF/container.xml", containerFile);

		console.log("Fetching root file");

		const rootFile = await fetch(rootUrl + rootFileUrl, {
			headers: {
				"User-Agent": USER_AGENT,
				"Referer": "https://webreader.zanichelli.it/",
				cookie: readerCookies
			}
		}).then((res) => res.text()).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		const parsedRootFile = await parseString(rootFile);

		await saveFile(rootFileUrl, rootFile);

		const prefix = path.dirname(rootFileUrl) + '/';

		for (let i = 0; i < parsedRootFile.package.manifest[0].item.length; i++) {
			console.log(`Fetching content ${i + 1}/${parsedRootFile.package.manifest[0].item.length}`);

			const fileEntry = parsedRootFile.package.manifest[0].item[i];
			const file = await fetch(rootUrl + prefix + fileEntry.$['href'], {
				headers: {
					"User-Agent": USER_AGENT,
					"Referer": "https://webreader.zanichelli.it/",
					cookie: readerCookies
				}
			}).then(res => {
				if (!res.ok) throw res;
				return res;
			}).then(async (res) => Buffer.from(await res.arrayBuffer())).catch((err) => {
				console.log("Error: ", err);
				process.exit(1);
			});

			await saveFile(prefix + fileEntry.$['href'], file);
		}

		console.log("Finalising");

		archive.finalize();
		console.log("Done! You'll find the EPUB where it was requested as " + epubPath);
		console.log(`OURBOOKS_OUTPUT:${epubPath}`);
	} else {
		console.log(`Unknown book type (${bookDetails.bookList[0].book.assetType}), please open an issue on github`);
	}
}