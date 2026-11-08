import fetch from "node-fetch";
import { USER_AGENT, CATALOG_BASE } from "./constants.js";
import { getSetCookies, extractCookiePairs, mergeCookieHeaders } from "./cookies.js";

async function isMyzTokenValid(myzToken, idpToken) {
	if (!myzToken) return false;
	const res = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/licenses/real', {
		headers: {
			...CATALOG_BASE,
			'myz-token': myzToken,
			cookie: `token=${idpToken}; myz_token=${myzToken}`,
		},
	}).catch(() => null);
	if (!res || !res.ok) return false;
	const json = await res.json().catch(() => null);
	return Array.isArray(json?.realLicenses);
}

async function getMyzTokenFromPage(url, idpToken) {
	const res = await fetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Referer": "https://my.zanichelli.it/",
			cookie: `token=${idpToken}`,
		},
		redirect: 'manual',
	});
	const setCookie = getSetCookies(res).find((entry) => entry.startsWith('myz_token='));
	return extractCookiePairs(setCookie).find(([key]) => key === 'myz_token')?.[1] || null;
}

async function getMyzToken(idpToken) {
	const strategies = [
		["cookie da my.zanichelli.it/dashboard", () => getMyzTokenFromPage("https://my.zanichelli.it/dashboard", idpToken)],
		["cookie da my.zanichelli.it/?loginMode", () => getMyzTokenFromPage("https://my.zanichelli.it/?loginMode=myZanichelli", idpToken)],
	];

	for (const [name, strategy] of strategies) {
		try {
			const candidate = await strategy();
			if (await isMyzTokenValid(candidate, idpToken)) {
				console.log(`myz-token ottenuto (${name})`);
				return candidate;
			}
		} catch (err) {}
	}

	return null;
}

export async function loginIdp(username, password) {
	const loginResponse = await fetch("https://idp.zanichelli.it/v4/login/", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"Accept": "application/json",
			"Origin": "https://my.zanichelli.it",
			"Referer": "https://my.zanichelli.it/",
			"User-Agent": USER_AGENT,
		},
		body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
	}).catch((err) => {
		throw new Error(`Login fallito: ${err.message}`);
	});

	const loginJson = await loginResponse.json().catch(() => ({}));
	const token = loginJson.token;

	if (!token) {
		const error = new Error(`Login fallito: ${loginJson.message || loginResponse.status}`);
		error.status = 401;
		throw error;
	}

	return token;
}

export async function createSession(username, password) {
	const token = await loginIdp(username, password);
	const cookie = `token=${token}`;

	const myzToken = await getMyzToken(token);

	if (!myzToken) {
		const error = new Error("Impossibile ottenere il myz-token (il flusso di my.zanichelli.it potrebbe essere cambiato di nuovo)");
		error.status = 502;
		throw error;
	}

	return {
		token,
		cookie,
		myzToken,
		catalogHeaders: {
			...CATALOG_BASE,
			'myz-token': myzToken,
			cookie: `${cookie}; myz_token=${myzToken}`,
		},
		sessionCookieHeader: mergeCookieHeaders([cookie], [`myz_token=${myzToken}`]),
	};
}