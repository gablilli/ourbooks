import fetch from "node-fetch";

function preview(value, limit = 500) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "<empty>";
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "<unserializable>";
  }
}

export async function fetchHubLibrary(token, platform) {
  const res = await fetch(
    `https://ms-api.hubscuola.it/getLibrary/${platform}?version=7.6&platform=web&app=v2`,
    {
      headers: {
        "Token-Session": token,
        Accept: "application/json",
      },
    }
  );

  const payload = await res.json().catch(() => []);

  if (!res.ok) {
    const msg = payload?.message || payload?.error || `Errore libreria HubScuola (${res.status})`;
    console.error("[getLibrary] errore", {
      status: res.status,
      statusText: res.statusText,
      platform,
      payloadPreview: preview(payload),
    });
    throw new Error(msg);
  }

  const books = Array.isArray(payload) ? payload : payload?.data || [];

  return books
    .filter((b) => b && (b.id || b.volumeId))
    .map((b) => ({
      volumeId: String(b.id || b.volumeId),
      title: b.title || b.name || `Libro ${b.id || b.volumeId}`,
      subtitle: b.subtitle || "",
      editor: b.editor || "",
    }));
}
