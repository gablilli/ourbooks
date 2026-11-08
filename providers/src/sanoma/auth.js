import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { URL } from 'url';

const PLACE_BOOKS_DATA_URL = 'https://place.sanoma.it/prodotti_digitali/__data.json';
const PLACE_BOOKS_PAGE_URL = 'https://place.sanoma.it/prodotti_digitali';
const DISPLAY_BOOKS_URL = 'https://npmitaly-pro-apidistribucion.sanoma.it/mcs/msproducts/api/products/display-books';
const EBOOK_ORIGIN = 'https://ebook.sanoma.it';
const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
};

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
const PLACE_LOGIN_URL = 'https://place.sanoma.it/login';
const MAX_REDIRECTS = 20;

function isUniversalLoginUrl(url) {
    const parsed = new URL(url);
    return parsed.host === 'login.sanoma.it' && parsed.pathname.startsWith('/u/login');
}

// axios is configured with maxRedirects: 0, so redirects are followed by hand.
// Errors with a response (4xx/5xx) are returned instead of thrown so the caller can read the page.
async function sendRequest(client, config) {
    try {
        return await client.request(config);
    } catch (err) {
        if (err.response) return err.response;
        throw err;
    }
}

async function followRedirects(client, startUrl, referer) {
    let url = startUrl;
    let currentReferer = referer;

    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
        const res = await sendRequest(client, {
            method: 'get',
            url,
            headers: {
                'Referer': currentReferer,
                'Accept': HTML_ACCEPT
            }
        });

        if (res.status >= 300 && res.status < 400 && res.headers?.location) {
            currentReferer = url;
            url = new URL(res.headers.location, url).toString();
            continue;
        }

        return { res, url };
    }

    throw new Error('Too many redirects during Sanoma login');
}

function extractAuth0Error(html) {
    if (typeof html !== 'string') return null;

    const $ = cheerio.load(html);
    const message = $('.ulp-input-error-message, .ulp-error-info, #error-element-username, #error-element-password')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();

    return message || null;
}

function assertNoCaptcha(html, step) {
    const $ = cheerio.load(html);
    if ($('input[name="captcha"]').length > 0) {
        throw new Error(`Login failed: Sanoma requires a captcha at the ${step} step. Log in once from the browser and try again.`);
    }
}

function getFormState(html, pageUrl) {
    const $ = cheerio.load(html);
    const fromForm = $('form[data-form-primary="true"] input[name="state"]').first().val()
        || $('input[name="state"]').first().val();

    return fromForm || new URL(pageUrl).searchParams.get('state');
}

// Legacy entry point: the old /login page posted the email to a SvelteKit action,
// which answered with the Auth0 authorize URL.
async function getAuthorizeUrlFromLegacyAction(client, email) {
    const initParams = new URLSearchParams({
        ref: 'https://place.sanoma.it/',
        context: '',
        text: email
    });

    const initRes = await sendRequest(client, {
        method: 'post',
        url: 'https://place.sanoma.it/login?/status',
        data: initParams.toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Origin': 'https://place.sanoma.it',
            'Referer': PLACE_LOGIN_URL,
            'x-sveltekit-action': 'true'
        }
    });

    let data = initRes.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) {}
    }

    if (data && data.type === 'redirect' && data.location) {
        return new URL(data.location, 'https://login.sanoma.it').toString();
    }

    if (initRes.headers?.location) {
        return new URL(initRes.headers.location, 'https://login.sanoma.it').toString();
    }

    throw new Error(`Sanoma login flow has changed (POST /login?/status answered ${initRes.status}).`);
}

