# Keycard + Claude Managed Agents Demo

Demonstrates Keycard authorization governing agent-to-agent delegation
in Anthropic's Claude Managed Agents platform.

## What this demo does

An **orchestrator agent** receives a task like "review this code and deploy
if tests pass." Before delegating work to sub-agents (code-reviewer,
test-runner, deployer), it calls a **custom `keycard_authorize` tool**.

Your client code intercepts that tool call, hits Keycard's STS endpoint
to perform an RFC 8693 token exchange, evaluates Cedar policy, and returns
an allow/deny decision. The orchestrator respects the decision.

This makes the authorization gap in Managed Agents visible:
without Keycard, delegation is a static allowlist with no runtime policy.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Anthropic Managed Agents (cloud container)             │
│                                                         │
│  ┌──────────────┐    delegates    ┌──────────────────┐  │
│  │ Orchestrator  │───────────────▶│ code-reviewer     │  │
│  │ Agent         │───────────────▶│ test-runner       │  │
│  │               │───────────────▶│ deployer          │  │
│  └──────┬───────┘                └──────────────────┘  │
│         │                                               │
│         │ calls custom tool: keycard_authorize           │
└─────────┼───────────────────────────────────────────────┘
          │  session pauses (requires_action)
          ▼
┌─────────────────────┐       ┌──────────────────────┐
│  run-session.ts     │──────▶│  Keycard STS         │
│  (your client)      │       │  + Cedar policy eval  │
│                     │◀──────│                      │
│  sends tool result  │       └──────────────────────┘
│  back to session    │
└─────────────────────┘
```

## Files

```
├── setup-agents.ts        # Creates environment + agents via API
├── run-session.ts         # Event loop: streams session, intercepts
│                          #   keycard_authorize, calls Keycard STS
├── keycard-client.ts      # Keycard STS / authorization client
├── cedar-policies/        # Example Cedar policies for the demo
│   └── agent-delegation.cedar
├── .env.example           # Required env vars
├── package.json
└── tsconfig.json
```

## Prerequisites

- Node.js 20+
- Anthropic API key (Managed Agents beta enabled)
- Keycard API credentials (STS endpoint + client credentials)
- Multi-agent research preview access (request at
  https://claude.com/form/claude-managed-agents)

## Setup

```bash
cp .env.example .env
# Fill in your keys

npm install
npx tsx setup-agents.ts    # Creates agents + environment, writes IDs to .agents.json
npx tsx run-session.ts     # Starts a session and runs the demo
```

## What to watch for

1. The orchestrator receives the task
2. It calls `keycard_authorize` before each delegation
3. Your client intercepts, calls Keycard STS
4. Cedar policy evaluates: deployer is DENIED outside business hours
5. Orchestrator reports back that deployment was blocked by policy
6. Code review and tests proceed normally (ALLOWED by policy)

## Adapting for single-agent mode

If you don't have multi-agent research preview access yet, the demo
still works. `setup-agents.ts` creates a single orchestrator that uses
`keycard_authorize` before calling sensitive built-in tools (bash, write).
The same authorization flow applies — the difference is you're governing
tool access rather than agent delegation.
