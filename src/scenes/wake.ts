/**
 * Waking the session from a scene.
 *
 * Not a press but a wake() in a rule wakes the session, and before such a
 * rule runs the gate decides whether it may: the event must be the owner's,
 * or come from a chat where the owner holds Claude-on-tag with "Others too"
 * on, or from the session that set the scene up (update_scene act); someone
 * must be able to answer (a routine, or the relay with the right session);
 * and the limits must allow it — the scene's own, per hour, and the ones
 * every start shares (src/bot/triggers.ts), claimed in one statement. A
 * refusal means the rule does not run at all.
 *
 * Like a group's sessions of the day, a scene keeps two audiences apart:
 * the owner's wakes go to `session_id` (the session that set it up), third
 * parties' to `others_session_id`, so the session the user works in never
 * hears a third party. Through the relay when it is up and the session is
 * known; otherwise the owner's routine starts. Either way it is a start in
 * the chat's log, under a number of its own (negative: no message has it).
 */

import type { BotContext } from "../bot/context";
import { sceneEnvelope } from "../agents/envelopes";
import { activeProvider, reachable, route, startsPerHour } from "../agents/route";
import type { Delivery } from "../agents/types";
import { excerptOf, holderVoice } from "../bot/triggers";
import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { messageLink } from "../links";
import type { RelayOrigin, SceneRow } from "../store";
import type { Actor } from "./engine";

type WakeContext = Pick<BotContext, "api" | "store" | "bot" | "config">;

/** Who stands behind an event, where it is not a person in Telegram: a session of the owner's. */
export interface WakeSource {
  /** The calling session (update_scene act), by its own word; null when it named none. */
  session: string | null;
  /** What the bot's records say stands behind that session. */
  origin: RelayOrigin;
}

export type WakeGate =
  | { ok: true; fireId: number; byOther: boolean; source?: WakeSource }
  | { ok: false; answer: "not_for_you" | "nobody" | "resting" | "session"; minutes?: number };

const HOUR = 3600;

/** Minutes until a count that started at `oldest` lets one more through. */
function minutesLeft(oldest: number | null, now: number): number {
  return oldest === null ? 60 : Math.max(1, Math.ceil((oldest + HOUR - now) / 60));
}

/** The session a wake goes to: the owner's own, or the one for third parties. */
function targetOf(scene: SceneRow, byOther: boolean): string | null {
  return byOther ? scene.others_session_id : scene.session_id;
}

export async function gateWake(
  ctx: WakeContext,
  scene: SceneRow,
  actor: Actor,
  source?: WakeSource,
): Promise<WakeGate> {
  // A session acting through update_scene may wake only itself: the scene's own session.
  if (source && (!source.session || source.session !== scene.session_id)) {
    return { ok: false, answer: "session" };
  }
  const byOther = source ? source.origin !== "user" : actor.id !== scene.owner;
  const claim = await ctx.store.getClaudeChat(scene.chat_id);
  const othersAllowed = claim?.user_id === scene.owner && claim.others === 1;
  if (!source && byOther && !othersAllowed) return { ok: false, answer: "not_for_you" };

  if (!isAllowed(ctx.config, scene.owner)) return { ok: false, answer: "nobody" };
  if ((await reachable(ctx, scene.owner, targetOf(scene, byOther && !source))) !== true) {
    return { ok: false, answer: "nobody" };
  }

  const now = nowSeconds();
  const fireId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const entry = {
    chatId: scene.chat_id,
    messageId: fireId,
    userId: scene.owner,
    // A session's act is no member's: it counts against the user's starts, not the chat's others'.
    byOther: byOther && !source,
    fromName: actor.name,
    excerpt: excerptOf(scene.title, ctx.bot),
    album: null,
    sceneId: scene.id,
  };
  // The scene's limit is counted in the same statement that claims the start: wakes at once cannot all pass.
  const claimed = await ctx.store.beginFire(entry, {
    user: startsPerHour(await activeProvider(ctx, scene.owner)),
    others: claim?.others_limit ?? 0,
    scene: scene.wake_limit,
  });
  if (claimed !== "claimed") {
    const minutes = await restingMinutes(ctx, scene, byOther, now);
    // As with tags: the holder hears once an hour that wakes are held back.
    if (await ctx.store.noteLimited(entry)) {
      const chat = await ctx.store.getChat(scene.chat_id);
      const { tell, where, t } = await holderVoice(
        ctx,
        scene.owner,
        scene.chat_id,
        chat?.title ?? null,
      );
      await tell(where + t.sceneWakesLimited(scene.title, minutes));
    }
    return { ok: false, answer: "resting", minutes };
  }
  return { ok: true, fireId, byOther, ...(source ? { source } : {}) };
}

/** Which limit held the wake back, and when it lets one through again. */
async function restingMinutes(
  ctx: WakeContext,
  scene: SceneRow,
  byOther: boolean,
  now: number,
): Promise<number> {
  const since = now - HOUR;
  const own = await ctx.store.sceneWakes(scene.owner, scene.id, since);
  if (own.n >= scene.wake_limit) return minutesLeft(own.oldest, now);
  if (byOther) {
    const claim = await ctx.store.getClaudeChat(scene.chat_id);
    const oldest = await ctx.store.oldestOthersStart(scene.owner, scene.chat_id, since);
    if (claim && oldest !== null) return minutesLeft(oldest, now);
  }
  return minutesLeft(await ctx.store.oldestStart(scene.owner, since), now);
}