export async function loginSanoma(email, password) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    }));

    // reach auth0
    let { res: identifierRes, url: identifierUrl } = await followRedirects(
        client,
        PLACE_LOGIN_URL,
        'https://place.sanoma.it/'
    );

    if (!isUniversalLoginUrl(identifierUrl)) {
        const authUrl = await getAuthorizeUrlFromLegacyAction(client, email);
        ({ res: identifierRes, url: identifierUrl } = await followRedirects(client, authUrl, 'https://place.sanoma.it/'));
    }

    if (!isUniversalLoginUrl(identifierUrl) || identifierRes.status !== 200 || typeof identifierRes.data !== 'string') {
        throw new Error(`Login failed: unexpected login page (${identifierRes.status} ${identifierUrl}).`);
    }

    assertNoCaptcha(identifierRes.data, 'identifier');

    // 2. submit the email.
    const identifierState = getFormState(identifierRes.data, identifierUrl);
    if (!identifierState) throw new Error('Login failed: state parameter not found on the identifier page.');

    const identifierBody = new URLSearchParams({
        'state': identifierState,
        'username': email,
        'js-available': 'true',
        'webauthn-available': 'true',
        'is-brave': 'false',
        'webauthn-platform-available': 'true'
    });

    const identifierPost = await sendRequest(client, {
        method: 'post',
        url: identifierUrl,
        data: identifierBody.toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://login.sanoma.it',
            'Referer': identifierUrl,
            'Accept': HTML_ACCEPT
        }
    });

    if (!(identifierPost.status >= 300 && identifierPost.status < 400 && identifierPost.headers?.location)) {
        const reason = extractAuth0Error(identifierPost.data) || `HTTP ${identifierPost.status}`;
        throw new Error(`Login failed: ${reason}`);
    }

    // 3. Password page.
    const { res: passwordRes, url: passwordUrl } = await followRedirects(
        client,
        new URL(identifierPost.headers.location, identifierUrl).toString(),
        identifierUrl
    );

    if (passwordRes.status !== 200 || typeof passwordRes.data !== 'string' || !passwordUrl.includes('/u/login/password')) {
        throw new Error(`Login failed: unexpected password page (${passwordRes.status} ${passwordUrl}).`);
    }

    assertNoCaptcha(passwordRes.data, 'password');

    const passwordState = getFormState(passwordRes.data, passwordUrl);
    if (!passwordState) throw new Error('Login failed: state parameter not found on the password page.');

    const passwordBody = new URLSearchParams({
        'state': passwordState,
        'username': email,
        'password': password
    });

    const passwordPost = await sendRequest(client, {
        method: 'post',
        url: passwordUrl,
        data: passwordBody.toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://login.sanoma.it',
            'Referer': passwordUrl,
            'Accept': HTML_ACCEPT
        }
    });

    if (!(passwordPost.status >= 300 && passwordPost.status < 400 && passwordPost.headers?.location)) {
        const reason = extractAuth0Error(passwordPost.data) || `HTTP ${passwordPost.status} (wrong credentials?)`;
        throw new Error(`Login failed: ${reason}`);
    }

    // 4. /authorize/resume -> place.sanoma.it/?code=... -> /login/callback -> /
    const { res: finalRes, url: finalUrl } = await followRedirects(
        client,
        new URL(passwordPost.headers.location, passwordUrl).toString(),
        passwordUrl
    );

    if (new URL(finalUrl).host !== 'place.sanoma.it' || finalRes.status >= 400) {
        throw new Error(`Login failed: the login did not return to place.sanoma.it (${finalRes.status} ${finalUrl}).`);
    }

    return client;
}

