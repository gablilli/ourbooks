import PromptSync from "prompt-sync";
import fetch from "node-fetch";
import { parseStringPromise as parseString } from "xml2js";
import SVGtoPDF from "svg-to-pdfkit";
import PDFDocument from "pdfkit";
import PDFMerger from "pdf-merger-js";
import fs from "fs";
import path from "path";
import aesjs from "aes-js";
import forge from "node-forge";
import yargs from "yargs";
import { spawn } from "child_process";
import ZipStream from "zip-stream";

const prompt = PromptSync({ sigint: true });
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const WEBREADER_REFERER = "https://webreader.zanichelli.it/6.0/zanichelli/";
const KITABOO_PREFETCH_WINDOW = 16; // depends on where u run it
const KITABOO_FETCH_RETRIES = 3;

const argv = yargs(process.argv.slice(2))
	.option("username", {
		alias: "u",
		type: "string",
		description: "Username(email)",
	})
	.option("password", {
		alias: "p",
		type: "string",
		description: "Password",
	})
	.option("isbn", {
		alias: "i",
		type: "string",
		description: "ISBN",
	})
	.option("booktab-isbn", {
		alias: "b",
		type: "string",
		description: "Overwrite the booktab ISBN (which is different from the normal ISBN)",
	})
	.option("ocr", {
		type: "string",
		description: "Run OCR on output (on/off)",
		default: null,
	})
	.help()
	.alias("help", "h")
	.argv;

PDFDocument.prototype.addSVG = function (svg, x, y, options) {
	return SVGtoPDF(this, svg, x, y, options), this;
};

function runOCR(inputPdf, outputPdf) {
	return new Promise((resolve, reject) => {
		console.log(`OCR: converting "${inputPdf}" to "${outputPdf}"...`);
		const ocr = spawn('ocrmypdf', [inputPdf, outputPdf], { stdio: 'inherit' });
		ocr.on('close', (code) => {
			if (code === 0) {
				console.log("OCR completed successfully");
				resolve();
			}
			else reject(`OCRmyPDF exited with code ${code}`);
		});
		ocr.on('error', (err) => {
			console.error("Failed to start OCR process:", err.message);
			reject(err);
		});
	});
}

async function decryptFile(encryptionKey, encryptedData) {
	let key = Buffer.from(encryptionKey, "utf8").slice(0, 16);
	const aesCtr = new aesjs.ModeOfOperation.cbc(key, key);
	let decryptedBytes = aesCtr.decrypt(Buffer.from(encryptedData, "base64"));
	for(let i=16;i>0;i--){
		if (decryptedBytes.slice(decryptedBytes.length-i).every(e=>e==i)) {
			decryptedBytes = decryptedBytes.slice(0, decryptedBytes.length-i);
			break;
		}
	}
	const decryptedText = aesjs.utils.utf8.fromBytes(decryptedBytes);
	return decryptedText;
}

function getSetCookies(response) {
	return response.headers.raw ? (response.headers.raw()['set-cookie'] || []) : response.headers.getSetCookie();
}

const COOKIE_ATTRIBUTE_KEYS = new Set([
	'path',
	'domain',
	'expires',
	'max-age',
	'samesite',
	'secure',
	'httponly',
	'priority',
	'partitioned',
]);

function extractCookiePairs(value) {
	if (!value) return [];

	const pairs = [];
	for (const segment of String(value).split(';')) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const rawValue = trimmed.slice(eqIndex + 1).trim();
		if (!key || COOKIE_ATTRIBUTE_KEYS.has(key.toLowerCase())) continue;
		pairs.push([key, rawValue]);
	}
	return pairs;
}

