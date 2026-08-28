import PromptSync from 'prompt-sync';
import fetch from 'node-fetch';
import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'fs';
import sanitize from 'sanitize-filename';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import md5 from 'md5';
import { spawn } from 'child_process';
import path from 'path';
import pLimit from 'p-limit';

import { fetchEncryptionKey, decryptFile } from './src/bsmart/crypto.js';
import { performBsmartLogin, getUserInfo, getBooks, getBookInfo, getBookResources, getResourceLinks } from './src/bsmart/api.js';

const prompt = PromptSync({ sigint: true });

function parseAnnotationValue(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(element => {
            if (typeof element !== 'string') {
                return null;
            }

            try {
                return JSON.parse(element);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function extractAnnotationsFromLinks(links) {
    const annotations = [];

    for (const link of links) {
        const resource = link?.resource;
        const parsed = parseAnnotationValue(resource?.content?.value);

        if (parsed.length === 0) {
            continue;
        }

        annotations.push({
            linkId: link?.id ?? null,
            resourceId: resource?.id ?? link?.resource_id ?? null,
            resourceTypeId: resource?.resource_type_id ?? link?.resource_type_id ?? null,
            targetId: link?.target_id ?? null,
            targetTypeId: link?.target_type_id ?? null,
            items: parsed
        });
    }

    return annotations;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseHexColor(color) {
    if (typeof color !== 'string') {
        return rgb(0, 0, 0);
    }

    const normalized = color.trim().replace('#', '');

    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return rgb(0, 0, 0);
    }

    const red = parseInt(normalized.slice(0, 2), 16) / 255;
    const green = parseInt(normalized.slice(2, 4), 16) / 255;
    const blue = parseInt(normalized.slice(4, 6), 16) / 255;
    return rgb(red, green, blue);
}

function toPdfRect(pageHeight, rect) {
    if (!Array.isArray(rect) || rect.length < 4) {
        return null;
    }

    const x = Number(rect[0]);
    const y = Number(rect[1]);
    const width = Number(rect[2]);
    const height = Number(rect[3]);

    if (![x, y, width, height].every(Number.isFinite)) {
        return null;
    }

    return {
        x,
        y: pageHeight - y - height,
        width,
        height
    };
}

function drawInkAnnotationOnPage(pdfPage, annotationItem) {
    const pointsByStroke = annotationItem?.lines?.points;

    if (!Array.isArray(pointsByStroke)) {
        return;
    }

    const pageHeight = pdfPage.getHeight();
    const strokeColor = parseHexColor(annotationItem?.strokeColor);
    const thickness = Math.max(1, Number(annotationItem?.lineWidth) || 1);
    const opacity = clamp(Number(annotationItem?.opacity) || 1, 0, 1);

    for (const stroke of pointsByStroke) {
        if (!Array.isArray(stroke) || stroke.length === 0) {
            continue;
        }

        if (stroke.length === 1) {
            const point = stroke[0];
            if (Array.isArray(point) && point.length >= 2) {
                const x = Number(point[0]);
                const y = Number(point[1]);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    pdfPage.drawCircle({
                        x,
                        y: pageHeight - y,
                        size: Math.max(0.5, thickness / 2),
                        color: strokeColor,
                        opacity
                    });
                }
            }
            continue;
        }

        for (let i = 0; i < stroke.length - 1; i++) {
            const from = stroke[i];
            const to = stroke[i + 1];

            if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) {
                continue;
            }

            const x1 = Number(from[0]);
            const y1 = Number(from[1]);
            const x2 = Number(to[0]);
            const y2 = Number(to[1]);

            if (![x1, y1, x2, y2].every(Number.isFinite)) {
                continue;
            }

            pdfPage.drawLine({
                start: { x: x1, y: pageHeight - y1 },
                end: { x: x2, y: pageHeight - y2 },
                thickness,
                color: strokeColor,
                opacity
            });
        }
    }
}

function drawHighlightAnnotationOnPage(pdfPage, annotationItem) {
    const pageHeight = pdfPage.getHeight();
    const color = parseHexColor(annotationItem?.color || '#FAFC00');
    const opacity = clamp(Number(annotationItem?.opacity) || 0.6, 0, 1);
    const rects = Array.isArray(annotationItem?.rects) && annotationItem.rects.length > 0
        ? annotationItem.rects
        : [annotationItem?.bbox];

    for (const rect of rects) {
        const normalized = toPdfRect(pageHeight, rect);
        if (!normalized) {
            continue;
        }

        pdfPage.drawRectangle({
            x: normalized.x,
            y: normalized.y,
            width: normalized.width,
            height: normalized.height,
            color,
            opacity
        });
    }
}

function drawLinkAnnotationOnPage(pdfPage, annotationItem) {
    const pageHeight = pdfPage.getHeight();
    const rect = toPdfRect(pageHeight, annotationItem?.bbox);

    if (!rect) {
        return;
    }

    const borderWidth = Math.max(0, Number(annotationItem?.borderWidth) || 0);
    if (borderWidth === 0) {
        return;
    }

    const borderColor = parseHexColor(annotationItem?.color || '#1A73E8');
    const opacity = clamp(Number(annotationItem?.opacity) || 1, 0, 1);

    pdfPage.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        borderColor,
        borderWidth,
        borderOpacity: opacity
    });
}

