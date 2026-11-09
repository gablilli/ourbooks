import fetch from 'node-fetch';
import { decryptLm60 } from './crypto.js';

const DEBUG = process.env.DEBUG === 'true';

export function extractSvgImages(svg) {
  const images = [];

  for (const match of svg.matchAll(/<(?:image)\b[^>]*(?:href|xlink:href)=["']([^"']+)["'][^>]*>/gi)) {
    const src = match[1];

    if (!src.startsWith('data:')) {
      images.push(src);
    }
  }

  return [...new Set(images)];
}


export function replaceSvgImages(svg, replacements) {
  let result = svg;

  for (const [source, dataUri] of replacements) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    result = result.replace(
      new RegExp(`((?:href|xlink:href)=["'])${escaped}(["'])`, 'g'),
      `$1${dataUri}$2`
    );
  }

  return result;
}


export function toDataUri(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}


export function guessContentType(url) {
  const cleanUrl = url.split('?')[0].toLowerCase();

  if (cleanUrl.endsWith('.png')) return 'image/png';
  if (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanUrl.endsWith('.gif')) return 'image/gif';
  if (cleanUrl.endsWith('.webp')) return 'image/webp';

  return 'application/octet-stream';
}


export function resolveAssetUrl(url, pageBaseUrl) {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  return new URL(url, pageBaseUrl).toString();
}


export async function fetchPageData(baseUrl, pageNumber, headers) {

  const url = `${baseUrl}/pages/${pageNumber}.data`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber} .data: HTTP ${response.status}`);
  }

  const raw = await response.text();

  const decoded = decryptLm60(raw);

  return decoded;
}


export async function fetchPageSvg(baseUrl, pageNumber, headers) {
  const url = `${baseUrl}/pages/${pageNumber}/${pageNumber}.svg`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Page ${pageNumber} SVG: HTTP ${response.status}`);
  }

  return response.text();
}


export function expandSvgUseElements(svg) {
  const defsMatch = svg.match(/<defs\b[^>]*>([\s\S]*?)<\/defs>/i);

  if (!defsMatch) {
    return svg;
  }

  const defs = defsMatch[1];
  const pathMap = new Map();

  const pathRegex = /<path\b([^>]*?)\bid="([^"]+)"([^>]*?)\/>/gi;

  let match;

  while ((match = pathRegex.exec(defs)) !== null) {
    const beforeId = match[1];
    const id = match[2];
    const afterId = match[3];

    pathMap.set(
      id,
      `<path${beforeId}${afterId}/>`
    );
  }

  if (!pathMap.size) {
    return svg;
  }

  let expanded = 0;

  const result = svg.replace(
    /<use\b([^>]*?)\/>/gi,
    (full, attributes) => {
      const hrefMatch = attributes.match(
        /(?:xlink:href|href)="([^"]+)"/i
      );

      if (!hrefMatch) {
        return full;
      }

      const href = hrefMatch[1];

      if (!href.startsWith('#')) {
        return full;
      }

      const path = pathMap.get(href.slice(1));

      if (!path) {
        return full;
      }

      const transformMatch = attributes.match(
        /\btransform="([^"]*)"/i
      );

      if (!transformMatch) {
        expanded++;
        return `<g>${path}</g>`;
      }

      expanded++;

      return `<g transform="${transformMatch[1]}">${path}</g>`;
    }
  );

  if (expanded === 0) {
    return svg;
  }

  return result;
}


export async function prepareSvg(svg, pageBaseUrl, headers) {
  svg = expandSvgUseElements(svg);

  const imageUrls = extractSvgImages(svg);

  if (!imageUrls.length) {
    return svg;
  }

  const replacements = await Promise.all(
    imageUrls.map(async imageUrl => {
      const absoluteUrl = resolveAssetUrl(
        imageUrl,
        pageBaseUrl
      );

      try {
        const response = await fetch(
          absoluteUrl,
          {
            headers
          }
        );

        if (!response.ok) {
          console.error(
            `Immagine SVG ${absoluteUrl}: HTTP ${response.status}`
          );
          return null;
        }

        const buffer = Buffer.from(
          await response.arrayBuffer()
        );

        return [
          imageUrl,
          toDataUri(
            buffer,
            guessContentType(absoluteUrl)
          )
        ];
      } catch (error) {
        console.error(
          `Errore immagine SVG ${absoluteUrl}: ${error.message}`
        );
        return null;
      }
    })
  );

  return replaceSvgImages(
    svg,
    replacements.filter(Boolean)
  );
}


export async function loadFontForSpan(
  span,
  pageBaseUrl,
  headers,
  fontCache
) {
  if (!span.fontFamily || !span.fontUrl) {
    return null;
  }

  let fontUrl = span.fontUrl;

  if (fontUrl.includes('#PATH#')) {
    fontUrl = fontUrl.replace(
      '#PATH#',
      `${pageBaseUrl}/pages/`
    );
  } else {
    fontUrl = resolveAssetUrl(
      fontUrl,
      `${pageBaseUrl}/pages/`
    );
  }

  if (fontCache.has(fontUrl)) {
    return fontCache.get(fontUrl);
  }

  if (DEBUG) {
    console.log(
      `Downloading font ${span.fontFamily}: ${fontUrl}`
    );
  }

  const response = await fetch(fontUrl, {
    headers: {
      ...headers,
      'Accept':
        'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'font'
    }
  });

  if (!response.ok) {
    console.warn(
      `Warning: font unavailable: ${fontUrl} HTTP ${response.status}`
    );

    fontCache.set(fontUrl, null);

    return null;
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  fontCache.set(fontUrl, buffer);

  return buffer;
}
