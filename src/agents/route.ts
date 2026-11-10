/**
 * Where something for the user's assistant goes: into the session it belongs
 * to, through the provider that made that session, or — when that cannot
 * take it — to a new session of the holder's provider, told why. A session
 * that is there but whose provider did not take it now (a rate limit, an
 * outage) is not replaced: the caller says it failed.
 *
 * Callers keep their own books (the start's row in the log, reactions, who
 * hears of a failure); this only decides and passes it on.
 */

import { claude } from "./claude";
import { codex } from "./codex";
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

const PROVIDERS: Record<ProviderKind, Provider> = { claude, codex, openai };

/** The provider the holder's new sessions start with: the one they chose; none until they choose. */
export async function activeProvider(
  ctx: Pick<AgentContext, "store">,
  holder: number,
): Promise<Provider | null> {
  const chosen = (await ctx.store.getUser(holder))?.active_provider;
  return chosen && Object.hasOwn(PROVIDERS, chosen) ? PROVIDERS[chosen as ProviderKind] : null;
}

/**
 * The holder's starts per hour: their provider's. With none chosen nothing
 * starts, and messages into sessions they have count against the lowest.
 */
export function startsPerHour(active: Provider | null): number {
  return (
    active?.limits.startsPerHour ??
    Math.min(...Object.values(PROVIDERS).map((provider) => provider.limits.startsPerHour))
  );
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
  /** Nothing started; `provider` null: none is chosen. */
  | {
      via: "failed";
      reason: StartFailure;
      retryAfter?: number;
      detail: string;
      provider: ProviderKind | null;
    }
  /** The session is there, but its provider did not take the message now; nothing started. */
  | {
      via: "undelivered";
      session: string;
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
    if ("failed" in delivered) {
      const { reason, retryAfter, detail } = delivered.failed;
      return {
        via: "undelivered",
        session: intent.into.session,
        reason,
        ...(retryAfter ? { retryAfter } : {}),
        detail,
        provider: providerOf(intent.into.session),
      };
    }
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
  if (!provider)
    return { via: "failed", reason: "none", detail: "no provider chosen", provider: null };
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
 * new session started — and when not, why: "none", nothing is set up that
 * could take it; "broken", the settings that would start a session can no
 * longer be read; "away", the session's provider is set up but cannot pass
 * it on now (the relay is offline, say) and nothing would start a new one.
 */
export async function reachable(
  ctx: AgentContext,
  holder: number,
  session: string | null,
): Promise<true | "none" | "broken" | "away"> {
  const active = await activeProvider(ctx, holder);
  const status = active ? await active.status(ctx, holder) : null;
  const own = session ? PROVIDERS[providerOf(session)] : undefined;
  let ownReach: Reach = "none";
  if (own) {
    ownReach = own === active && status ? status.reach : (await own.status(ctx, holder)).reach;
    if (ownReach === "online") return true;
  }
  if (status?.start === "set") return true;
  if (status?.start === "broken") return "broken";
  return ownReach === "none" ? "none" : "away";
}
