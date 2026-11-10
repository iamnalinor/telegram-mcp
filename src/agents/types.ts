/**
 * Who answers for the user: a provider of assistant sessions. The bot starts
 * sessions with the holder's provider and passes messages into existing ones
 * through the provider that made them, told apart by the session id.
 *
 * Claude (src/agents/claude.ts): its routine starts sessions, its relay passes
 * messages on. OpenAI (src/agents/openai.ts): the Worker runs Agents API
 * sessions itself, under ids it gives them.
 */

import type { RelayJob, Store } from "../store";
import type { Config } from "../env";

export type ProviderKind = "claude" | "openai" | "codex";

/** `cse_…` (the environment) and `session_…` (links, get_session) name the same Claude session. */
const CLAUDE_ID = /^(?:session|cse)_([0-9A-Za-z]{16,64})$/;
/** The same, inside a claude.ai/code link too. */
const CLAUDE_IN = /(?:^|\/)(?:session|cse)_([0-9A-Za-z]{16,64})(?:[/?#]|$)/;
/** Ids the Worker gives the sessions it runs: `oa_…` (OpenAI), `cx_…` (Codex). */
const WORKER_ID = /^(?:oa|cx)_[0-9a-f]{24}$/;

/** One spelling in storage: session_…, as in claude.ai/code links, or the Worker's id. Anything else is null. */
export function sessionId(value: string | undefined): string | null {
  if (value && WORKER_ID.test(value)) return value;
  const match = value ? CLAUDE_ID.exec(value) : null;
  return match ? `session_${match[1]}` : null;
}

/** One spelling of the session, from an id or a link; null if neither. */
export function parseSession(value: string): string | null {
  const trimmed = value.trim();
  if (WORKER_ID.test(trimmed)) return trimmed;
  const match = CLAUDE_IN.exec(trimmed);
  return match ? `session_${match[1]}` : null;
}

/** The provider that made a session, by its id. */
export function providerOf(id: string): ProviderKind {
  if (id.startsWith("oa_")) return "openai";
  if (id.startsWith("cx_")) return "codex";
  return "claude";
}

/** Where the user can open a session; null when it has no page of its own. */
export function sessionLink(id: string): string | null {
  return providerOf(id) === "claude" ? `https://claude.ai/code/${id}` : null;
}

/** What a provider needs from the bot. */
export type AgentContext = { store: Store; config: Config };

/** Why a message cannot reach an existing session now; "online" when it can. */
export type Reach = "online" | "none" | "offline" | "login";

interface ProviderStatus {
  /** Whether a new session can be started: set up, not set up, or set up but unreadable. */
  start: "set" | "none" | "broken";
  /** Whether messages reach the sessions it made. */
  reach: Reach;
}

/** What a new session is started on; each provider words it for its own sessions. */
export type StartRequest =
  | {
      kind: "message";
      chat: number;
      topic: number | null;
      message: number;
      by: "user" | "other";
      /** The session whose message this replies to. */
      continues: string | null;
      /** The subagent of that session whose message this replies to. */
      agent: string | null;
      /** Why the reply did not go to the session it answers. */
      relay: "login" | "offline" | "failed" | null;
    }
  | { kind: "guest"; call: number; by: "user" | "other"; continues: string | null }
  | { kind: "scene"; scene: number; seq: number; by: "user" | "other" | "session" }
  /** A start from the bot's menu, to check the setup: it answers "ok" in the private chat. */
  | { kind: "test"; chat: number; message: number };

export type StartFailure =
  "none" | "broken" | "token" | "missing" | "paused" | "limit" | "quota" | "other";

/** Why a provider's API did not take something, and when to try again. */
export interface Failure {
  reason: StartFailure;
  retryAfter?: number;
  detail: string;
}

export type StartResult =
  { ok: true; sessionId: string; sessionUrl: string | null } | ({ ok: false } & Failure);

/** A message for an existing session; the envelope may name its ask, so it is made from the id. */
export interface Delivery {
  session: string;
  job: Pick<
    RelayJob,
    "origin" | "from_session" | "chat_id" | "message_id" | "thread_id" | "wants_answer" | "kind"
  >;
  envelope: (ask: string) => string | Promise<string>;
}

/**
 * Passed on; or the session cannot be reached (`reach`), and a new one may
 * take it; or it is there but the provider did not take it now (`failed`: a
 * rate limit, an outage), and nothing new starts — that would cost a session
 * and fail the same way.
 */
type Delivered =
  { ok: true; ask: string } | { ok: false; reach: Reach } | { ok: false; failed: Failure };

export interface Provider {
  readonly kind: ProviderKind;
  /** Starts per user per hour, all chats together. */
  readonly limits: { startsPerHour: number };
  status(ctx: AgentContext, holder: number): Promise<ProviderStatus>;
  start(ctx: AgentContext, holder: number, request: StartRequest): Promise<StartResult>;
  deliver(ctx: AgentContext, holder: number, delivery: Delivery): Promise<Delivered>;
  /** Where the user can open one of its sessions, if anywhere. */
  link(session: string): string | null;
}
