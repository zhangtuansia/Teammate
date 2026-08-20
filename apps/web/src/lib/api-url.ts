export function apiUrl(path: string) {
  if (process.env.NEXT_PUBLIC_ZANO_DESKTOP === "true") {
    const baseUrl =
      process.env.NEXT_PUBLIC_ZANO_LOCAL_SERVER_URL || "http://127.0.0.1:8787";
    return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }
  return path;
}
