const DATA_KEY =
  '1cff42dabb60beaf1e3b57988af787246c63613ef60435a05c9c79b98a9b41c8';

export function decryptLm60(body) {
  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, '');

  let decoded = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  let i = 0;

  while (i < base64.length) {
    const l = chars.indexOf(base64.charAt(i++));
    const f = chars.indexOf(base64.charAt(i++));
    const p = chars.indexOf(base64.charAt(i++));
    const w = chars.indexOf(base64.charAt(i++));

    const o = (l << 2) | (f >> 4);
    const s = ((f & 15) << 4) | (p >> 2);
    const a = ((p & 3) << 6) | w;

    decoded += String.fromCharCode(o);

    if (p !== 64) {
      decoded += String.fromCharCode(s);
    }

    if (w !== 64) {
      decoded += String.fromCharCode(a);
    }
  }

  // Identico al viewer LM60:
  decoded = unescape(decoded);

  let result = '';

  for (let i = 0; i < decoded.length; i++) {
    const value = decoded.charCodeAt(i);

    const keyChar = DATA_KEY.substr(
      (i % DATA_KEY.length) - 1,
      1
    );

    result += String.fromCharCode(
      value - keyChar.charCodeAt(0)
    );
  }

  return result;
}
