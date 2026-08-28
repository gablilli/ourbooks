import fetch from 'node-fetch';

/**
 * Performs login for bsmart/digibook24 to obtain the session cookie
 * @param {string} baseSite - The base site URL
 * @param {string} username - The username
 * @param {string} password - The password
 * @returns {Promise<string>} The session cookie
 */
export async function performBsmartLogin(baseSite, username, password) {
    const initRes = await fetch(`https://${baseSite}/users/sign_in`);
    const initHtml = await initRes.text();
    const cookieHeaders = (initRes.headers.raw ? initRes.headers.raw()['set-cookie'] : initRes.headers.getSetCookie()) || [];
    let initialCookie = '';
    for (const c of cookieHeaders) {
        if (c.includes('_bsw_session_v1_production')) {
            initialCookie = c.split(';')[0].split('=')[1];
        }
    }

    let csrfToken = '';
    const match = initHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (match) {
        csrfToken = match[1];
    }

    if (!csrfToken || !initialCookie) {
        throw new Error("Could not extract csrf-token or initial cookie. The site structure might have changed.");
    }

    const params = new URLSearchParams();
    params.append('authenticity_token', csrfToken);
    params.append('user[email]', username);
    params.append('user[password]', password);
    params.append('commit', 'Accedi');
    params.append('user[remember_me]', '0');

    const loginRes = await fetch(`https://${baseSite}/users/sign_in`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': `_bsw_session_v1_production=${initialCookie}`,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0'
        },
        body: params.toString(),
        redirect: 'manual'
    });

    const loginCookies = (loginRes.headers.raw ? loginRes.headers.raw()['set-cookie'] : loginRes.headers.getSetCookie()) || [];
    let finalCookie = initialCookie;
    for (const c of loginCookies) {
        if (c.includes('_bsw_session_v1_production')) {
            finalCookie = c.split(';')[0].split('=')[1];
        }
    }

    if (loginRes.status !== 302 && loginRes.status !== 303) {
        throw new Error("Errore login: controlla le credenziali o se il sito ha cambiato struttura");
    }

    return finalCookie;
}

/**
 * Gets user information from the API
 * @param {string} baseSite - The base site URL
 * @param {Object} headers - Complete headers object including auth_token
 * @returns {Promise<Object>} User information
 */
export async function getUserInfo(baseSite, headers) {
    const response = await fetch(`https://${baseSite}/api/v5/user`, { headers });

    if (response.status != 200) {
        throw new Error('Bad cookie');
    }

    return await response.json();
}

/**
 * Gets the list of books from the API
 * @param {string} baseSite - The base site URL
 * @param {Object} headers - Complete headers object including auth_token
 * @returns {Promise<Array>} Array of books
 */
export async function getBooks(baseSite, headers) {
    const books = await fetch(`https://${baseSite}/api/v6/books?page_thumb_size=medium&per_page=25000`, { headers }).then(res => res.json());

    const preactivations = await fetch(`https://${baseSite}/api/v5/books/preactivations`, { headers }).then(res => res.json());

    preactivations.forEach(preactivation => {
        if (preactivation.no_bsmart === false) {
            books.push(...preactivation.books);
        }
    });

    return books;
}

/**
 * Gets detailed information about a specific book
 * @param {string} baseSite - The base site URL
 * @param {string} bookId - The book ID
 * @param {Object} headers - Complete headers object including auth_token
 * @returns {Promise<Object>} Book information
 */
export async function getBookInfo(baseSite, bookId, headers) {
    const response = await fetch(`https://${baseSite}/api/v6/books/by_book_id/${bookId}`, { headers });

    if (response.status != 200) {
        throw new Error('Invalid book id');
    }

    return await response.json();
}

/**
 * Gets all resources for a book
 * @param {string} baseSite - The base site URL
 * @param {Object} book - The book object
 * @param {Object} headers - Complete headers object including auth_token
 * @returns {Promise<Array>} Array of resources
 */
export async function getBookResources(baseSite, book, headers) {
    let info = [];
    let page = 1;

    while (true) {
        const tempInfo = await fetch(`https://${baseSite}/api/v5/books/${book.id}/${book.current_edition.revision}/resources?per_page=500&page=${page}`, { headers }).then(res => res.json());
        info = info.concat(tempInfo);
        if (tempInfo.length < 500) break;
        page++;
    }

    return info;
}

/**
 * Gets links attached to a specific resource (used for annotations)
 * @param {string} baseSite - The base site URL
 * @param {number|string} resourceId - The page resource ID
 * @param {Object} headers - Complete headers object including auth_token
 * @returns {Promise<Array>} Array of links
 */
export async function getResourceLinks(baseSite, resourceId, headers) {
    let links = [];
    let page = 1;

    while (true) {
        const pageLinks = await fetch(
            `https://${baseSite}/api/v5/resources/${resourceId}/links?per_page=50&page=${page}`,
            { headers }
        ).then(res => res.json());

        if (!Array.isArray(pageLinks) || pageLinks.length === 0) {
            break;
        }

        links = links.concat(pageLinks);

        if (pageLinks.length < 50) {
            break;
        }

        page++;
    }

    return links;
}