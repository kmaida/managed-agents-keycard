// keycard-client.ts — Keycard STS authorization client
//
// Uses the @keycardai/oauth SDK for RFC 8693 token exchange.
// Flow: client credentials grant → exchange for resource-scoped token.
//
// Falls back to a mock Cedar policy engine when credentials aren't set.

import {
  TokenExchangeClient,
  fetchAuthorizationServerMetadata,
} from "@keycardai/oauth";
import type { AuthorizationRequest, AuthorizationResponse } from "./types.js";

const STS_URL = process.env.KEYCARD_STS_URL;
const CLIENT_ID = process.env.KEYCARD_CLIENT_ID;
const CLIENT_SECRET = process.env.KEYCARD_CLIENT_SECRET;

const useMock = !STS_URL || !CLIENT_ID || !CLIENT_SECRET;

if (useMock) {
  console.log(
    "⚠️  Keycard credentials not configured — using mock policy engine"
  );
  console.log(
    "   Set KEYCARD_STS_URL, KEYCARD_CLIENT_ID, KEYCARD_CLIENT_SECRET for live mode\n"
  );
}

// ─── Live Keycard STS call (SDK) ───────────────────────────────────

/** Derive the issuer base URL from the STS token endpoint */
function getIssuerUrl(): string {
  const url = new URL(STS_URL!);
  // Strip /oauth/token (or any path) to get the issuer origin
  return url.origin;
}

/** Cached client and bootstrap token */
let exchangeClient: TokenExchangeClient | null = null;
let cachedSubjectToken: string | null = null;
let tokenExpiresAt = 0;

/** Initialize the SDK exchange client (lazy, once) */
function getExchangeClient(): TokenExchangeClient {
  if (!exchangeClient) {
    exchangeClient = new TokenExchangeClient(getIssuerUrl(), {
      clientId: CLIENT_ID!,
      clientSecret: CLIENT_SECRET!,
    });
  }
  return exchangeClient;
}

/**
 * Get a subject token via OAuth 2.0 client credentials grant.
 * This represents the orchestrator's own identity — needed as the
 * subject_token input for the RFC 8693 exchange.
 */
async function getSubjectToken(): Promise<string> {
  // Return cached token if still valid (with 30s buffer)
  if (cachedSubjectToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedSubjectToken;
  }

  // Discover the token endpoint
  const metadata = await fetchAuthorizationServerMetadata(getIssuerUrl());
  const tokenEndpoint = metadata.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error("Keycard metadata missing token_endpoint");
  }

  // Standard OAuth 2.0 client credentials grant (not token exchange)
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Client credentials grant failed (${res.status}): ${error}`);
  }

  const data = await res.json();
  const token: string = data.access_token;
  cachedSubjectToken = token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return token;
}

/**
 * Map an authorization request to the appropriate Keycard resource URI.
 * Deploy actions targeting production use the production resource;
 * everything else (code review, tests) uses the repository resource.
 */
function resolveResourceUri(req: AuthorizationRequest): string {
  if (req.action === "deploy" && req.resource.includes("production")) {
    return "urn:managed-agents:production";
  }
  return "urn:managed-agents:repository";
}

/** Authorize via Keycard STS using the SDK */
async function authorizeViaKeycard(
  req: AuthorizationRequest
): Promise<AuthorizationResponse> {
  try {
    const client = getExchangeClient();
    const subjectToken = await getSubjectToken();
    const resource = resolveResourceUri(req);

    const result = await client.exchangeToken({
      subjectToken,
      resource,
      scope: `action:${req.action} resource:${req.resource}`,
    });

    return {
      decision: "allow",
      reason: "Authorized by Keycard Cedar policy",
      scoped_token: result.accessToken,
      expires_in: result.expiresIn,
    };
  } catch (err) {
    // STS denial or network error → deny
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "deny",
      reason: `Keycard STS: ${message}`,
    };
  }
}

// ─── Mock Cedar policy engine ───────────────────────────────────────
// Simulates the Cedar policies in agent-delegation.cedar

function authorizeViaMock(
  req: AuthorizationRequest
): AuthorizationResponse {
  const hour = new Date().getHours();
  const isBusinessHours = hour >= 9 && hour < 17;

  console.log(`   🔒 Policy check: ${req.target_agent} → ${req.action} on ${req.resource}`);
  console.log(`      Current hour: ${hour} (business hours: ${isBusinessHours})`);

  // Policy 1: deploy actions can only happen during business hours
  if (req.action === "deploy") {
    if (!isBusinessHours) {
      return {
        decision: "deny",
        reason:
          "Cedar policy 'deploy-business-hours-only': deployments are restricted to 9am–5pm. " +
          `Current time is ${hour}:00.`,
        policy_id: "policy::deploy-business-hours-only",
      };
    }
  }

  // Policy 2: cannot deploy to production from non-main branches
  if (req.action === "deploy" && req.resource.includes("production")) {
    const branch = (req.context?.branch as string) ?? "unknown";
    if (branch !== "main") {
      return {
        decision: "deny",
        reason:
          `Cedar policy 'production-main-only': production deploys require branch=main, got '${branch}'.`,
        policy_id: "policy::production-main-only",
      };
    }
  }

  // Policy 3: code review gets read-only scope
  if (req.action === "review" || req.action === "read") {
    return {
      decision: "allow",
      reason: "Authorized with read-only scope per Cedar policy 'reviewer-read-only'.",
      scoped_token: "eyJ...mock-scoped-readonly-token",
      expires_in: 3600,
      policy_id: "policy::reviewer-read-only",
    };
  }

  // Policy 4: test execution is allowed
  if (req.action === "test" || req.action === "execute_tests") {
    return {
      decision: "allow",
      reason: "Authorized per Cedar policy 'allow-test-execution'.",
      scoped_token: "eyJ...mock-scoped-test-token",
      expires_in: 3600,
      policy_id: "policy::allow-test-execution",
    };
  }

  // Default: allow with standard scope
  return {
    decision: "allow",
    reason: "Authorized (default allow).",
    scoped_token: "eyJ...mock-default-token",
    expires_in: 3600,
  };
}

// ─── Public API ─────────────────────────────────────────────────────

/** Authorize an agent action through Keycard (live STS or mock fallback) */
export async function authorize(
  req: AuthorizationRequest
): Promise<AuthorizationResponse> {
  if (useMock) {
    return authorizeViaMock(req);
  }
  return authorizeViaKeycard(req);
}
