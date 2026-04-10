// anthropic-api.ts — Anthropic SDK client for Managed Agents

import Anthropic from "@anthropic-ai/sdk";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents";
import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions";

export const client = new Anthropic();

/**
 * Create an environment (container config for agent sessions).
 */
export async function createEnvironment(name: string) {
  return client.beta.environments.create({
    name,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
}

/**
 * Create an agent with model, system prompt, and tools.
 */
export async function createAgent(config: AgentCreateParams) {
  return client.beta.agents.create(config);
}

/**
 * Create a session referencing an agent and environment.
 */
export async function createSession(agentId: string, environmentId: string) {
  return client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
  });
}

/**
 * Send events to a session (user messages, tool results, etc.).
 */
export async function sendEvents(sessionId: string, events: BetaManagedAgentsEventParams[]) {
  return client.beta.sessions.events.send(sessionId, { events });
}

/**
 * Open an SSE stream and yield parsed event objects.
 *
 * TODO(sdk-beta): Return type should be AsyncGenerator<BetaManagedAgentsStreamSessionEvents>
 * but the SDK's union (0.86.1) is missing thread events (session.thread_created,
 * session.thread_idle) that run-session.ts handles. Revisit when SDK catches up.
 */
export async function* streamSession(
  sessionId: string
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  for await (const event of stream) {
    yield event as unknown as { type: string; [key: string]: unknown };
  }
}

/**
 * Get session details (status, usage, etc.).
 */
export async function getSession(sessionId: string) {
  return client.beta.sessions.retrieve(sessionId);
}