export async function fetchBooks(client) {
  const response = await client.get(PLACE_BOOKS_DATA_URL, {
    headers: {
      ...DEFAULT_HEADERS,
      'Referer': PLACE_BOOKS_PAGE_URL,
      'Accept': 'application/json',
      'X-Sveltekit-Invalidated': '01'
    }
  });

  const lines = response.data.split('\n').filter(line => line.trim());
  const jsonObjects = lines.map(line => JSON.parse(line));
  const booksByGedi = new Map();

  function mergeBookProduct(operaId, product) {
    const existing = booksByGedi.get(product.gedi);

    if (!existing) {
      booksByGedi.set(product.gedi, { name: product.name, opera_id: operaId, products: [product] });
      return;
    }

    const existingProduct = existing.products[0];
    if ((product.name || '').length > (existingProduct.name || '').length) {
      existing.name = product.name;
      existingProduct.name = product.name;
    }

    if (!existingProduct.isbn && product.isbn) {
      existingProduct.isbn = product.isbn;
    }

    const resourceKey = (resource) => JSON.stringify([
      resource?.type || '',
      resource?.category_id || '',
      resource?.external_id || '',
      resource?.code || '',
      resource?.url || ''
    ]);
    const seenResources = new Set((existingProduct.resources || []).map(resourceKey));
    for (const resource of product.resources || []) {
      const key = resourceKey(resource);
      if (!seenResources.has(key)) {
        existingProduct.resources.push(resource);
        seenResources.add(key);
      }
    }
  }

  function extractBooksFromDataTable(dataTable) {
    if (!Array.isArray(dataTable) || dataTable.length === 0) return;

    const resolved = new Map();

    function decompressValue(val) {
      if (typeof val === 'number') {
        if (val < 0 || val >= dataTable.length || dataTable[val] === undefined) return val;
        if (resolved.has(val)) return resolved.get(val);
        const target = dataTable[val];
        if (Array.isArray(target)) {
          const newArr = [];
          resolved.set(val, newArr);
          for (let j = 0; j < target.length; j++) newArr.push(decompressValue(target[j]));
          return newArr;
        } else if (target && typeof target === 'object') {
          const newObj = {};
          resolved.set(val, newObj);
          for (const key in target) newObj[key] = decompressValue(target[key]);
          return newObj;
        } else {
          resolved.set(val, target);
          return target;
        }
      }
      return val;
    }

    for (let i = 0; i < dataTable.length; i++) {
      const item = dataTable[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (!('opera_id' in item) || !('display_name' in item)) continue;

      const fullyResolved = decompressValue(i);
      if (!fullyResolved || !fullyResolved.opera_id || fullyResolved.is_opera !== true) continue;
      const operaName = String(fullyResolved.display_name || '').trim();
      const includedProducts = Array.isArray(fullyResolved.included) ? fullyResolved.included : [];

      for (const includedProduct of includedProducts) {
        if (!includedProduct || typeof includedProduct !== 'object' || Array.isArray(includedProduct)) continue;

        const productName = String(includedProduct.display_name || includedProduct.title || includedProduct.name || '').trim();
        const productIsbn = includedProduct.isbn || includedProduct.paper_isbn || '';
        const resources = Array.isArray(includedProduct.resource) ? includedProduct.resource : [];

        for (const resource of resources) {
          if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;

          const gediCode = resource.external_id && /^\d{5,10}$/.test(String(resource.external_id))
            ? String(resource.external_id)
            : null;
          const resourceUrl = typeof resource.url === 'string' ? resource.url : '';
          const isLibromedia = resourceUrl.includes('/prodotti_digitali/libromedia/');

          if (!gediCode || !isLibromedia) continue;

          const resourceName = String(resource.display_name || '').trim();
          const finalName = buildSanomaBookName(operaName, productName, resourceName, gediCode);

          mergeBookProduct(fullyResolved.opera_id, {
            isbn: productIsbn || resource.paper_isbn || '',
            name: finalName,
            gedi: gediCode,
            resources: [{
              type: resource.category_name || '',
              category_id: resource.category_id || '',
              external_id: resource.external_id || '',
              code: resource.internal_code || '',
              url: resource.url || ''
            }]
          });
        }
      }
    }
  }

  for (const obj of jsonObjects) {
    if (Array.isArray(obj.data)) {
      extractBooksFromDataTable(obj.data);
    }

    if (Array.isArray(obj.nodes)) {
      for (const node of obj.nodes) {
        if (Array.isArray(node?.data)) {
          extractBooksFromDataTable(node.data);
        }
      }
    }

    if (obj.type === 'chunk' && Array.isArray(obj.data)) {
      extractBooksFromDataTable(obj.data);
    }
  }

  return Array.from(booksByGedi.values());
}

function normalizeBookLabel(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function buildSanomaBookName(operaName, productName, resourceName, gediCode) {
    const opera = String(operaName || '').trim();
    const product = String(productName || '').trim();
    const resource = String(resourceName || '').trim();

    if (!resource) {
        return product || opera || `Volume (${gediCode})`;
    }

    const normalizedOpera = normalizeBookLabel(opera);
    const normalizedProduct = normalizeBookLabel(product);
    const normalizedResource = normalizeBookLabel(resource);

    if (!product || normalizedResource === normalizedProduct) {
        return product || resource || opera || `Volume (${gediCode})`;
    }

    if (
        (normalizedOpera && normalizedResource.includes(normalizedOpera))
        || (normalizedProduct && normalizedResource.includes(normalizedProduct))
    ) {
        return resource;
    }

    return `${product} - ${resource}`;
}

function normalizePlaceBookUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `https://place.sanoma.it${url}`;
    return `https://place.sanoma.it/${url}`;
}

function getProductPlaceUrl(product) {
    const candidates = [
        product?.url,
        ...(Array.isArray(product?.resources) ? product.resources.map((resource) => resource?.url) : [])
    ];

    for (const candidate of candidates) {
        const normalized = normalizePlaceBookUrl(candidate);
        if (normalized && normalized.includes('/prodotti_digitali/')) {
            return normalized;
        }
    }

    return null;
}

function getAllProducts(books) {
    const products = [];
    for (const book of books) {
        for (const product of book.products || []) {
            products.push(product);
        }
    }
    return products;
}

export async function getBookCatalog(client) {
    const books = await fetchBooks(client);
    const products = getAllProducts(books);

    return products.map((product) => ({
        ...product,
        placeUrl: getProductPlaceUrl(product)
    }));
}

export async function getBookMetadata(client, gedi) {
    const products = await getBookCatalog(client);
    const product = products.find((entry) => String(entry.gedi) === String(gedi));

    if (!product) {
        throw new Error(`Book with GEDI ${gedi} was not found in the Sanoma library.`);
    }

    return product;
}

export async function fetchKToken(client, placeUrl) {
    const normalizedPlaceUrl = normalizePlaceBookUrl(placeUrl);
    if (!normalizedPlaceUrl) {
        throw new Error('Sanoma book URL is missing or invalid.');
    }

    let response;
    try {
        response = await client.get(normalizedPlaceUrl, {
            headers: {
                ...DEFAULT_HEADERS,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': PLACE_BOOKS_PAGE_URL
            }
        });
    } catch (err) {
        if (err.response) {
            response = err.response;
        } else {
            throw err;
        }
    }

    const location = response.headers?.location;
    if (!location) {
        throw new Error(`open-book redirect was not found for ${normalizedPlaceUrl}.`);
    }

    const redirectUrl = new URL(location, normalizedPlaceUrl);
    const ktoken = redirectUrl.searchParams.get('ktoken');

    if (!ktoken) {
        throw new Error(`ktoken was not found in the redirect for ${normalizedPlaceUrl}.`);
    }

    return ktoken;
}

export async function fetchBookAccess(client, gedi, placeUrl) {
    const product = placeUrl
        ? { gedi, placeUrl: normalizePlaceBookUrl(placeUrl) }
        : await getBookMetadata(client, gedi);

    if (!product.placeUrl) {
        throw new Error(`place.sanoma.it URL was not found for book GEDI ${gedi}.`);
    }

    const xAuthToken = await fetchKToken(client, product.placeUrl);
    const response = await client.get(DISPLAY_BOOKS_URL, {
        headers: {
            ...DEFAULT_HEADERS,
            'Accept': 'application/json, text/plain, */*',
            'Referer': `${EBOOK_ORIGIN}/`,
            'Origin': EBOOK_ORIGIN,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'Sec-GPC': '1',
            'TE': 'trailers',
            'X-Auth-Token': xAuthToken
        }
    });

    const payload = response.data;
    const firstEntry = Array.isArray(payload?.data) ? payload.data[0] : null;
    const bookData = firstEntry?.book || payload?.book || payload?.data?.book || null;
    const resolvedGedi = firstEntry?.gedi || payload?.gedi || gedi;
    const cookies = bookData?.cookies || {};

    const cookieKeys = ['CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id'];
    const missingKeys = cookieKeys.filter((key) => !cookies[key]);
    if (!bookData?.url || missingKeys.length > 0) {
        throw new Error(`display-books response is incomplete for GEDI ${gedi}.`);
    }

    return {
        gedi: String(resolvedGedi),
        placeUrl: product.placeUrl,
        xAuthToken,
        baseUrl: String(bookData.url).replace(/\/$/, ''),
        cookies,
        cookieHeader: cookieKeys.map((key) => `${key}=${cookies[key]}`).join('; ')
    };
}

export async function fetchCloudfrontCookies(client, gedi, placeUrl) {
    const access = await fetchBookAccess(client, gedi, placeUrl);
    return access.cookieHeader;
}