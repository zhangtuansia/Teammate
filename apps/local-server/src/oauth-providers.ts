/**
 * Subscription sign-in for the providers that offer one.
 *
 * The flows themselves live in the pinned `@mariozechner/pi-ai` SDK, which the
 * runtime already uses to talk to these providers — reimplementing PKCE and
 * token refresh here would mean maintaining a second copy of somebody else's
 * protocol. The SDK's `./oauth` entry point is imported directly rather than
 * through the package root so the lazy provider registry stays out of the
 * packaged sidecar.
 */
import {
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  type OAuthCredentials,
  type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";

export type SubscriptionProviderId = "anthropic-claude" | "github-copilot";

export interface SubscriptionProviderDescriptor {
  id: SubscriptionProviderId;
  name: string;
  /** Wire format the runtime should speak once signed in. */
  apiFormat: "anthropic-messages" | "openai-completions";
  /** Provider key in the SDK model registry, for the model catalog. */
  catalogProvider: "anthropic" | "github-copilot";
}

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderDescriptor[] = [
  {
    id: "anthropic-claude",
    name: "Claude Pro / Max",
    apiFormat: "anthropic-messages",
    catalogProvider: "anthropic",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    apiFormat: "openai-completions",
    catalogProvider: "github-copilot",
  },
];

const IMPLEMENTATIONS: Record<SubscriptionProviderId, OAuthProviderInterface> = {
  "anthropic-claude": anthropicOAuthProvider,
  "github-copilot": githubCopilotOAuthProvider,
};

export function isSubscriptionProvider(value: unknown): value is SubscriptionProviderId {
  return SUBSCRIPTION_PROVIDERS.some((provider) => provider.id === value);
}

export function subscriptionProviderDescriptor(id: SubscriptionProviderId) {
  return SUBSCRIPTION_PROVIDERS.find((provider) => provider.id === id)!;
}

export interface SubscriptionAuthPrompt {
  /** The URL to open in a browser. */
  url: string;
  /**
   * The short code a device-code provider expects on the opened page. Callback
   * providers leave this empty: their redirect carries the grant, and the
   * prose they pass alongside the URL is guidance, not something to type.
   */
  deviceCode?: string;
}

/** Device codes are short and hyphen-grouped ("566A-00EB"); anything longer is
 * the provider explaining itself rather than handing over a code. */
function readDeviceCode(instructions: string | undefined) {
  const match = instructions?.match(/\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)\b/);
  return match ? match[1] : undefined;
}

export interface SubscriptionLoginHandle {
  /** Resolves with credentials once the person finishes in their browser. */
  completed: Promise<OAuthCredentials>;
  /** What to show. Resolves as soon as the flow produces it. */
  prompt: Promise<SubscriptionAuthPrompt>;
}

/**
 * Start a sign-in. Providers differ in shape — Anthropic redirects to a
 * loopback listener the SDK owns, GitHub polls a device code — and both report
 * through `onAuth`, so callers only surface what it hands back and wait.
 */
export function startSubscriptionLogin(
  id: SubscriptionProviderId,
  signal?: AbortSignal,
): SubscriptionLoginHandle {
  const provider = IMPLEMENTATIONS[id];
  let publishPrompt: (prompt: SubscriptionAuthPrompt) => void = () => undefined;
  let failPrompt: (error: Error) => void = () => undefined;
  const prompt = new Promise<SubscriptionAuthPrompt>((resolve, reject) => {
    publishPrompt = resolve;
    failPrompt = reject;
  });

  const completed = provider
    .login({
      // The SDK calls this either with an info object or with (url,
      // instructions) depending on the provider; accept both shapes.
      onAuth: ((info: unknown, instructions?: string) => {
        if (typeof info === "string") {
          const deviceCode = readDeviceCode(instructions);
          publishPrompt({ url: info, ...(deviceCode ? { deviceCode } : {}) });
          return;
        }
        const detail = info as { url?: unknown; instructions?: unknown };
        if (typeof detail?.url === "string") {
          const deviceCode = readDeviceCode(
            typeof detail.instructions === "string" ? detail.instructions : undefined,
          );
          publishPrompt({ url: detail.url, ...(deviceCode ? { deviceCode } : {}) });
        }
      }) as never,
      // Copilot asks for an optional GitHub Enterprise domain before starting.
      // Answering empty selects github.com, which is what this flow offers.
      onPrompt: async (request) => {
        if (request.allowEmpty) return "";
        throw new Error(`${provider.name} needs input this sign-in cannot provide`);
      },
      ...(signal ? { signal } : {}),
    })
    .catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      failPrompt(failure);
      throw failure;
    });

  return { completed, prompt };
}

export async function refreshSubscriptionToken(
  id: SubscriptionProviderId,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  return IMPLEMENTATIONS[id].refreshToken(credentials);
}

/** The token the runtime should send for these credentials. */
export function subscriptionApiKey(
  id: SubscriptionProviderId,
  credentials: OAuthCredentials,
): string {
  return IMPLEMENTATIONS[id].getApiKey(credentials);
}

/** Copilot rewrites the endpoint per account, so ask the provider. */
export function subscriptionBaseUrl(
  id: SubscriptionProviderId,
  credentials: OAuthCredentials,
): string | null {
  const provider = IMPLEMENTATIONS[id];
  if (!provider.modifyModels) return null;
  const probe = [{ baseUrl: "" }] as unknown as Parameters<
    NonNullable<OAuthProviderInterface["modifyModels"]>
  >[0];
  const [model] = provider.modifyModels(probe, credentials);
  const baseUrl = (model as { baseUrl?: unknown })?.baseUrl;
  return typeof baseUrl === "string" && baseUrl ? baseUrl : null;
}

export type { OAuthCredentials };
