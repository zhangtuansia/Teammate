const LOCAL_MODE = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true";
const LOCAL_SERVER_URL = (
  process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL || "http://127.0.0.1:8787"
).replace(/\/+$/, "");

interface LocalFetchAuthenticationState {
  credential: string;
  originalFetch: typeof globalThis.fetch;
  installed: boolean;
}

const LOCAL_FETCH_STATE = Symbol.for("teammate.localFetchAuthentication");
const localGlobal = globalThis as typeof globalThis & {
  [LOCAL_FETCH_STATE]?: LocalFetchAuthenticationState;
};

function localFetchState() {
  localGlobal[LOCAL_FETCH_STATE] ??= {
    credential: process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_CONTROLLER_TOKEN || "",
    originalFetch: globalThis.fetch.bind(globalThis),
    installed: false,
  };
  return localGlobal[LOCAL_FETCH_STATE];
}

function targetsLocalService(input: RequestInfo | URL) {
  try {
    const inputUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    const url = new URL(inputUrl, globalThis.location?.href || LOCAL_SERVER_URL);
    return url.origin === new URL(LOCAL_SERVER_URL).origin;
  } catch {
    return false;
  }
}

export function setLocalControllerCredential(credential: string) {
  if (!LOCAL_MODE) return;
  if (credential.length < 32) {
    throw new Error("The local controller credential is missing or invalid");
  }
  localFetchState().credential = credential;
  installLocalFetchAuthentication();
}

export function getLocalControllerCredential() {
  if (!LOCAL_MODE) return "";
  const credential = localFetchState().credential;
  if (!credential) {
    throw new Error("The Teammate local controller has not initialized");
  }
  return credential;
}

export function installLocalFetchAuthentication() {
  const state = localFetchState();
  if (!LOCAL_MODE || state.installed || !state.credential) return;
  state.installed = true;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!targetsLocalService(input)) return state.originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${state.credential}`);
    }
    return state.originalFetch(input, { ...init, headers });
  };
}

export function isAuthenticatedLocalAssetPath(url: string) {
  return (
    LOCAL_MODE &&
    (url.startsWith("/api/avatars/") || url.startsWith("/api/attachments/"))
  );
}

/** Attachment references are written by the composer as a root-relative local
 * service path, so they stay portable across the dev and packaged ports. */
export function isLocalAttachmentPath(url: string) {
  return /^\/api\/attachments\/[a-f0-9-]{36}\.[a-z0-9]{1,5}$/i.test(url);
}

if (localFetchState().credential) installLocalFetchAuthentication();
