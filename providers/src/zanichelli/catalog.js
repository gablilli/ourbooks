import fetch from "node-fetch";
import { USER_AGENT } from "./constants.js";

export async function getUser(session) {
	// we don't really care about the response, but apparently it's required to access the book list
	const res = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/user', {
		headers: session.catalogHeaders,
	});
	return res.json();
}

export async function listBooks(session) {
	let books = {};

	const addLicense = (license) => {
		if (!license?.volume?.ereader_url) return;
		books[license.volume.isbn] = {
			title: license.volume.opera?.title
				? `${license.volume.opera.title}${license.volume.title ? ' - ' + license.volume.title : ''}`
				: license.volume.title,
			ereader_url: license.volume.ereader_url,
			isbns: license.volume.isbns || [],
		};
	};

	const realRes = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/licenses/real', {
		headers: session.catalogHeaders,
	});

	if (!realRes.ok) {
		throw new Error(`licenses/real ha risposto con errore: ${realRes.status}`);
	}

	const realJson = await realRes.json().catch(() => null);
	(realJson?.realLicenses || []).forEach(addLicense);

	const tempRes = await fetch('https://api-catalogo.zanichelli.it/v3/dashboard/licenses/temp?types%5B%5D=delay', {
		headers: session.catalogHeaders,
	}).catch(() => null);
	if (tempRes && tempRes.ok) {
		const tempJson = await tempRes.json().catch(() => null);
		(tempJson?.tempLicenses || []).forEach(addLicense);
	}

	return books;
}

export async function resolveReaderUrl(startUrl, cookie) {
	let url = startUrl;
	for (let hop = 0; hop < 8; hop++) {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, cookie },
			redirect: 'manual',
		});
		const location = res.headers.get('location');
		if (!location) break;
		const next = new URL(location, url);
		if (next.host === 'web-booktab.zanichelli.it' || next.host === 'webreader.zanichelli.it') return next;
		url = next.toString();
	}
	throw new Error("Impossibile risolvere il reader del libro (nessun redirect verso booktab/webreader)");
}