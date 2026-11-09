export function getPageNumbers(master) {
  if (!Array.isArray(master.pages)) return [];

  return master.pages
    .map(page => Number(page.number))
    .filter(Number.isFinite);
}


export function getRequestedPages(pages, value) {
  if (!value) return pages;

  const requested = new Set();

  for (const part of value.split(',')) {
    const item = part.trim();

    if (!item) continue;

    if (item.includes('-')) {
      const [start, end] = item.split('-').map(Number);

      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      for (let i = start; i <= end; i++) {
        requested.add(i);
      }
    } else {
      const page = Number(item);

      if (Number.isFinite(page)) {
        requested.add(page);
      }
    }
  }

  return pages.filter(page => requested.has(page));
}


export function parsePageSize(html) {
  const match = html.match(/width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px/i);

  return {
    width: match ? parseFloat(match[1]) : 909,
    height: match ? parseFloat(match[2]) : 1242
  };
}


export function parseStyles(html) {
  const styles = {};
  const fontFaces = {};

  const styleBlocks = [
    ...html.matchAll(
      /<style[^>]*>([\s\S]*?)<\/style>/gi
    )
  ].map(m => m[1]);

  const css = styleBlocks.join('\n');

  /*
   * legge tutti i @font-face dichiarati dal reader.
   *
   * Esempio:
   *
   * @font-face {
   *   font-family: NeoSansPro-Bold_b;
   *   src: url("#PATH#fonts/NeoSansPro-Bold_b.woff") format("woff");
   * }
   */
  for (const match of css.matchAll(
    /@font-face\s*\{([\s\S]*?)\}/gi
  )) {
    const body = match[1];

    const familyMatch = body.match(
      /font-family\s*:\s*['"]?([^;'"]+)['"]?\s*;/i
    );

    const srcMatch = body.match(
      /src\s*:\s*[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i
    );

    if (!familyMatch || !srcMatch) continue;

    const family = familyMatch[1].trim();
    const src = srcMatch[1].trim();

    fontFaces[family] = src;
  }

  /*
   * parsing delle normali regole CSS.
   */
  for (const rule of css.matchAll(
    /([^{}]+)\{([^{}]*)\}/g
  )) {
    const selectorText = rule[1].trim();

    /*
     * @font-face è già stato elaborato sopra.
     */
    if (
      selectorText
        .toLowerCase()
        .includes('@font-face')
    ) {
      continue;
    }

    const selectors = selectorText
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const body = rule[2];

    const getPx = property => {
      const m = body.match(
        new RegExp(
          `${property}\\s*:\\s*(-?[\\d.]+)px`,
          'i'
        )
      );

      return m
        ? parseFloat(m[1])
        : null;
    };

    const getValue = property => {
      const m = body.match(
        new RegExp(
          `${property}\\s*:\\s*([^;]+)`,
          'i'
        )
      );

      return m
        ? m[1].trim()
        : null;
    };

    const getScaleX = () => {
      const m = body.match(
        /transform\s*:\s*[^;]*scaleX\(\s*([\d.]+)\s*\)/i
      );

      return m
        ? parseFloat(m[1])
        : null;
    };

    let fontFamily = getValue('font-family');

    if (fontFamily) {
      fontFamily = fontFamily
        .replace(/^['"]|['"]$/g, '')
        .trim();
    }

    const style = {
      left: getPx('left'),
      bottom: getPx('bottom'),
      top: getPx('top'),
      fontSize: getPx('font-size'),
      letterSpacing: getPx('letter-spacing'),
      wordSpacing: getPx('word-spacing'),
      lineHeight: getPx('line-height'),
      scaleX: getScaleX(),
      fontFamily,
      fontUrl:
        fontFamily && fontFaces[fontFamily]
          ? fontFaces[fontFamily]
          : null
    };

    const cleanStyle = Object.fromEntries(
      Object.entries(style).filter(
        ([, value]) =>
          value !== null &&
          value !== undefined &&
          value !== ''
      )
    );

    for (const selector of selectors) {
      const idMatches = selector.match(
        /#([a-zA-Z0-9_-]+)/g
      );

      if (idMatches) {
        for (const rawId of idMatches) {
          const id = rawId.slice(1);

          styles[id] = {
            ...(styles[id] || {}),
            ...cleanStyle
          };
        }
      }

      const classMatches = selector.match(
        /\.([a-zA-Z0-9_-]+)/g
      );

      if (classMatches) {
        for (const rawClass of classMatches) {
          const className = rawClass.slice(1);

          styles[className] = {
            ...(styles[className] || {}),
            ...cleanStyle
          };
        }
      }
    }
  }

  return styles;
}


export function decodeHtml(text) {
  return text
    .replace(
      /<br\s*\/?>/gi,
      '\n'
    )
    .replace(
      /<[^>]+>/g,
      ''
    )
    .replace(
      /&nbsp;/gi,
      ' '
    )
    .replace(
      /&amp;/gi,
      '&'
    )
    .replace(
      /&lt;/gi,
      '<'
    )
    .replace(
      /&gt;/gi,
      '>'
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, hex) =>
        String.fromCodePoint(
          parseInt(hex, 16)
        )
    )
    .replace(
      /&#([0-9]+);/g,
      (_, code) =>
        String.fromCodePoint(
          parseInt(code, 10)
        )
    );
}


export function parseSpans(html) {
  const styles = parseStyles(html);
  const spans = [];

  const spanRe =
    /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;

  let match;

  while ((match = spanRe.exec(html)) !== null) {
    const attrs = match[1];
    const rawText = match[2];

    const id =
      attrs.match(/\bid="([^"]+)"/i)?.[1] || null;

    const classes =
      attrs
        .match(/\bclass="([^"]+)"/i)?.[1]
        ?.split(/\s+/)
        .filter(Boolean) || [];

    const style = {
      ...(id && styles[id]
        ? styles[id]
        : {})
    };

    /*
     * applica gli stili delle classi nell'ordine
     * in cui compaiono nell'attributo class.
     */
    for (const className of classes) {
      const classStyle =
        styles[className];

      if (!classStyle) continue;

      for (const [key, value] of Object.entries(
        classStyle
      )) {
        if (
          value !== null &&
          value !== undefined
        ) {
          style[key] = value;
        }
      }
    }

    const text = decodeHtml(rawText);

    if (!text) continue;

    spans.push({
      text,

      left: Number.isFinite(style.left)
        ? style.left
        : 0,

      bottom: Number.isFinite(style.bottom)
        ? style.bottom
        : null,

      top: Number.isFinite(style.top)
        ? style.top
        : null,

      fontSize: Number.isFinite(style.fontSize)
        ? style.fontSize
        : 10,

      letterSpacing:
        Number.isFinite(style.letterSpacing)
          ? style.letterSpacing
          : 0,

      wordSpacing:
        Number.isFinite(style.wordSpacing)
          ? style.wordSpacing
          : 0,

      lineHeight:
        Number.isFinite(style.lineHeight)
          ? style.lineHeight
          : null,

      scaleX:
        Number.isFinite(style.scaleX)
          ? style.scaleX
          : 1,

      fontFamily:
        typeof style.fontFamily === 'string'
          ? style.fontFamily
          : null,

      fontUrl:
        typeof style.fontUrl === 'string'
          ? style.fontUrl
          : null
    });
  }

  return spans;
}


export function getSvgSize(svg) {
  const viewBoxMatch = svg.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  const widthMatch = svg.match(/\bwidth=["']([\d.]+)(?:px)?["']/i);
  const heightMatch = svg.match(/\bheight=["']([\d.]+)(?:px)?["']/i);

  if (viewBoxMatch) {
    return {
      width: parseFloat(viewBoxMatch[1]),
      height: parseFloat(viewBoxMatch[2])
    };
  }

  return {
    width: widthMatch ? parseFloat(widthMatch[1]) : 909,
    height: heightMatch ? parseFloat(heightMatch[1]) : 1242
  };
}
