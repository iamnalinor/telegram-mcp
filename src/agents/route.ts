/**
 * Where something for the user's assistant goes: into the session it belongs
 * to, through the provider that made that session, or — when that cannot
 * take it — to a new session of the holder's provider, told why.
 *
 * Callers keep their own books (the start's row in the log, reactions, who
 * hears of a failure); this only decides and passes it on.
 */

import { claude } from "./claude";
import { openai } from "./openai";
import {
  providerOf,
  type AgentContext,
  type Delivery,
  type Provider,
  type ProviderKind,
  type Reach,
  type StartFailure,
  type StartRequest,
} from "./types";

const PROVIDERS: Partial<Record<ProviderKind, Provider>> = { claude, openai };

/** The provider the holder's new sessions start with: the one they chose, Claude by default. */
export async function activeProvider(
  ctx: Pick<AgentContext, "store">,
  holder: number,
): Promise<Provider> {
  const chosen = (await ctx.store.getUser(holder))?.active_provider;
  return (chosen && PROVIDERS[chosen as ProviderKind]) || claude;
}

export interface Intent {
  holder: number;
  /** The session it belongs to and how it is passed on there, if one is known. */
  into?: Delivery | null;
  /** Otherwise a new session starts on it; absent: nothing starts. */
  start?: StartRequest;
}

export type Routed =
  | { via: "delivered"; session: string; ask: string }
  | { via: "started"; session: string; url: string | null }
  | {
      via: "failed";
      reason: StartFailure;
      retryAfter?: number;
      detail: string;
      provider: ProviderKind;
    }
  | { via: "unreachable"; reach: Reach };

export async function route(ctx: AgentContext, intent: Intent): Promise<Routed> {
  let reach: Reach | null = null;
  if (intent.into) {
    const provider = PROVIDERS[providerOf(intent.into.session)];
    const delivered = provider
      ? await provider.deliver(ctx, intent.holder, intent.into)
      : ({ ok: false, reach: "none" } as const);
    if (delivered.ok) return { via: "delivered", session: intent.into.session, ask: delivered.ask };
    reach = delivered.reach;
  }
  if (!intent.start) return { via: "unreachable", reach: reach ?? "none" };
  let request = intent.start;
  // A reply that should have gone into its session: the new one says why it did not.
  if (
    request.kind === "message" &&
    request.continues &&
    !request.relay &&
    (reach === "login" || reach === "offline")
  ) {
    request = { ...request, relay: reach };
  }
  const provider = await activeProvider(ctx, intent.holder);
  const result = await provider.start(ctx, intent.holder, request);
  return result.ok
    ? { via: "started", session: result.sessionId, url: result.sessionUrl }
    : {
        via: "failed",
        reason: result.reason,
        ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
        detail: result.detail,
        provider: provider.kind,
      };
}

/**
 * Whether something for `session` would get anywhere — passed into it, or a
 * new session started — and when not, why nothing starts.
 */
export async function reachable(
  ctx: AgentContext,
  holder: number,
  session: string | null,
): Promise<true | "none" | "broken"> {
  const active = await activeProvider(ctx, holder);
  const status = await active.status(ctx, holder);
  const own = session ? PROVIDERS[providerOf(session)] : undefined;
  if (own) {
    const reach = own === active ? status.reach : (await own.status(ctx, holder)).reach;
    if (reach === "online") return true;
  }
  return status.start === "set" ? true : status.start;
}
