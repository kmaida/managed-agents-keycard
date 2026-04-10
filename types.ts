// types.ts — Shared types for the Managed Agents + Keycard demo

import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents";

export interface AgentRef {
  id: string;
  version: number;
  name: string;
}

export interface AgentsConfig {
  environment_id: string;
  orchestrator: AgentRef;
  subAgents: AgentRef[];
}

// Custom tool schema for keycard_authorize
export const KEYCARD_AUTHORIZE_TOOL = {
  type: "custom",
  name: "keycard_authorize",
  description: `Authorize an action before performing it. Call this tool BEFORE delegating
work to another agent or before executing any sensitive operation (deploy, write,
delete). The tool evaluates authorization policy and returns whether the action
is allowed, denied, or requires additional approval.

You MUST call this tool before:
- Delegating to the deployer agent
- Delegating to the code-reviewer agent
- Delegating to the test-runner agent
- Running any bash command that modifies production resources

If the result is "denied", do NOT proceed with the action. Report the denial
reason to the user and suggest alternatives.`,
  input_schema: {
    type: "object",
    properties: {
      target_agent: {
        type: "string",
        description:
          "The name of the agent or tool being delegated to (e.g. 'deployer', 'code-reviewer', 'test-runner')",
      },
      action: {
        type: "string",
        description:
          "The action being requested (e.g. 'deploy', 'review', 'run-tests', 'bash:rm', 'write-file')",
      },
      resource: {
        type: "string",
        description:
          "The resource being acted on (e.g. 'repo:acme/api', 'env:production', 'file:deploy.sh')",
      },
      context: {
        type: "object",
        description:
          "Additional context for policy evaluation (e.g. branch name, PR number, urgency level)",
        properties: {},
        additionalProperties: true,
      },
    },
    required: ["target_agent", "action", "resource"],
  },
} satisfies BetaManagedAgentsCustomToolParams;

// Authorization request/response types
export interface AuthorizationRequest {
  target_agent: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

export interface AuthorizationResponse {
  decision: "allow" | "deny";
  reason: string;
  scoped_token?: string;
  expires_in?: number;
  policy_id?: string;
}
