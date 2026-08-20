import { createBrowserClient } from "@supabase/ssr";
import { createLocalClient } from "@zano/local-client";

type BrowserClient = ReturnType<typeof createBrowserClient>;
let localClient: BrowserClient | null = null;

export function createClient(): BrowserClient {
  if (process.env.NEXT_PUBLIC_ZANO_LOCAL_MODE === "true") {
    if (!localClient) {
      const baseUrl =
        process.env.NEXT_PUBLIC_ZANO_LOCAL_SERVER_URL ||
        "http://127.0.0.1:8787";
      // LocalClient intentionally mirrors the Supabase methods used by the UI.
      localClient = createLocalClient(baseUrl) as unknown as BrowserClient;
    }
    return localClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // Return a dummy client during build/prerender — will never be called at runtime
    return createBrowserClient(
      "https://placeholder.supabase.co",
      "placeholder-key"
    );
  }

  return createBrowserClient(url, key);
}
