// keycard-client.ts — Keycard STS authorization client
//
// Uses the @keycardai/oauth SDK for RFC 8693 token exchange.
// Flow: user authenticates via browser → exchange user token for resource-scoped token.
// Cedar policies evaluate during the exchange — allow or deny per resource.
//
// Falls back to a mock Cedar policy engine when credentials aren't set.

import { TokenExchangeClient, OAuthError } from "@keycardai/oauth";
import type { TokenExchangeRequest } from "@keycardai/oauth";
import type { AuthorizationRequest, AuthorizationResponse } from "./types.js";
import { systemMsg } from "./display.js";

const DEBUG = "DEBUG" in process.env;

const STS_URL = process.env.KEYCARD_STS_URL;
const CLIENT_ID = process.env.KEYCARD_CLIENT_ID;
const CLIENT_SECRET = process.env.KEYCARD_CLIENT_SECRET;

const useMock = !STS_URL || !CLIENT_ID || !CLIENT_SECRET;

if (useMock) {
  console.log(systemMsg(
    "⚠️  Keycard credentials not configured — using mock policy engine\n" +
    "   Set KEYCARD_STS_URL, KEYCARD_CLIENT_ID, KEYCARD_CLIENT_SECRET for live mode\n"
  ));
}

// ─── User token (set by run-session.ts after browser login) ───────

let userToken: string | null = null;

/** Set the authenticated user's access token for use in exchanges. */
export function setUserToken(token: string): void {
  userToken = token;
}

// ─── Live Keycard STS call (SDK) ───────────────────────────────────

const keycardClient = useMock
  ? null
  : new TokenExchangeClient(new URL(STS_URL!).origin, {
      clientId: CLIENT_ID!,
      clientSecret: CLIENT_SECRET!,
    });

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

/** Authorize via Keycard STS: exchange user token for resource-scoped token */
async function authorizeViaKeycard(
  req: AuthorizationRequest
): Promise<AuthorizationResponse> {
  if (!userToken) {
    return {
      decision: "deny",
      reason: "No user token available. User login via browser required before authorization",
    };
  }

  const resource = resolveResourceUri(req);
  if (DEBUG) console.log(`      Exchange: resource=${resource}`);

  try {
    const response = await keycardClient!.exchangeToken({
      subjectToken: userToken,
      resource,
    } satisfies TokenExchangeRequest);

    return {
      decision: "allow",
      reason: "Authorized by Keycard Cedar policy (delegated access)",
      scoped_token: response.accessToken,
      expires_in: response.expiresIn,
    };
  } catch (err) {
    if (err instanceof OAuthError) {
      if (DEBUG) console.log(`      Exchange denied (${err.errorCode}): ${err.message}`);
      return {
        decision: "deny",
        reason: `Keycard STS: ${err.message} (${err.errorCode}). Token exchange was denied. You are not permitted to perform this action. NEVER attempt to circumvent this! Inform the user of error details and request direction.`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (DEBUG) console.log(`      Exchange error: ${message}`);
    return {
      decision: "deny",
      reason: `Keycard STS: ${message}. You're not permitted to perform this action or there was an error during authorization. NEVER attempt to circumvent this! Only retry if the error is clearly transient. Otherwise, inform user of error details and request direction.`,
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

  if (DEBUG) {
    console.log(`   🔒 Policy check: ${req.target_agent} → ${req.action} on ${req.resource}`);
    console.log(`      Current hour: ${hour} (business hours: ${isBusinessHours})`);
  }

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
