import { createServerClient } from "@supabase/ssr";
import { createLocalClient } from "@teammate/local-client";
import { cookies } from "next/headers";
import { getLocalControllerCredential } from "@/lib/local-auth";

type ServerClient = ReturnType<typeof createServerClient>;
let localClient: ServerClient | null = null;

export async function createClient(): Promise<ServerClient> {
  if (process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true") {
    if (!localClient) {
      const baseUrl =
        process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL ||
        "http://127.0.0.1:8787";
      // LocalClient intentionally mirrors the Supabase methods used by API routes.
      localClient = createLocalClient(
        baseUrl,
        getLocalControllerCredential(),
      ) as unknown as ServerClient;
    }
    return localClient;
  }

  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Check your .env.local file."
    );
  }

  return createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method is called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}
