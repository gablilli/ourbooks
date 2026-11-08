import fetch from "node-fetch";
import { KITABOO_FETCH_RETRIES } from "./constants.js";

export function asCollection(value) {
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

export function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePageId(value) {
	const parsed = parseInt(String(value ?? '').trim(), 10);
	return Number.isFinite(parsed) ? String(parsed) : String(value ?? '').trim();
}

export function parseDimension(rawValue) {
	if (rawValue == null) return null;
	const match = String(rawValue).match(/-?\d+(?:\.\d+)?/);
	return match ? Number(match[0]) : null;
}

export function parseSvgPageSize(svg) {
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

export async function fetchWithRetry(url, headers, timeoutMs = 10000, retries = KITABOO_FETCH_RETRIES) {
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