/** A gate passed, but the rule did not wake after all: the claimed start is let go. */
export async function releaseWake(
  ctx: WakeContext,
  scene: SceneRow,
  gate: WakeGate & { ok: true },
): Promise<void> {
  await ctx.store.dropFire(scene.chat_id, gate.fireId);
}

export async function deliverWake(
  ctx: WakeContext,
  scene: SceneRow,
  gate: WakeGate & { ok: true },
  event: { seq: number; name: string; actor: Actor },
): Promise<void> {
  const others = gate.byOther && !gate.source;
  const target = gate.source ? scene.session_id : targetOf(scene, others);
  const by = gate.source ? "session" : gate.byOther ? "other" : "user";
  const into: Delivery | null = target
    ? {
        session: target,
        job: {
          origin: gate.source ? gate.source.origin : gate.byOther ? "other" : "user",
          from_session: gate.source?.session ?? null,
          // A scene's job: the scene, the event's number, and the start it was claimed as.
          chat_id: scene.id,
          message_id: event.seq,
          thread_id: gate.fireId,
          wants_answer: 0,
          kind: "scene",
        },
        envelope: async () => {
          const owner = await ctx.store.getUser(scene.owner);
          const chat = await ctx.store.getChat(scene.chat_id);
          const main = (JSON.parse(scene.messages) as { id: number }[])[0]?.id;
          const link = main
            ? messageLink(
                {
                  type: scene.chat_id > 0 ? "private" : (chat?.type ?? "supergroup"),
                  chat_id: scene.chat_id,
                  username: chat?.username ?? null,
                },
                main,
                scene.thread_id,
                ctx.bot.username,
              )
            : null;
          return sceneEnvelope({
            user: {
              id: scene.owner,
              username: owner?.username ?? null,
              name: owner?.first_name ?? null,
            },
            scene: { id: scene.id, title: scene.title, brief: scene.brief },
            event: event.name,
            seq: event.seq,
            chat: { id: scene.chat_id, title: chat?.title ?? null },
            messageLink: link,
            sender: event.actor,
            by,
            ownSession: !others,
          });
        },
      }
    : null;
  await wake(ctx, scene, event.seq, by, gate.fireId, into);
}

/**
 * Route a scene's wake claimed as start `fireId`: into the session it belongs
 * to (`into`), else a new session of the owner's, which takes that audience's
 * wakes from then on. When nothing starts the owner hears why, at most once an
 * hour for others'. The start's row in the log says how it went.
 */
async function wake(
  ctx: WakeContext,
  scene: SceneRow,
  seq: number,
  by: "user" | "other" | "session",
  fireId: number,
  into?: Delivery | null,
): Promise<void> {
  const routed = await route(ctx, {
    holder: scene.owner,
    into,
    start: { kind: "scene", scene: scene.id, seq, by },
  });
  if (routed.via === "delivered") {
    await ctx.store.endFire(scene.chat_id, fireId, {
      status: "relayed",
      sessionId: routed.session,
    });
    return;
  }
  if (routed.via === "started") {
    // A session's own act keeps its session; the others' wakes never take the owner's.
    if (by !== "session") await ctx.store.setSceneSession(scene.id, routed.session, by === "other");
    await ctx.store.endFire(scene.chat_id, fireId, {
      status: "started",
      sessionId: routed.session,
    });
    return;
  }
  const quiet =
    by === "other" &&
    (await ctx.store.othersFailedSince(scene.owner, scene.chat_id, nowSeconds() - HOUR));
  await ctx.store.endFire(scene.chat_id, fireId, { status: "failed" });
  if (routed.via === "unreachable") return;
  if (routed.reason !== "none" && routed.reason !== "broken") {
    console.error(
      JSON.stringify({ event: "scene_wake_failed", user: scene.owner, detail: routed.detail }),
    );
  }
  if (!quiet) {
    const chat = await ctx.store.getChat(scene.chat_id);
    const { tell, where, t } = await holderVoice(
      ctx,
      scene.owner,
      scene.chat_id,
      chat?.title ?? null,
    );
    const minutes = routed.retryAfter ? Math.ceil(routed.retryAfter / 60) : undefined;
    await tell(
      where +
        (routed.via === "undelivered"
          ? t.deliverFailed(routed.reason, minutes)
          : t.fireFailed(routed.reason, minutes, routed.provider)),
    );
  }
}

/**
 * A scene's wake the relay could not pass on: the routine starts instead,
 * unless the scene is gone or its owner may no longer use the bot. The
 * start's row in the log says how it went.
 */
export async function wakeFallback(
  ctx: WakeContext,
  job: {
    chat_id: number | null;
    message_id: number | null;
    thread_id: number | null;
    origin: RelayOrigin;
    from_session: string | null;
  },
): Promise<void> {
  if (job.chat_id === null || job.message_id === null) return;
  const scene = await ctx.store.getScene(job.chat_id);
  const fireId = job.thread_id;
  if (!scene || fireId === null) return;
  if (scene.status !== "active" || !isAllowed(ctx.config, scene.owner)) {
    await ctx.store.endFire(scene.chat_id, fireId, { status: "failed" });
    return;
  }
  const by = job.from_session ? "session" : job.origin === "user" ? "user" : "other";
  await wake(ctx, scene, job.message_id, by, fireId);
}
