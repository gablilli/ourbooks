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
    
    const redirectUri = 'https://place.sanoma.it/';
    let authUrl = null;
    let clientId = null;
    
    try {
        await client.get('https://place.sanoma.it/login', {
            headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        });

        const initParams = new URLSearchParams({
            ref: 'https://place.sanoma.it/',
            context: '',
            text: email
        });

        const initRes = await client.post('https://place.sanoma.it/login?/status', initParams.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Origin': 'https://place.sanoma.it',
                'Referer': 'https://place.sanoma.it/login',
                'x-sveltekit-action': 'true'
            }
        });
        
        let data = initRes.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) {}
        }
        
        if (data && data.type === 'redirect' && data.location) {
            authUrl = data.location;
        }
    } catch (err) {
        if (err.response?.data?.type === 'redirect' && err.response?.data?.location) {
            authUrl = err.response.data.location;
        } else if (err.response?.headers?.location) {
            authUrl = err.response.headers.location;
        } else {
            throw err;
        }
    }
    
    if (!authUrl) throw new Error('Failed to get Auth0 redirect URL from /login?/status');
    if (!authUrl.startsWith('http')) authUrl = 'https://login.sanoma.it' + (authUrl.startsWith('/') ? '' : '/') + authUrl;
    
    const parsedInitUrl = new URL(authUrl);
    clientId = parsedInitUrl.searchParams.get('client_id');
    if (!clientId) throw new Error('Client ID missing from SvelteKit authorization URL');

    let authPageRes = await client.get(authUrl, {
        headers: {
            'Referer': 'https://place.sanoma.it/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }
    });
    
    while (authPageRes.status >= 300 && authPageRes.status < 400 && authPageRes.headers.location) {
        let nextUrl = authPageRes.headers.location;
        if (!nextUrl.startsWith('http')) nextUrl = 'https://login.sanoma.it' + nextUrl;
        authUrl = nextUrl;
        authPageRes = await client.get(authUrl, {
            headers: {
                'Referer': 'https://place.sanoma.it/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });
    }
    
    const $ = cheerio.load(authPageRes.data);
    const cookies = await jar.getCookies('https://login.sanoma.it');
    const csrfCookie = cookies.find(c => c.key === '_csrf');
    const csrfToken = $('input[name="_csrf"]').val() || (csrfCookie ? csrfCookie.value : '');
    
    const parsedUrl = new URL(authUrl);
    const state = parsedUrl.searchParams.get('state');
    if (!state) throw new Error('State parameter not found in Auth0 URL');

    const loginPayload = {
        client_id: clientId,
        redirect_uri: redirectUri,
        tenant: "sanoma-italy",
        response_type: "code",
        scope: "openid profile email",
        state,
        connection: "Sanoma-Italy-Database",
        username: email,
        password,
        popup_options: {},
        sso: true,
        protocol: "oauth2",
        _csrf: csrfToken,
        _intstate: "deprecated"
    };

    let loginRes;
    try {
        loginRes = await client.post('https://login.sanoma.it/usernamepassword/login', loginPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://login.sanoma.it',
                'Referer': authUrl,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
    } catch (err) {
        throw new Error(`Login failed: ${err.response?.status ?? 'Unknown'} ${err.response?.statusText ?? ''}`);
    }

    const $login = cheerio.load(loginRes.data);
    const wa      = $login('input[name="wa"]').val();
    const wresult = $login('input[name="wresult"]').val();
    const wctx    = $login('input[name="wctx"]').val();

    if (!wa || !wresult || !wctx) {
        throw new Error('Login failed: callback form not found (wrong credentials?)');
    }

    let finalCodeUrl = null;
    try {
        const callbackRes = await client.post(
            'https://login.sanoma.it/login/callback',
            `wa=${encodeURIComponent(wa)}&wresult=${encodeURIComponent(wresult)}&wctx=${encodeURIComponent(wctx)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://login.sanoma.it',
                    'Referer': 'https://login.sanoma.it/',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            }
        );
        if (callbackRes.status >= 300 && callbackRes.status < 400) {
            finalCodeUrl = callbackRes.headers.location;
        }
    } catch(err) {
        if (err.response?.status >= 300 && err.response?.status < 400) {
            finalCodeUrl = err.response.headers.location;
        } else {
            throw err;
        }
    }

    if (!finalCodeUrl) throw new Error('Final redirect URL not found after callback');

    if (!finalCodeUrl.startsWith('http')) {
        finalCodeUrl = finalCodeUrl.startsWith('/authorize')
            ? 'https://login.sanoma.it' + finalCodeUrl
            : 'https://place.sanoma.it' + (finalCodeUrl.startsWith('/') ? '' : '/') + finalCodeUrl;
    }
    
    let currentUrl = finalCodeUrl;
    for (let i = 0; i < 15; i++) {
        try {
            const res = await client.get(currentUrl, {
                headers: {
                    'Referer': i === 0 ? 'https://login.sanoma.it/' : currentUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            if (res.status >= 300 && res.status < 400 && res.headers.location) {
                let next = res.headers.location;
                if (!next.startsWith('http')) next = next.startsWith('/authorize') ? 'https://login.sanoma.it' + next : 'https://place.sanoma.it' + next;
                currentUrl = next;
            } else {
                break;
            }
        } catch (err) {
            if (err.response?.status >= 300 && err.response?.status < 400) {
                let next = err.response.headers.location;
                if (!next.startsWith('http')) next = next.startsWith('/authorize') ? 'https://login.sanoma.it' + next : 'https://place.sanoma.it' + next;
                currentUrl = next;
            } else {
                break;
            }
        }
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
