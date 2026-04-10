// run-session.ts — Event loop for the Keycard + Managed Agents demo
//
// Creates a session, sends a demo task, streams events,
// and intercepts keycard_authorize calls to route through Keycard.

import { readFileSync } from "node:fs";
import { createSession, streamSession, sendEvents, getSession } from "./anthropic-api.js";
import { authorize, setUserToken } from "./keycard-client.js";
import { keycardLogin } from "keycard-cli-login";
import { rule, keycardBox, toolMarker, threadEvent, systemMsg } from "./display.js";
import type { AgentsConfig, AuthorizationRequest } from "./types.js";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsUserCustomToolResultEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions";

// ─── Load config from setup ─────────────────────────────────────────

let config: AgentsConfig;
try {
  config = JSON.parse(readFileSync(".agents.json", "utf-8"));
} catch {
  console.error("❌ .agents.json not found. Run: npx tsx setup-agents.ts");
  process.exit(1);
}

// ─── Authenticate user via Keycard ──────────────────────────────────

const stsUrl = process.env.KEYCARD_STS_URL;
const clientId = process.env.KEYCARD_CLIENT_ID;

if (stsUrl && clientId) {
  // Derive zone URL from the STS URL (strip /oauth/token path)
  const zone = new URL(stsUrl).origin;

  const { accessToken } = await keycardLogin({
    zone,
    clientId,
    clientSecret: process.env.KEYCARD_CLIENT_SECRET,
    resource: "urn:managed-agents:orchestrator",
  });
  setUserToken(accessToken);
} else {
  console.log("⚠️  Keycard credentials not set — running with mock authorization\n");
}

// ─── Create session ─────────────────────────────────────────────────

console.log(systemMsg("Creating session..."));
const session = await createSession(config.orchestrator.id, config.environment_id);
console.log(systemMsg(`   ✓ Session: ${session.id} (${session.status})\n`));

// ─── Send the demo task ─────────────────────────────────────────────

const DEMO_TASK = `Clone the repo at https://github.com/kmaida/managed-agents-sample-api and then:
1. Review the code for security vulnerabilities
2. Run the tests
3. If tests pass, deploy to production (branch: feature/new-auth, NOT main)

Report findings from each step.`;

console.log(rule("TASK"));
console.log(`   "${DEMO_TASK.split("\n")[0]}..."\n`);

await sendEvents(session.id, [
  {
    type: "user.message" as const,
    content: [{ type: "text" as const, text: DEMO_TASK }],
  },
]);

// ─── Stream and handle events ───────────────────────────────────────

// Track pending custom tool calls by event ID
const pendingToolCalls = new Map<
  string,
  { name: string; input: AuthorizationRequest; threadId?: string }
>();

console.log(rule("STREAMING"));

let done = false;

