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

export function normalizePlatform(platform) {
  return platform === "hubkids" ? "kids" : "young";
}

async function readJsonLoose(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return { rawText: text };
      }
    }
    return { rawText: text };
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export async function hubInternalLogin({ username, password, platform }) {
  const normalizedPlatform = normalizePlatform(platform);

  const credentialsPayload = {
    idSito: "ED",
    username,
    password,
    rememberMe: false,
    domain: "hubscuola",
    gRecaptchaResponse: "",
    verifyRecaptcha: false,
    addFullProfile: true,
    addHubEncryptedUser: true,
    refreshLocalData: true,
    activatePromos: true,
  };

  const commonHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.hubscuola.it",
    "Referer": "https://www.hubscuola.it/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Priority": "u=0",
    "TE": "trailers",
    "Connection": "keep-alive",
  };

  async function performHubLogin(useWrappedBody = false) {
    const body = useWrappedBody
      ? JSON.stringify({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentialsPayload),
        })
      : JSON.stringify(credentialsPayload);

    const res = await fetch(
      "https://bce.mondadorieducation.it/app/mondadorieducation/login/hubLoginJsonp",
      { method: "POST", headers: commonHeaders, body }
    );

    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: loginRes, json: loginJson } = await performHubLogin(false);

  if (
    (loginRes.ok && loginJson?.result === "ERROR" && loginJson?.errorCode === "ERRNOPAG") ||
    !loginRes.ok
  ) {
    ({ res: loginRes, json: loginJson } = await performHubLogin(true));
  }

  if (!loginRes.ok || loginJson?.result !== "OK") {
    const msg = loginJson?.message || loginJson?.error || `Hub login failed (${loginRes.status})`;
    console.error("[hubLoginJsonp] errore", {
      status: loginRes.status,
      statusText: loginRes.statusText,
      platform: normalizedPlatform,
      username,
      payloadPreview: preview(loginJson),
    });
    throw new Error(msg);
  }

  const loginData = loginJson?.data || {};
  const loginToken = loginData?.loginToken;

  if (!loginToken) {
    throw new Error("loginToken non presente nella risposta hubLoginJsonp");
  }

  const hubEncryptedUser = loginData?.hubEncryptedUser || "";
  const loginSessionId = loginData?.sessionId || "";

  const appOrigin = `https://${normalizedPlatform}.hubscuola.it`;

  const internalHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": appOrigin,
    "Referer": `${appOrigin}/`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Sec-GPC": "1",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Connection": "keep-alive",
    "TE": "trailers",
  };

  const decodedUser = hubEncryptedUser ? decodeJwtPayload(hubEncryptedUser) : {};
  const decodedLoginToken = decodeJwtPayload(loginToken);

  const resolvedUsername = decodedLoginToken?.username || decodedUser?.username || username;
  const resolvedSessionId = loginSessionId || decodedLoginToken?.sessionId || "";

  if (!resolvedSessionId) {
    throw new Error("sessionId non presente nella risposta hubLoginJsonp");
  }

  const resolvedEmail = decodedLoginToken?.email || decodedUser?.email || username;
  const resolvedFirstName = decodedLoginToken?.nome || decodedUser?.firstName || decodedUser?.name || "";
  const resolvedLastName = decodedLoginToken?.cognome || decodedUser?.lastName || decodedUser?.surname || "";
  const resolvedType = decodedLoginToken?.tipoUtente || decodedUser?.type || "studente";
  const resolvedUserId = String(decodedLoginToken?.idUtente || decodedUser?.id || decodedUser?.userId || "");

  const internalPayloadPrimary = {
    jwt: hubEncryptedUser,
    sessionId: resolvedSessionId,
    userData: decodedUser,
    app: {
      name: normalizedPlatform === "kids" ? "HUB Kids" : "HUB Young",
      type: normalizedPlatform,
      version: "7.6",
    },
    browser: { major: "148", name: "Firefox", version: "148.0", platform: "web" },
    so: { name: "Mac OS", version: "10.15" },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
    username: resolvedUsername,
  };

  const internalPayloadLegacy = {
    username: resolvedUsername,
    email: resolvedEmail,
    type: resolvedType,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    tokenId: loginToken,
    appData: {
      name: normalizedPlatform === "kids" ? "Hub Kids" : "Hub Young",
      id: normalizedPlatform,
      version: "7.6",
    },
    id: resolvedUserId,
    role: decodedUser?.role || "user",
  };

  async function doInternalLogin(payload) {
    const res = await fetch("https://ms-api.hubscuola.it/user/internalLogin", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(payload),
    });
    const json = await readJsonLoose(res);
    return { res, json };
  }

  let { res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadPrimary);

  if (!internalRes.ok) {
    ({ res: internalRes, json: internalJson } = await doInternalLogin(internalPayloadLegacy));
  }

  if (!internalRes.ok) {
    const msg =
      internalJson?.message ||
      internalJson?.error ||
      internalJson?.response ||
      `internalLogin failed (${internalRes.status})`;

    console.error("[internalLogin] errore", {
      status: internalRes.status,
      statusText: internalRes.statusText,
      platform: normalizedPlatform,
      username,
      resolvedUsername,
      resolvedSessionIdPreview: resolvedSessionId ? `${resolvedSessionId.slice(0, 12)}...` : "",
      jwtPreview: loginToken ? `${loginToken.slice(0, 16)}...` : "",
      loginSessionIdPreview: loginSessionId ? `${String(loginSessionId).slice(0, 12)}...` : "",
      payloadPreview: preview(internalJson),
      sentPayload: JSON.stringify(internalPayloadPrimary),
    });

    throw new Error(msg);
  }

  const tokenId =
    internalJson?.tokenId ||
    internalJson?.data?.tokenId ||
    internalJson?.session?.tokenId ||
    internalJson?.response?.tokenId;

  if (!tokenId) {
    throw new Error("tokenId non presente nella risposta internalLogin");
  }

  return { tokenId, normalizedPlatform };
}