function mergeCookieHeaders(...cookieGroups) {
	const cookieMap = new Map();

	for (const group of cookieGroups) {
		for (const cookie of (Array.isArray(group) ? group : [group]).filter(Boolean)) {
			for (const [key, value] of extractCookiePairs(cookie)) {
				cookieMap.set(key, value);
			}
		}
	}

	return [...cookieMap.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function asCollection(value) {
	if (value == null) return [];
	if (Array.isArray(value)) return value;
	if (typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
			return keys
				.map((key) => Number(key))
				.sort((left, right) => left - right)
				.map((key) => value[String(key)]);
		}
	}
	return [value];
}

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizePageId(value) {
	const parsed = parseInt(String(value ?? '').trim(), 10);
	return Number.isFinite(parsed) ? String(parsed) : String(value ?? '').trim();
}

function parseDimension(rawValue) {
	if (rawValue == null) return null;
	const match = String(rawValue).match(/-?\d+(?:\.\d+)?/);
	return match ? Number(match[0]) : null;
}

function parseSvgPageSize(svg) {
	const viewBoxMatch = svg.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)\s*["']/i);
	if (viewBoxMatch) {
		const width = parseDimension(viewBoxMatch[1]);
		const height = parseDimension(viewBoxMatch[2]);
		if (width && height) return { width, height };
	}

	const widthMatch = svg.match(/\bwidth=["']([^"']+)["']/i);
	const heightMatch = svg.match(/\bheight=["']([^"']+)["']/i);
	const width = parseDimension(widthMatch?.[1]);
	const height = parseDimension(heightMatch?.[1]);
	if (width && height) return { width, height };

	return null;
}

async function fetchWithRetry(url, headers, timeoutMs = 10000, retries = KITABOO_FETCH_RETRIES) {
	let lastError = null;

	for (let attempt = 1; attempt <= retries; attempt++) {
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

		try {
			const response = await fetch(url, {
				headers,
				signal: abortController.signal,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return await response.text();
		} catch (err) {
			lastError = err;
			if (attempt === retries) break;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	throw lastError;
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

function normalizePageManifestEntry(entry) {
	if (!entry || typeof entry !== 'object') return null;

	const pageId = normalizePageId(entry.page);
	const width = toNumber(entry.width);
	const height = toNumber(entry.height);
	const image = entry.image ? path.posix.basename(String(entry.image)) : null;

	if (!pageId || width == null || height == null) return null;

	return {
		pageId,
		width,
		height,
		image,
		path: entry.path ? String(entry.path) : null,
	};
}

function normalizeWordNode(word, lineContext) {
	const text = String(word?.content ?? '').replace(/\s+/g, ' ').trim();
	const x = toNumber(word?.x);
	const width = toNumber(word?.width);
	const lineHeight = toNumber(lineContext?.height);
	const baselineY = toNumber(lineContext?.y);

	if (!text || x == null || width == null || lineHeight == null || baselineY == null) {
		return null;
	}

	return {
		text,
		x,
		y: baselineY - lineHeight,
		width,
		height: lineHeight,
	};
}

function collectTextWords(root) {
	const words = [];
	const seen = new Set();

	function visit(node, lineContext = null) {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);

		const currentLineContext = toNumber(node.y) != null && toNumber(node.height) != null ? node : lineContext;
		for (const word of asCollection(node.word ?? node.words)) {
			const normalized = normalizeWordNode(word, currentLineContext);
			if (normalized) {
				words.push(normalized);
			}
		}

		for (const value of asCollection(node.line ?? node.lines)) {
			if (value && typeof value === 'object') visit(value, currentLineContext);
		}

		for (const value of asCollection(node.para ?? node.paragraph ?? node.paragraphs)) {
			if (value && typeof value === 'object') visit(value, currentLineContext);
		}

		for (const value of Object.values(node)) {
			if (value && typeof value === 'object') visit(value, currentLineContext);
		}
	}

	visit(root);

	const deduped = [];
	const dedupeKeys = new Set();
	for (const word of words) {
		const key = `${Math.round(word.y * 100)}|${Math.round(word.x * 100)}|${word.text}`;
		if (dedupeKeys.has(key)) continue;
		dedupeKeys.add(key);
		deduped.push(word);
	}

	return deduped;
}

function buildTextPageMetrics(words, explicitWidth = null, explicitHeight = null) {
	if (!words.length) {
		return {
			sourceWidth: explicitWidth,
			sourceHeight: explicitHeight,
			hasExplicitSize: explicitWidth != null && explicitHeight != null,
		};
	}

	const minX = Math.min(...words.map((word) => word.x));
	const minY = Math.min(...words.map((word) => word.y));
	const maxX = Math.max(...words.map((word) => word.x + word.width));
	const maxY = Math.max(...words.map((word) => word.y + word.height));

	const inferredWidth = Math.max(maxX, maxX + Math.max(0, minX));
	const inferredHeight = Math.max(maxY, maxY + Math.max(0, minY));

	return {
		sourceWidth: explicitWidth ?? inferredWidth,
		sourceHeight: explicitHeight ?? inferredHeight,
		hasExplicitSize: explicitWidth != null && explicitHeight != null,
	};
}

function normalizeTextPage(rawPage, manifestEntry = null) {
	if (!rawPage || typeof rawPage !== 'object') return null;

	const pageId = normalizePageId(rawPage.page_id ?? rawPage.pageId ?? rawPage.id ?? manifestEntry?.pageId);
	const pageRoot = rawPage.pages?.page ?? rawPage.page ?? rawPage.pages ?? rawPage;
	const words = collectTextWords(pageRoot);
	if (!words.length) return null;

	const explicitWidth =
		toNumber(manifestEntry?.width)
		?? toNumber(rawPage.width)
		?? toNumber(pageRoot?.width)
		?? toNumber(rawPage.page_width)
		?? null;
	const explicitHeight =
		toNumber(manifestEntry?.height)
		?? toNumber(rawPage.height)
		?? toNumber(pageRoot?.height)
		?? toNumber(rawPage.page_height)
		?? null;
	const metrics = buildTextPageMetrics(words, explicitWidth, explicitHeight);

	return {
		pageId,
		words,
		image: manifestEntry?.image ?? null,
		...metrics,
	};
}

function normalizeTextChunk(chunk, pageManifestById = new Map()) {
	if (Array.isArray(chunk)) {
		return chunk
			.map((page) => normalizeTextPage(page, pageManifestById.get(normalizePageId(page?.page_id ?? page?.pageId ?? page?.id))))
			.filter((page) => page?.words?.length);
	}

	if (chunk?.page_id != null || chunk?.pageId != null) {
		const pageId = normalizePageId(chunk?.page_id ?? chunk?.pageId ?? chunk?.id);
		const page = normalizeTextPage(chunk, pageManifestById.get(pageId));
		return page?.words?.length ? [page] : [];
	}

	if (Array.isArray(chunk?.pages)) {
		return chunk.pages
			.map((page) => normalizeTextPage(page, pageManifestById.get(normalizePageId(page?.page_id ?? page?.pageId ?? page?.id))))
			.filter((page) => page?.words?.length);
	}

	if (Array.isArray(chunk?.page)) {
		return chunk.page
			.map((page) => normalizeTextPage(page, pageManifestById.get(normalizePageId(page?.page_id ?? page?.pageId ?? page?.id))))
			.filter((page) => page?.words?.length);
	}

	return Object.values(chunk || {})
		.filter((value) => value && typeof value === 'object')
		.flatMap((value) => normalizeTextChunk(value, pageManifestById));
}

function sortPageChunkEntries(entries) {
	return [...entries].sort(([leftRange, leftFile], [rightRange, rightFile]) => {
		const leftStart = parseInt((leftRange || leftFile || '').match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER, 10);
		const rightStart = parseInt((rightRange || rightFile || '').match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER, 10);
		return leftStart - rightStart;
	});
}

async function loadKitabooTextPages(usertoken, textBookId, sessionCookies = '', readerCookies = '', jwtToken = '') {
	if (!usertoken || !textBookId || !readerCookies) return [];

	const requestHeaders = {
		"User-Agent": USER_AGENT,
		"Accept": "application/json, text/plain, */*",
		"Referer": WEBREADER_REFERER,
		authorization: jwtToken,
		usertoken,
		cookie: mergeCookieHeaders(readerCookies, sessionCookies ? [sessionCookies] : [], [`usertoken=${usertoken}`]),
	};

	const modeCandidates = ['html5', 'fixed_epub_image'];
	let effectiveMode = null;
	let pageList = null;
	let pageManifest = [];

	// lol pages.json and page-list.json
	for (const mode of modeCandidates) {
		const pagesResponse = await fetch(`https://webreader.zanichelli.it/${textBookId}/${mode}/${textBookId}/OPS/pages.json`, {
			headers: requestHeaders,
		});
		if (!pagesResponse.ok) continue;

		const pageListResponse = await fetch(`https://webreader.zanichelli.it/${textBookId}/${mode}/${textBookId}/OPS/json/page-list.json`, {
			headers: requestHeaders,
		});
		if (!pageListResponse.ok) continue;

		pageManifest = (await pagesResponse.json()).map(normalizePageManifestEntry).filter(Boolean);
		pageList = await pageListResponse.json();
		effectiveMode = mode;
		break;
	}

	if (!pageList || !effectiveMode) {
		throw new Error('page-list unavailable for text layer');
	}

	const pageManifestById = new Map(pageManifest.map((entry) => [entry.pageId, entry]));
	const pageManifestByImage = new Map(pageManifest.filter((entry) => entry.image).map((entry) => [entry.image, entry]));
	const pages = [];
	for (const [, fileName] of sortPageChunkEntries(Object.entries(pageList || {}))) {
		let chunk = null;
		for (const mode of [effectiveMode, ...modeCandidates.filter((candidate) => candidate !== effectiveMode)]) {
			const response = await fetch(`https://webreader.zanichelli.it/${textBookId}/${mode}/${textBookId}/OPS/json/${fileName}`, {
				headers: requestHeaders,
			});
			if (!response.ok) continue;
			chunk = await response.json();
			break;
		}

		if (!chunk) {
			throw new Error(`${fileName} unavailable for text layer`);
		}

		pages.push(...normalizeTextChunk(chunk, pageManifestById));
	}

	return {
		pages,
		pageManifestById,
		pageManifestByImage,
	};
}

function getTextPageScale(textPage, pageWidth, pageHeight) {
	if (!textPage?.sourceWidth || !textPage?.sourceHeight) {
		return { xScale: 1, yScale: 1 };
	}

	const rawXScale = pageWidth / textPage.sourceWidth;
	const rawYScale = pageHeight / textPage.sourceHeight;
	if (textPage.hasExplicitSize) {
		return { xScale: rawXScale, yScale: rawYScale };
	}

	return {
		xScale: rawXScale < 0.75 || rawXScale > 1.25 ? rawXScale : 1,
		yScale: rawYScale < 0.75 || rawYScale > 1.25 ? rawYScale : 1,
	};
}

function buildTextRuns(words) {
	const sortedWords = [...words].sort((left, right) => {
		const yDelta = left.y - right.y;
		if (Math.abs(yDelta) > 0.5) return yDelta;
		return left.x - right.x;
	});

	const runs = [];
	let currentRun = null;

	for (const word of sortedWords) {
		if (!currentRun) {
			currentRun = {
				words: [word],
				x: word.x,
				y: word.y,
				height: word.height,
				endX: word.x + word.width,
			};
			continue;
		}

		const sameLineTolerance = Math.max(1, currentRun.height * 0.25);
		const gap = word.x - currentRun.endX;
		const sameLine =
			Math.abs(word.y - currentRun.y) <= sameLineTolerance
			&& Math.abs(word.height - currentRun.height) <= sameLineTolerance
			&& gap >= -1
			&& gap <= currentRun.height * 6;

		if (!sameLine) {
			runs.push({
				text: currentRun.words.map((entry) => entry.text).join(' '),
				x: currentRun.x,
				y: currentRun.y,
				width: currentRun.endX - currentRun.x,
				height: currentRun.height,
			});
			currentRun = {
				words: [word],
				x: word.x,
				y: word.y,
				height: word.height,
				endX: word.x + word.width,
			};
			continue;
		}

		currentRun.words.push(word);
		currentRun.endX = Math.max(currentRun.endX, word.x + word.width);
		currentRun.height = Math.max(currentRun.height, word.height);
	}

	if (currentRun) {
		runs.push({
			text: currentRun.words.map((entry) => entry.text).join(' '),
			x: currentRun.x,
			y: currentRun.y,
			width: currentRun.endX - currentRun.x,
			height: currentRun.height,
		});
	}

	return runs;
}

function drawInvisibleTextLayer(doc, textPage) {
	if (!textPage?.words?.length) return;

	const { xScale, yScale } = getTextPageScale(textPage, doc.page.width, doc.page.height);
	const textRuns = buildTextRuns(textPage.words);

	doc.save();
	doc.fillColor('black');
	doc.fillOpacity(0);

	for (const run of textRuns) {
		const width = run.width * xScale;
		const height = run.height * yScale;
		const fontSize = Math.max(1, height * 0.85);
		const options = {
			lineBreak: false,
			width,
			height,
			paragraphGap: 0,
			characterSpacing: 0,
			features: { liga: false },
		};

		doc.fontSize(fontSize);
		const measuredWidth = doc.widthOfString(run.text, options);
		if (measuredWidth > 0) {
			options.horizontalScaling = (width / measuredWidth) * 100;
		}

		doc.text(run.text, run.x * xScale, run.y * yScale, options);
	}

	doc.restore();
}

async function downloadKitabooBook(bookReaderUrl, doOcr, outputDir, sessionCookies = '') {
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
		}, // wtf is this mess?
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

		console.log("Fetching encrypted encryption key...")

		let encryptedEncryptionKey = await fetch(`https://webreader.zanichelli.it/${ebookID}/html5/${ebookID}/OPS/enc_resource.key`, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
				"Referer": "https://webreader.zanichelli.it/",
				cookie: readerCookies 
			}
		}).then((res) => res.text()).then(parseString).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		// mention in content.metadata of render type, could be usefull in the future if other formats get added

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

			if (doOcr) {
				console.log("Running OCR on output...");
				try {
					const ocrPath = path.join(outputDir, 'ocr_' + path.basename(pdfPath));
					await runOCR(pdfPath, ocrPath);
					console.log("Done! PDF with selectable text: " + ocrPath);
					console.log(`OURBOOKS_OUTPUT:${ocrPath}`);
				} catch (err) {
					console.error("OCR error:", err.message);
					console.error("The PDF was saved without OCR as: " + pdfPath);
					console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
				}
			} else {
				console.log("Done! PDF saved: " + pdfPath);
				console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
			}
	} else if (bookDetails.bookList[0].book.assetType == "EPUB") {
		console.log("Detected liquid book, downloading as EPUB");

		const archive = new ZipStream({store: true});

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
		
		const rootUrl = `https://webreader.zanichelli.it/${ebookID}/fixed_epub_image/${ebookID}/`

		const containerFile = await fetch(rootUrl + "META-INF/container.xml", { 
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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
			console.log(`Fetching content ${i+1}/${parsedRootFile.package.manifest[0].item.length}`);

			const fileEntry = parsedRootFile.package.manifest[0].item[i];
			const file = await fetch(rootUrl + prefix + fileEntry.$['href'], { 
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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

async function downloadBookTabBook(redirectUrl, cookie, doOcr, outputDir) { // bookReaderUrl, 
	//let idOpera = bookReaderUrl.searchParams.get('idOpera');
	let isbn = redirectUrl.split('/');
	isbn = argv["booktab-isbn"] || isbn[isbn.length - 1];

	console.log("Accessing booktab...");

	let bookTabSession = await fetch('https://web-booktab.zanichelli.it/api/v1/sessions_web', {
		method: 'POST',
		headers: { cookie },
	}).then((res) => res.json()).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	cookie += `; booktab_token=${bookTabSession.session}`;

	/*console.log("Fetching available books...");

	let bookTabBooks = await fetch('https://web-booktab.zanichelli.it/api/v5/metadata', {
		headers: { cookie },
	}).then((res) => res.json()).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	let candidates = bookTabBooks.books.filter((book) => book.idBookZ == idOpera);

	console.log("Available books:"); // why is there a second list of books? I don't know, no idea, it just goes to show how shitty zanichelli's software is
	console.table(candidates, ['title', 'idBookZ', 'isbn']);*/ // probably no longer needed


	while (!isbn)
		isbn = prompt("ISBN: ");

	console.log("Fetching book details...");

	let spine = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/spine.xml`, {
		headers: { cookie },
	}).then(async (res) => {
		if (res.status == 404) {
			return fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/volume.xml`, {
				headers: { cookie },
			}).then((res) => {
				if (res.status == 404) {
					console.log('Looks like this is not a downloadable book, try another one.');
					process.exit(1);
				}
				return res.text()
			});
		}
		return res.text();
	}).then(parseString).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	const title = (spine.spine || spine.config.volume[0].settings[0]).volumetitle[0].trim().replace(/[^a-z0-9]/gi, '_');

	console.log("Downloading book...");

	const units = (spine.spine ? spine.spine.unit : spine.config.volume[0].units[0].unit).map((unit) => {
		if (unit.$.features == 'flash') return null;
		return unit.$.btbid;
	}).filter((unit) => unit != null);

	let pdfMerger = new PDFMerger();

	let isXps = false;

	for(let i = 0; i < units.length; i++) {
		console.log(`Downloading unit ${i + 1} of ${units.length}`)
		const unit = units[i];
		let config = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/config.xml`, {
			headers: { cookie },
		}).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		if (config.status != 200) continue;

		config = await config.text().then(parseString);

		let pdfUrl = config.unit.content[0];

		if (config.unit.filesMap) {
			pdfUrl = config.unit.filesMap[0].entry.find((file) => file.$.key == config.unit.content[0] + '.pdf')._;
		}

		if (isXps) {
			let xps = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/${config.unit.content[0]}.xod`, {
				headers: { cookie },
			}).then((res) => res.buffer()).catch((err) => {
				console.log("Error: ", err);
				process.exit(1);
			});

			await fs.promises.writeFile(path.join("xps_" + title, `${i}_${unit}.xps`), xps);
			continue;
		}

		let pdf = await fetch(`https://web-booktab.zanichelli.it/api/v1/resources_web/${isbn}/${unit}/${pdfUrl}.pdf`, {
			headers: { cookie },
		}).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});

		if (pdf.status == 404) {
			isXps = true;
			i = -1; // restart the loop
			console.log("DETECTED XPS FORMAT, DOWNLOADING INDIVIDUAL UNITS...");
			await fs.promises.mkdir("xps_" + title, { recursive: true }); // adding prefix to gitignore
			continue;
		}

			pdf = await pdf.buffer();
		await pdfMerger.add(pdf);
	}

	if (isXps) {
		console.log("Done! You'll find the XPS files in the directory of the script");
		console.log("Instructions:");
		console.log("1. A folder with the name of the book will be created, containing all the units in XPS format");
		console.log("2. Navigate to https://xpstopdf.com/ and convert the XPS files to PDF format");
		console.log("3. Merge the PDF files using https://www.ilovepdf.com/merge_pdf");
		console.log("If anyone would like to contribute a script to automate this process, feel free to do so");
	} else {
		console.log("Saving...");
		const pdfPath = path.join(outputDir, title + '.pdf');
		console.log("PDF path will be: " + pdfPath);
		
		try {
			await pdfMerger.save(pdfPath);
			console.log("pdfMerger.save() completed");
		} catch (mergeErr) {
			console.error("Error during pdfMerger.save():", mergeErr.message);
			process.exit(1);
		}
		
		let fileExists = false;
		for (let i = 0; i < 50; i++) {
			try {
				const stats = await fs.promises.stat(pdfPath);
				console.log(`Check ${i+1}: File size = ${stats.size} bytes`);
				if (stats.size > 0) {
					fileExists = true;
					console.log("File found!");
					break;
				}
			} catch (e) {
				console.log(`Check ${i+1}: File not found yet`);
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		
		if (!fileExists) {
			console.error('PDF file was not created');
			console.error('Expected file: ' + pdfPath);
			console.error('Current directory: ' + process.cwd());
			process.exit(1);
		}
		
			if (doOcr) {
				console.log("Running OCR on output...");
				try {
					const ocrPath = path.join(outputDir, 'ocr_' + path.basename(pdfPath));
					await runOCR(pdfPath, ocrPath);
				console.log("Done! PDF with selectable text: " + ocrPath);
				console.log(`OURBOOKS_OUTPUT:${ocrPath}`);
			} catch (err) {
				console.error("OCR error:", err.message);
				console.error("The PDF was saved without OCR as: " + pdfPath);
				console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
			}
		} else {
			console.log("Done! PDF saved: " + pdfPath);
			console.log(`OURBOOKS_OUTPUT:${pdfPath}`);
		}
	}
}

export async function run(options = {}) {
	let username = options.username || argv.username;
	let password = options.password || argv.password;
	const doOcr = (options.ocr || argv.ocr) === 'on';
	const outputDir = process.env.OURBOOKS_OUTPUT_DIR || '.';

	while (!username)
		username = prompt("Username(email): ");

	while (!password)
		password = prompt("Password: ");

	console.log("Logging in...");

	let token = await fetch("https://idp.zanichelli.it/v4/login/", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
	}).then((res) => res.json()).then((res) => res.token).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	let cookie = `token=${token}`;

	let loginCookies = await fetch("https://my.zanichelli.it/?loginMode=myZanichelli", {
		headers: { cookie },
	}).then((res) => {
		const rawCookies = res.headers.raw ? res.headers.raw()['set-cookie'] : res.headers.getSetCookie();
		return (rawCookies || []).map((cookie) => cookie.split(';')[0]);
	}).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	let dashboardCookies = {};

	for (let loginCookie of loginCookies) {
		let [key, value] = loginCookie.split('=');
		dashboardCookies[key] = value;
	}
	const sessionCookieHeader = mergeCookieHeaders([cookie], loginCookies);

	console.log("Fetching available books...");

	/*await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/init', {
		headers: { 'myz-token': dashboardCookies['myz_token'] },
	}).then(res => res.text()).then(console.log).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});*/ // keeping this, perhaps it's needed in the future

	await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/user', {
		headers: { 'myz-token': dashboardCookies['myz_token'] },
	}).then(res => res.json()).then((res) => {
		console.log(`Logged in as: ${res.firstName} ${res.lastName}`)
	}).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	}); // we don't really care about the response, but apparently it's required to access the book list

	let books = {};

	let page = 1;
	let notATeacher = false;

	while (true) {
		let response = await fetch(`https://api-catalogo.zanichelli.it/v3/dashboard/search?sort%5Bfield%5D=year_date&sort%5Bdirection%5D=desc&searchString&pageNumber=${page}&rows=100`, {
			headers: { 'myz-token': dashboardCookies['myz_token'] },
		}).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});
		if (response.status == 403) {
			notATeacher = true;
			break;
		}
		response = await response.json();
		if (!response.data || response.data.pagination.pages == 0) {
			console.log("No books found");
			process.exit(0);
		}
		for (let license of response.data.licenses || []) {
			if (license.volume.ereader_url == '') continue;
			books[license.volume.isbn] = {
				title: license.volume.opera.title,
				ereader_url: license.volume.ereader_url,
				isbns: license.volume.isbns,
			}
		}
		if (response.data.pagination.pages == page) break;
		page++;
	}

	if (notATeacher) {
		let request = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/licenses/real', {
			headers: { 'myz-token': dashboardCookies['myz_token'] },
		}).then((res) => res.json()).catch((err) => {
			console.log("Error: ", err);
			process.exit(1);
		});
		for (let license of (request.realLicenses || [])) {
			if (license.volume.ereader_url == '') continue;
			books[license.volume.isbn] = {
				title: license.volume.opera.title,
				ereader_url: license.volume.ereader_url,
				isbns: license.volume.isbns
			}
		}
	}

	console.log("Available books:");
	console.table(books, ['title']);

	let isbn = options.isbn || argv.isbn;

	while (!isbn)
		isbn = prompt("ISBN: ");
	
	console.log("Detecting reader...");

	let bookReaderUrl = await fetch(books[isbn].ereader_url, {
		headers: { cookie },
		redirect: 'manual',
	}).then((res) => res.headers.get('location')).catch((err) => {
		console.log("Error: ", err);
		process.exit(1);
	});

	bookReaderUrl = new URL(bookReaderUrl);

	if (bookReaderUrl.host == 'web-booktab.zanichelli.it') {
		console.log("BookTab book detected");
		await downloadBookTabBook(books[isbn].ereader_url, cookie, doOcr, outputDir);
	} else {
		console.log("Kitaboo book detected");
		await downloadKitabooBook(bookReaderUrl, doOcr, outputDir, sessionCookieHeader);
	}
}