function drawFallbackRectAnnotationOnPage(pdfPage, annotationItem) {
    const pageHeight = pdfPage.getHeight();
    const rects = Array.isArray(annotationItem?.rects) && annotationItem.rects.length > 0
        ? annotationItem.rects
        : [annotationItem?.bbox];

    const borderColor = parseHexColor(annotationItem?.strokeColor || annotationItem?.color || '#000000');
    const fillColor = annotationItem?.fillColor ? parseHexColor(annotationItem.fillColor) : null;
    const opacity = clamp(Number(annotationItem?.opacity) || 1, 0, 1);
    const borderWidth = Math.max(0.5, Number(annotationItem?.lineWidth) || Number(annotationItem?.borderWidth) || 1);

    for (const rect of rects) {
        const normalized = toPdfRect(pageHeight, rect);
        if (!normalized) {
            continue;
        }

        pdfPage.drawRectangle({
            x: normalized.x,
            y: normalized.y,
            width: normalized.width,
            height: normalized.height,
            ...(fillColor ? { color: fillColor, opacity } : {}),
            borderColor,
            borderWidth,
            borderOpacity: opacity
        });
    }
}

function drawAnnotationsOnPage(pdfPage, annotations) {
    const stats = {};

    for (const annotation of annotations) {
        for (const item of annotation.items || []) {
            const type = item?.type || 'unknown';

            if (type === 'pspdfkit/ink') {
                drawInkAnnotationOnPage(pdfPage, item);
                stats[type] = (stats[type] || 0) + 1;
                continue;
            }

            if (type === 'pspdfkit/markup/highlight') {
                drawHighlightAnnotationOnPage(pdfPage, item);
                stats[type] = (stats[type] || 0) + 1;
                continue;
            }

            if (type === 'pspdfkit/link') {
                drawLinkAnnotationOnPage(pdfPage, item);
                stats[type] = (stats[type] || 0) + 1;
                continue;
            }

            if (item?.bbox || (Array.isArray(item?.rects) && item.rects.length > 0)) {
                drawFallbackRectAnnotationOnPage(pdfPage, item);
                stats[type] = (stats[type] || 0) + 1;
            }
        }
    }

    return stats;
}

