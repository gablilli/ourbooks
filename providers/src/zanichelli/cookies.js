export function getSetCookies(response) {
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

export function extractCookiePairs(value) {
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

export function mergeCookieHeaders(...cookieGroups) {
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