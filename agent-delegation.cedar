// Cedar policies for agent delegation authorization
// In production, these are managed in Keycard and evaluated server-side
// by the STS during token exchange. Shown here for documentation.

// ─── Policy 1: Deployments restricted to business hours ─────────────
// Denies any deploy action outside 9am-5pm. The STS token's temporal
// scoping handles the time check; Cedar handles the action/resource match.

permit (
  principal == Agent::"engineering-lead",
  action == Action::"deploy",
  resource
)
when {
  context.current_hour >= 9 && context.current_hour < 17
};

// Explicit deny for off-hours (Cedar is default-deny, but being explicit
// gives better error messages in the policy evaluation response)
forbid (
  principal == Agent::"engineering-lead",
  action == Action::"deploy",
  resource
)
when {
  context.current_hour < 9 || context.current_hour >= 17
}
advice { "reason": "Deployments are restricted to business hours (9am-5pm)" };

// ─── Policy 2: Production deploys require main branch ───────────────

forbid (
  principal,
  action == Action::"deploy",
  resource == Environment::"production"
)
when {
  context.branch != "main"
}
advice { "reason": "Production deploys require branch=main" };

// ─── Policy 3: Code reviewer gets read-only scope ───────────────────
// The STS issues a token with scope=read-only when this policy matches.

permit (
  principal == Agent::"engineering-lead",
  action == Action::"review",
  resource
)
when {
  context.target_agent == "code-reviewer"
};
// Token scope annotation (consumed by STS, not Cedar syntax):
// @token_scope: ["repo:read", "pr:read"]

// ─── Policy 4: Test runner is allowed ───────────────────────────────

permit (
  principal == Agent::"engineering-lead",
  action == Action::"run-tests",
  resource
)
when {
  context.target_agent == "test-runner"
};
// @token_scope: ["repo:read", "ci:execute"]