export async function run(options = {}) {
    const argv = yargs(hideBin(process.argv))
        .option('site', {
            describe: 'The site to download from, currently either bsmart or digibook24',
            type: 'string',
            default: null
        })
        .option('siteUrl', {
            describe: 'This overwrites the base url for the site, useful in case a new platform is added',
            type: 'string',
            default: null
        })
        .option('username', {
            alias: 'u',
            describe: 'bSmart username',
            type: 'string',
            default: null
        })
        .option('password', {
            alias: 'w',
            describe: 'bSmart password',
            type: 'string',
            default: null
        })
        .option('cookie', {
            describe: 'Input "_bsw_session_v1_production" cookie',
            type: 'string',
            default: null
        })
        .option('bookId', {
            describe: 'Book id',
            type: 'string',
            default: null
        })
        .option('downloadOnly', {
            describe: 'Downloads the pages as individual pdfs and will provide a command that can be used to merge them with pdftk',
            type: 'boolean',
            default: false
        })
        .option('pdftk', {
            describe: 'Downloads the pages as individual pdfs and merges them with pdftk',
            type: 'boolean',
            default: false
        })
        .option('pdftkPath', {
            describe: 'Path to pdftk executable',
            type: 'string',
            default: 'pdftk'
        })
        .option('checkMd5', {
            describe: 'Checks the md5 hash of the downloaded pages',
            type: 'boolean',
            default: false
        })
        .option('output', {
            describe: 'Output filename',
            type: 'string',
            default: null
        })
        .option('resources', {
            describe: 'Download resources of the book instead of the book itself',
            type: 'boolean',
            default: false
        })
        .option('concurrency', {
            describe: 'Number of parallel downloads',
            type: 'number',
            default: 4
        })
        .option('annotations', {
            describe: 'Draw page annotations on merged PDF',
            type: 'boolean',
            default: false
        })
        .help()
        .argv;

    const runtime = { ...argv, ...options };

    if (runtime.downloadOnly && runtime.pdftk) {
        console.log("Can't use --download-only and --pdftk at the same time");
        return;
    }

    if (runtime.annotations && (runtime.downloadOnly || runtime.pdftk)) {
        console.log('Annotations drawing requires merged PDF mode (without --downloadOnly/--pdftk)');
    }

    if ((runtime.downloadOnly || runtime.pdftk) && !fs.existsSync('temp')) {
        fs.mkdirSync('temp');
    }

    if ((runtime.downloadOnly || runtime.pdftk) && fs.readdirSync('temp').length > 0) {
        console.log('Files already in temp folder, please manually delete them if you want to download a new book');
        return;
    }

    let baseSite = runtime.siteUrl;

    if (!baseSite) {
        let platform = runtime.site;
        while (!platform) {
            platform = prompt('Input site (bsmart or digibook24):');
            if (platform !== 'bsmart' && platform !== 'digibook24') {
                platform = null;
                console.log('Invalid site');
            }
        }

        baseSite = platform === 'bsmart' ? 'www.bsmart.it' : 'web.digibook24.com';
    }

    let cookie = runtime.cookie;
    let username = runtime.username;
    let password = runtime.password;
    if (!cookie) {
        while (!username) {
            username = prompt('Input username (email): ');
        }
        while (!password) {
            password = prompt('Input password: ', { echo: '*' });
        }

        console.log('Logging in...');
        try {
            cookie = await performBsmartLogin(baseSite, username, password);
        } catch (error) {
            console.log('Error logging in:', error.message);
            return;
        }
    }

    let user;
    try {
        const cookieHeaders = { cookie: `_bsw_session_v1_production=${cookie}` };
        user = await getUserInfo(baseSite, cookieHeaders);
    } catch (error) {
        console.log('Error fetching user info:', error);
        return;
    }

    const headers = { auth_token: user.auth_token };

    let books;
    try {
        books = await getBooks(baseSite, headers);
    } catch (error) {
        console.log('Error fetching books:', error);
        return;
    }

    if (books.length === 0) {
        console.log('No books in your library!');
    } else {
        console.log('Book list:');
        console.table(books.map(book => ({ id: book.id, title: book.title })));
    }

    let bookId = runtime.bookId;
    while (!bookId) {
        bookId = prompt(`Please input book id${books.length === 0 ? ' manually' : ''}:`);
    }

    console.log('Fetching book info');

    let book;
    try {
        book = await getBookInfo(baseSite, bookId, headers);
    } catch (error) {
        console.log('Error fetching book info:', error.message);
        return;
    }

    let info;
    try {
        info = await getBookResources(baseSite, book, headers);
    } catch (error) {
        console.log('Error fetching book resources:', error);
        return;
    }

    const outputPdf = await PDFDocument.create();
    const filenames = [];
    const outputname = runtime.output || path.join(process.env.OURBOOKS_OUTPUT_DIR || '.', sanitize(`${book.id} - ${book.title}`));

    let assets = info
        .flatMap(resource =>
            (resource.assets || []).map(asset => ({
                ...asset,
                pageResourceId: resource.id
            }))
        );

    console.log('Fetching encryption key');

    let encryptionKey;
    try {
        encryptionKey = await fetchEncryptionKey();
    } catch (error) {
        console.log('Error fetching encryption key:', error);
        return;
    }

    if (runtime.resources) {
        assets = assets.filter(element => element.use === 'launch_file');
        if (!fs.existsSync(outputname)) {
            fs.mkdirSync(outputname);
        }
        console.log('Downloading resources');
    } else {
        assets = assets.filter(element => element.use === 'page_pdf');
        console.log('Downloading pages');
    }

    const limit = pLimit(runtime.concurrency);
    let pagesWithAnnotations = 0;
    let totalAnnotationItems = 0;
    const renderedByType = {};

    const downloadTasks = assets.map((asset, index) => {
        const task = limit(async () => {
            try {
                const response = await fetch(asset.url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText} for URL: ${asset.url}`);
                }
                let data = await response.arrayBuffer();
                data = Buffer.from(data); // ensure it's a buffer
                if (asset.encrypted !== false) {
                    data = await decryptFile(data, encryptionKey);
                }
                if (runtime.checkMd5 && md5(data) !== asset.url) {
                    console.log(`\nMismatching md5 hash for asset ${index}: ${asset.url}`);
                }
                return data;
            } catch (error) {
                console.log(`\nError downloading asset ${index}:`, error instanceof Error ? error.message : error);
                throw error;
            }
        });
        task.catch(() => {}); // prevent unhandled promise rejections
        return task;
    });

    for (let index = 0; index < assets.length; index++) {
        const asset = assets[index];
        let data;

        try {
            data = await downloadTasks[index];
        } catch {
            return;
        }

        process.stdout.write(`\rProgress ${((index + 1) / assets.length * 100).toFixed(2)}% (${index + 1}/${assets.length})`);

        if (runtime.resources) {
            const filename = path.basename(asset.filename);
            await fs.promises.writeFile(`${outputname}/${filename}`, data);
            continue;
        }

        if (runtime.downloadOnly || runtime.pdftk) {
            const filename = path.basename(asset.filename, '.pdf');
            const filePath = `temp/${filename}.pdf`;
            await fs.promises.writeFile(filePath, data);
            filenames.push(filePath);
            continue;
        }

        const page = await PDFDocument.load(data);
        const [firstDonorPage] = await outputPdf.copyPages(page, [0]);

        if (runtime.annotations && asset?.pageResourceId) {
            try {
            const links = await getResourceLinks(baseSite, asset.pageResourceId, headers);
                const annotations = extractAnnotationsFromLinks(links);

                if (annotations.length > 0) {
                    const pageStats = drawAnnotationsOnPage(firstDonorPage, annotations);
                    pagesWithAnnotations++;
                    totalAnnotationItems += annotations.reduce((sum, group) => sum + (group.items?.length || 0), 0);
                    for (const [type, count] of Object.entries(pageStats)) {
                        renderedByType[type] = (renderedByType[type] || 0) + count;
                    }
                }
            } catch (error) {
                console.log(`\nError fetching annotations for page ${index + 1}: ${error.message}`);
            }
        }

        outputPdf.addPage(firstDonorPage);
    }

    console.log();

    if (!runtime.resources && !runtime.downloadOnly && !runtime.pdftk) {
        await fs.promises.writeFile(`${outputname}.pdf`, await outputPdf.save());

        if (runtime.annotations) {
            console.log(`Applied ${totalAnnotationItems} annotation item(s) on ${pagesWithAnnotations} page(s)`);
            console.log(`Rendered by type: ${JSON.stringify(renderedByType)}`);
        }

        console.log('Done');
        console.log(`OURBOOKS_OUTPUT:${outputname}.pdf`);
        return;
    }

    if (!runtime.resources) {
        const pdftkCommand = `${runtime.pdftkPath} ${filenames.join(' ')} cat output "${outputname}.pdf"`;
        console.log('Run this command to merge the pages with pdftk:');
        console.log(pdftkCommand);

        if (runtime.pdftk) {
            console.log('Merging pages with pdftk');
            await new Promise(resolve => {
                const pdftk = spawn(runtime.pdftkPath, [...filenames, 'cat', 'output', `${outputname}.pdf`]);
                pdftk.stdout.on('data', data => {
                    console.log(`stdout: ${data}`);
                });
                pdftk.stderr.on('data', data => {
                    console.log(`stderr: ${data}`);
                });
                pdftk.on('close', code => {
                    console.log(`child process exited with code ${code}`);
                    resolve();
                });
            });
        }
    }

    console.log('Done');
}
