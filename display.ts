// display.ts — Lightweight terminal display for the Managed Agents demo
//
// Zero dependencies. Uses raw ANSI escape codes for color/style.
// Respects NO_COLOR (https://no-color.org).

import type { AuthorizationRequest, AuthorizationResponse } from "./types.js";

// ─── ANSI primitives ───────────────────────────────────────────────

const NO_COLOR = "NO_COLOR" in process.env;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

/** Apply ANSI style codes to text. Returns plain text when NO_COLOR is set. */
function style(text: string, ...codes: string[]): string {
  if (NO_COLOR) return text;
  return codes.join("") + text + RESET;
}

/** Terminal width, clamped to a reasonable range. */
function cols(): number {
  return Math.min(process.stdout.columns || 80, 80);
}

// ─── Public formatting functions ───────────────────────────────────

/** Full-width horizontal rule with optional embedded label. */
export function rule(label?: string): string {
  const width = cols();
  if (!label) return style("─".repeat(width), DIM);
  const padded = ` ${label} `;
  const remaining = Math.max(0, width - padded.length - 4);
  return style(`──── ${padded}${"─".repeat(remaining)}`, DIM);
}

/**
 * Box-drawn Keycard authorization summary.
 * Renders the full request + decision as one atomic visual block.
 *
 * Border color (yellow) is applied per-line rather than wrapping the whole
 * string, so inline styles (bold green/red on the decision) don't clobber
 * the border color via RESET.
 */
export function keycardBox(
  input: AuthorizationRequest,
  result: AuthorizationResponse,
): string {
  const width = Math.min(cols(), 62);
  const inner = width - 4; // space inside │  ...  │

  const pad = (text: string) => {
    // Visible length (strip ANSI codes for padding calculation)
    const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = Math.max(0, inner - visible.length);
    // Style borders yellow per-line so inner RESET doesn't bleed
    return `${style("│", YELLOW)}  ${text}${" ".repeat(padding)}  ${style("│", YELLOW)}`;
  };

  const hr = "─".repeat(width - 2);
  const blank = pad("");

  // Header
  const title = " KEYCARD AUTHORIZATION ";
  const titlePad = Math.max(0, width - 2 - title.length);
  const topBorder = style(`┌${title}${"─".repeat(titlePad)}┐`, YELLOW);

  // Request fields
  const lines: string[] = [
    pad(`Agent:    ${input.target_agent}`),
    pad(`Action:   ${input.action}`),
    pad(`Resource: ${input.resource}`),
  ];

  // Context as key-value pairs (not raw JSON)
  if (input.context && Object.keys(input.context).length > 0) {
    for (const [key, value] of Object.entries(input.context)) {
      lines.push(pad(`Context:  ${key} = ${String(value)}`));
    }
  }

  lines.push(blank);

  // Decision — no emoji inside the box (emoji have inconsistent terminal
  // column widths vs JS .length, which breaks pad() alignment)
  const isAllow = result.decision === "allow";
  const decisionText = isAllow ? "ALLOWED" : "DENIED";
  const decisionStyled = isAllow
    ? style(decisionText, BOLD, GREEN)
    : style(decisionText, BOLD, RED);
  lines.push(pad(decisionStyled));

  // Policy ID
  if (result.policy_id) {
    lines.push(pad(`Policy:   ${result.policy_id}`));
  }

  // Reason — first sentence only (full reason includes agent-facing instructions)
  const firstSentence = result.reason ? result.reason.split(/\.\s+/)[0] : "";
  const reason = firstSentence
    ? (firstSentence.endsWith(".") ? firstSentence : `${firstSentence}.`)
    : "(no reason provided)";
  lines.push(pad(`Reason:   ${reason}`));

  // Token (truncated)
  if (result.scoped_token) {
    lines.push(
      pad(`Token:    ${result.scoped_token.slice(0, 20)}... (${result.expires_in}s)`),
    );
  }

  const bottomBorder = style(`└${hr}┘`, YELLOW);

  return [topBorder, ...lines, bottomBorder].join("\n");
}

/** Dim cyan inline rule showing a built-in tool call. */
export function toolMarker(name: string): string {
  const label = ` tool: ${name} `;
  const trailing = Math.max(0, 40 - label.length - 4);
  return style(`  ── ${label}${"─".repeat(trailing)}`, DIM, CYAN);
}

/** Dim magenta thread lifecycle event. */
export function threadEvent(
  action: "spawned" | "completed",
  model?: string,
): string {
  const detail = action === "spawned" && model ? ` (${model})` : "";
  return style(`  ↳ thread ${action}${detail}`, DIM, MAGENTA);
}

/** System message — dim for info, bold red for errors. */
export function systemMsg(text: string, isError?: boolean): string {
  return isError ? style(text, BOLD, RED) : style(text, DIM);
}
