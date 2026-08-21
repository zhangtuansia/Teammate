import "@/lib/local-auth";

export function apiUrl(path: string) {
  if (
    process.env.NEXT_PUBLIC_TEAMMATE_DESKTOP === "true" ||
    process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true"
  ) {
    const baseUrl =
      process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL || "http://127.0.0.1:8787";
    return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }
  return path;
}
