import fetch from "node-fetch";
import path from "path";
import { USER_AGENT, WEBREADER_REFERER } from "./constants.js";
import { mergeCookieHeaders } from "./cookies.js";
import { asCollection, toNumber, normalizePageId } from "./utils.js";

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

export async function loadKitabooTextPages(usertoken, textBookId, sessionCookies = '', readerCookies = '', jwtToken = '') {
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

	for (const mode of modeCandidates) {
		// lol pages.json and page-list.json
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

export function drawInvisibleTextLayer(doc, textPage) {
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
			paragraphGap: 0,
			characterSpacing: 0,
			features: { liga: false },
		};

		doc.fontSize(fontSize);
		const measuredWidth = doc.widthOfString(run.text, options);
		const scaleX = measuredWidth > 0 ? width / measuredWidth : 1;

		doc.save();
		doc.translate(run.x * xScale, run.y * yScale);
		doc.scale(scaleX, 1);
		doc.text(run.text, 0, 0, options);
		doc.restore();
	}

	doc.restore();
}