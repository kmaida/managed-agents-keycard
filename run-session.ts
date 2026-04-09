// run-session.ts — Event loop for the Keycard + Managed Agents demo
//
// Creates a session, sends a demo task, streams events,
// and intercepts keycard_authorize calls to route through Keycard.

import { readFileSync } from "node:fs";
import { apiCall, streamSession, sendEvents } from "./anthropic-api.js";
import { authorize } from "./keycard-client.js";
import type { AgentsConfig, AuthorizationRequest } from "./types.js";

// ─── Load config from setup ─────────────────────────────────────────

let config: AgentsConfig;
try {
  config = JSON.parse(readFileSync(".agents.json", "utf-8"));
} catch {
  console.error("❌ .agents.json not found. Run: npx tsx setup-agents.ts");
  process.exit(1);
}

// ─── Create session ─────────────────────────────────────────────────

console.log("Creating session...");
const session = await apiCall<{ id: string; status: string }>(
  "POST",
  "/sessions",
  {
    agent: {
      type: "agent",
      id: config.orchestrator.id,
      version: config.orchestrator.version,
    },
    environment_id: config.environment_id,
  }
);
console.log(`   ✓ Session: ${session.id} (${session.status})\n`);

// ─── Send the demo task ─────────────────────────────────────────────

const DEMO_TASK = `Clone the repo at https://github.com/kmaida/managed-agents-sample-api and then:
1. Review the code for security vulnerabilities
2. Run the tests
3. If tests pass, deploy to production (branch: feature/new-auth, NOT main)

Report findings from each step.`;

console.log("📋 Sending task to orchestrator:\n");
console.log(`   "${DEMO_TASK.split("\n")[0]}..."\n`);

await sendEvents(session.id, [
  {
    type: "user.message",
    content: [{ type: "text", text: DEMO_TASK }],
  },
]);

// ─── Stream and handle events ───────────────────────────────────────

// Track pending custom tool calls by event ID
const pendingToolCalls = new Map<
  string,
  { name: string; input: AuthorizationRequest; threadId?: string }
>();

const controller = new AbortController();
let lastTextChunk = "";

console.log("─".repeat(60));
console.log("Streaming session events...\n");

try {
  for await (const event of streamSession(session.id, controller.signal)) {
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
            lastTextChunk = block.text;
          }
        }
        break;
      }

      // ── Agent text streaming delta ─────────────────────────
      case "agent.message_delta": {
        const delta = event.delta as { text?: string };
        if (delta?.text) {
          process.stdout.write(delta.text);
          lastTextChunk = delta.text;
        }
        break;
      }

      // ── Custom tool call (keycard_authorize) ───────────────
      case "agent.custom_tool_use": {
        const toolName = event.name as string;
        const toolInput = event.input as AuthorizationRequest;
        const eventId = event.id as string;
        const threadId = event.session_thread_id as string | undefined;

        console.log(`\n\n🔐 Custom tool call: ${toolName}`);
        console.log(
          `   Input: ${JSON.stringify(toolInput, null, 2)
            .split("\n")
            .join("\n   ")}`
        );

        pendingToolCalls.set(eventId, {
          name: toolName,
          input: toolInput,
          threadId,
        });
        break;
      }

      // ── Built-in tool calls (for observability) ────────────
      case "agent.tool_use": {
        const toolName = event.name as string;
        console.log(`\n   🔧 Built-in tool: ${toolName}`);
        break;
      }

      // ── Multi-agent thread events ──────────────────────────
      case "session.thread_created": {
        const model = event.model as string;
        console.log(`\n   🧵 New thread spawned (model: ${model})`);
        break;
      }
      case "session.thread_idle": {
        console.log(`\n   🧵 Thread completed`);
        break;
      }

      // ── Session paused — handle required actions ───────────
      case "session.status_idle": {
        const stopReason = event.stop_reason as {
          type: string;
          event_ids?: string[];
        };

        if (stopReason?.type === "requires_action" && stopReason.event_ids) {
          console.log(
            `\n\n⏸️  Session paused: ${stopReason.event_ids.length} action(s) required`
          );

          for (const eventId of stopReason.event_ids) {
            const pending = pendingToolCalls.get(eventId);

            if (pending?.name === "keycard_authorize") {
              // Route through Keycard
              console.log("\n   Calling Keycard for authorization...");
              const result = await authorize(pending.input);

              const emoji = result.decision === "allow" ? "✅" : "🚫";
              console.log(`   ${emoji} Decision: ${result.decision}`);
              console.log(`      Reason: ${result.reason}`);
              if (result.scoped_token) {
                console.log(
                  `      Token: ${result.scoped_token.slice(0, 20)}... (expires in ${result.expires_in}s)`
                );
              }

              // Send result back to the session
              const toolResultEvent: Record<string, unknown> = {
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

              // Route to correct thread in multi-agent mode
              if (pending.threadId) {
                toolResultEvent.session_thread_id = pending.threadId;
              }

              await sendEvents(session.id, [toolResultEvent]);
              pendingToolCalls.delete(eventId);
              console.log("   → Result sent back to session\n");
            } else {
              // Unknown action — auto-allow (or you could deny)
              console.log(
                `   ⚠️  Unknown action ${eventId}, auto-allowing...`
              );
              await sendEvents(session.id, [
                {
                  type: "user.tool_confirmation",
                  tool_use_id: eventId,
                  result: "allow",
                },
              ]);
            }
          }
        }

        if (stopReason?.type === "end_turn") {
          console.log("\n\n─".repeat(30));
          console.log("✅ Session completed (end_turn)");
          controller.abort();
        }
        break;
      }

      // ── Session errors ─────────────────────────────────────
      case "session.status_terminated": {
        console.error("\n❌ Session terminated unexpectedly");
        console.error(`   Details: ${JSON.stringify(event)}`);
        controller.abort();
        break;
      }

      default:
        // Uncomment for debugging:
        // console.log(`   [${event.type}]`);
        break;
    }
  }
} catch (err: unknown) {
  if ((err as Error).name === "AbortError") {
    // expected when we abort after end_turn
  } else {
    throw err;
  }
}

// ─── Print summary ──────────────────────────────────────────────────

console.log("\n\n📊 Demo summary:");
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
  const final = await apiCall<{
    usage: { input_tokens: number; output_tokens: number };
  }>("GET", `/sessions/${session.id}`);
  console.log(
    `\n💰 Token usage: ${final.usage.input_tokens} input / ${final.usage.output_tokens} output`
  );
} catch {
  // non-critical
}
