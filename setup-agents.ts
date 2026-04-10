// setup-agents.ts — Create environment + agents, write IDs to .agents.json
//
// Run once:  npx tsx setup-agents.ts
// Reads:     .env
// Writes:    .agents.json (consumed by run-session.ts)

import { writeFileSync } from "node:fs";
import { createEnvironment, createAgent } from "./anthropic-api.js";
import { KEYCARD_AUTHORIZE_TOOL, type AgentsConfig } from "./types.js";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents";

const singleAgentMode = process.env.SINGLE_AGENT_MODE === "true";

// ─── 1. Create environment ──────────────────────────────────────────

console.log("Creating environment...");
const env = await createEnvironment(`keycard-demo-${Date.now()}`);
console.log(`   ✓ Environment: ${env.id}`);

// ─── 2. Create sub-agents (multi-agent mode) ───────────────────────

const subAgents: Array<{ id: string; version: number; name: string }> = [];

if (!singleAgentMode) {
  console.log("\nCreating sub-agents...");

  const codeReviewer = await createAgent({
    name: "code-reviewer",
    model: "claude-sonnet-4-6",
    system: `You are a code reviewer. You review code for correctness, style,
security vulnerabilities, and best practices. You have read-only access.
You NEVER modify files — only read and report findings.
Summarize your findings in a clear, structured format.`,
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "read", enabled: true },
          { name: "glob", enabled: true },
          { name: "grep", enabled: true },
        ],
      },
    ],
  });
  subAgents.push(codeReviewer);
  console.log(`   ✓ code-reviewer: ${codeReviewer.id} (v${codeReviewer.version})`);

  const testRunner = await createAgent({
    name: "test-runner",
    model: "claude-sonnet-4-6",
    system: `You are a test runner. You write and execute tests for the codebase.
You can read files, write test files, and run commands to execute test suites.
Report test results clearly: which passed, which failed, and why.`,
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "web_fetch", enabled: false },
          { name: "web_search", enabled: false },
        ],
      },
    ],
  });
  subAgents.push(testRunner);
  console.log(`   ✓ test-runner:   ${testRunner.id} (v${testRunner.version})`);

  const deployer = await createAgent({
    name: "deployer",
    model: "claude-sonnet-4-6",
    system: `You are a deployment agent. You handle deploying code to environments.
You can run bash commands and write deployment scripts.
Always confirm the target environment and branch before executing any deployment.`,
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "web_fetch", enabled: false },
          { name: "web_search", enabled: false },
        ],
      },
    ],
  });
  subAgents.push(deployer);
  console.log(`   ✓ deployer:      ${deployer.id} (v${deployer.version})`);
}

// ─── 3. Create orchestrator ─────────────────────────────────────────

console.log("\nCreating orchestrator agent...");

const orchestratorSystem = singleAgentMode
  ? `You are an engineering lead agent. You can review code, run tests, and deploy.

CRITICAL: Before performing ANY sensitive action (running bash commands,
writing files, deploying), you MUST first call the keycard_authorize tool.
Pass the action type, target, and resource.

If authorization is DENIED:
- STOP. Do NOT attempt the action.
- Do NOT try alternative approaches to achieve the same goal.
- Do NOT use different tools or methods to work around the denial.
- Report the denial reason to the user and move on to the next task.
A denial is final. Any attempt to circumvent it violates security policy.

This is a security requirement. Never skip authorization checks.`
  : `You are an engineering lead agent that coordinates work across specialized agents.

CRITICAL AUTHORIZATION REQUIREMENT:
Before delegating ANY task to another agent, you MUST first call the
keycard_authorize tool with:
  - target_agent: the name of the agent you want to delegate to
  - action: what you're asking them to do
  - resource: what they'll be acting on

If keycard_authorize returns "denied":
- STOP. Do NOT delegate or attempt that task.
- Do NOT try alternative approaches to achieve the same goal.
- Do NOT use different tools or methods to work around the denial.
- Report the denial reason to the user and move on to the next task.
A denial is final. Any attempt to circumvent it violates security policy.

Your available agents:
- code-reviewer: Reviews code for correctness, style, and security
- test-runner: Writes and executes tests
- deployer: Deploys code to environments`;

const orchestratorConfig = {
  name: "engineering-lead",
  model: "claude-sonnet-4-6" as const,
  system: orchestratorSystem,
  tools: [
    { type: "agent_toolset_20260401" as const },
    KEYCARD_AUTHORIZE_TOOL,
  ],
} satisfies AgentCreateParams;

let orchestrator;

if (!singleAgentMode && subAgents.length > 0) {
  // TODO(sdk-beta): callable_agents is not in AgentCreateParams (SDK 0.86.1).
  // Revisit when Managed Agents API exits beta or SDK adds this field.
  const withCallableAgents = {
    ...orchestratorConfig,
    callable_agents: subAgents.map((a) => ({
      type: "agent" as const,
      id: a.id,
      version: a.version,
    })),
  };
  orchestrator = await createAgent(withCallableAgents as unknown as AgentCreateParams);
} else {
  orchestrator = await createAgent(orchestratorConfig);
}

console.log(
  `   ✓ engineering-lead: ${orchestrator.id} (v${orchestrator.version})`
);

// ─── 4. Write config ────────────────────────────────────────────────

const config: AgentsConfig = {
  environment_id: env.id,
  orchestrator: {
    id: orchestrator.id,
    version: orchestrator.version,
    name: orchestrator.name,
  },
  subAgents: subAgents.map((a) => ({
    id: a.id,
    version: a.version,
    name: a.name,
  })),
};

writeFileSync(".agents.json", JSON.stringify(config, null, 2));
console.log("\n✅ Setup complete. Config written to .agents.json");
console.log(`   Mode: ${singleAgentMode ? "single-agent" : "multi-agent"}`);
console.log("\nRun the demo:  npx tsx run-session.ts");