try {
for await (const event of streamSession(session.id)) {
  switch (event.type) {
    // ── Agent text output ──────────────────────────────────
    case "agent.message": {
      const contents = event.content as Array<{
        type: string;
        text?: string;
      }>;
      for (const block of contents) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        }
      }
      break;
    }

    // ── Custom tool call (keycard_authorize) ───────────────
    // Display is deferred to the requires_action handler so we can
    // render the full request + decision as one atomic keycardBox.
    case "agent.custom_tool_use": {
      const toolInput = event.input as AuthorizationRequest;
      const eventId = event.id as string;
      const threadId = event.session_thread_id as string | undefined;

      pendingToolCalls.set(eventId, {
        name: event.name as string,
        input: toolInput,
        threadId,
      });
      break;
    }

    // ── Built-in tool calls (for observability) ────────────
    case "agent.tool_use": {
      console.log(`\n${toolMarker(event.name as string)}`);
      break;
    }

    // ── Multi-agent thread events ──────────────────────────
    // TODO(sdk-beta): session.thread_created and session.thread_idle are not in
    // BetaManagedAgentsStreamSessionEvents (SDK 0.86.1). These events exist at
    // runtime but aren't typed. Revisit when SDK adds them.
    case "session.thread_created": {
      console.log(`\n${threadEvent("spawned", event.model as string)}`);
      break;
    }
    case "session.thread_idle": {
      console.log(`\n${threadEvent("completed")}`);
      break;
    }

    // ── Session paused — handle required actions ───────────
    case "session.status_idle": {
      const stopReason = event.stop_reason as {
        type: string;
        event_ids?: string[];
      };

      if (stopReason?.type === "requires_action" && stopReason.event_ids) {
        for (const eventId of stopReason.event_ids) {
          const pending = pendingToolCalls.get(eventId);

          if (pending?.name === "keycard_authorize") {
            // Route through Keycard and display atomic authorization box
            const result = await authorize(pending.input);
            console.log(`\n${keycardBox(pending.input, result)}`);

            // Send result back to the session
            const toolResultEvent: BetaManagedAgentsUserCustomToolResultEventParams = {
              type: "user.custom_tool_result",
              custom_tool_use_id: eventId,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    decision: result.decision,
                    reason: result.reason,
                    ...(result.scoped_token && {
                      scoped_token: result.scoped_token,
                      expires_in: result.expires_in,
                    }),
                  }),
                },
              ],
            };

            // TODO(sdk-beta): session_thread_id for multi-agent thread routing is not in
            // BetaManagedAgentsUserCustomToolResultEventParams (SDK 0.86.1).
            // Revisit when Managed Agents API exits beta or SDK adds this field.
            if (pending.threadId) {
              await sendEvents(session.id, [
                { ...toolResultEvent, session_thread_id: pending.threadId } as BetaManagedAgentsEventParams,
              ]);
            } else {
              await sendEvents(session.id, [toolResultEvent]);
            }
            pendingToolCalls.delete(eventId);
          } else {
            // Untracked action — log and skip (may be a built-in tool confirmation)
            console.log(systemMsg(
              `   ⚠️  Untracked action ${eventId} (not in pendingToolCalls), skipping`
            ));
          }
        }
      }

      if (stopReason?.type === "end_turn") {
        console.log("\n\n" + rule("SESSION COMPLETE"));
        done = true;
        break;
      }
      break;
    }

    // ── Session errors ─────────────────────────────────────
    case "session.status_terminated": {
      console.error(systemMsg("\n❌ Session terminated unexpectedly", true));
      console.error(systemMsg(`   Details: ${JSON.stringify(event).slice(0, 200)}`));
      done = true;
      break;
    }

    default:
      console.log(systemMsg(`   [${event.type}] ${JSON.stringify(event).slice(0, 120)}`));
      break;
  }
  if (done) break;
}
} catch (err) {
  // Stream errors after session completion are expected (SSE teardown);
  // mid-session timeouts are unusual but shouldn't crash the process.
  if (!done) {
    console.error(systemMsg(`\n⚠️  Stream error: ${err instanceof Error ? err.message : err}`, true));
  }
}

// ─── Print summary ──────────────────────────────────────────────────

console.log("\n" + rule("DEMO SUMMARY"));
console.log("   • Orchestrator cloned a real repo and worked on actual code");
console.log("   • Each action was gated by keycard_authorize → Keycard STS");
console.log("   • Code review: ALLOWED — agent found real security vulnerabilities");
console.log("   • Test execution: ALLOWED — agent ran npm test against real code");
console.log("   • Production deploy: DENIED — Cedar policy blocked feature branch deploy");
console.log(
  "\n   Keycard provides the authorization governance layer for AI agent actions."
);

// Fetch final usage
try {
  const final = await getSession(session.id);
  const usage = (final as unknown as { usage: { input_tokens: number; output_tokens: number } }).usage;
  if (usage) {
    console.log(systemMsg(
      `\n💰 Token usage: ${usage.input_tokens} input / ${usage.output_tokens} output`
    ));
  }
} catch {
  // non-critical
}
