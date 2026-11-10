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
import { excerptOf, holderVoice, USER_PER_HOUR } from "../bot/triggers";
import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { messageLink } from "../links";
import { enqueue, relayState, sceneEnvelope } from "../relay";
import { fire, loadRoutine, scenePayload } from "../routine";
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
  const relay = relayState(await ctx.store.getRelay(scene.owner));
  const reachable = relay === "online" && targetOf(scene, byOther && !source) !== null;
  if (
    !reachable &&
    typeof (await loadRoutine(ctx.store, ctx.config.secretKey, scene.owner)) === "string"
  ) {
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
    user: USER_PER_HOUR,
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
  const relay = relayState(await ctx.store.getRelay(scene.owner));
  if (relay === "online" && target) {
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
    await enqueue(
      ctx.store,
      {
        user_id: scene.owner,
        target_session: target,
        origin: gate.source ? gate.source.origin : gate.byOther ? "other" : "user",
        from_session: gate.source?.session ?? null,
        // A scene's job: the scene, the event's number, and the start it was claimed as.
        chat_id: scene.id,
        message_id: event.seq,
        thread_id: gate.fireId,
        wants_answer: 0,
        kind: "scene",
      },
      () =>
        sceneEnvelope({
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
          by: gate.source ? "session" : gate.byOther ? "other" : "user",
          ownSession: !others,
        }),
    );
    await ctx.store.endFire(scene.chat_id, gate.fireId, { status: "relayed", sessionId: target });
    return;
  }
  const by = gate.source ? "session" : gate.byOther ? "other" : "user";
  const started = await wakeByRoutine(ctx, scene.id, event.seq, by);
  await ctx.store.endFire(
    scene.chat_id,
    gate.fireId,
    started ? { status: "started", sessionId: started } : { status: "failed" },
  );
}

/**
 * Start the owner's routine on a scene's wake; the new session's id, or null
 * when nothing started (the owner hears why, at most once an hour for others').
 * The new session takes that audience's wakes from then on.
 */
async function wakeByRoutine(
  ctx: WakeContext,
  sceneId: number,
  seq: number,
  by: "user" | "other" | "session",
): Promise<string | null> {
  const scene = await ctx.store.getScene(sceneId);
  if (!scene || !isAllowed(ctx.config, scene.owner)) return null;
  const chat = await ctx.store.getChat(scene.chat_id);
  const { tell, where, t } = await holderVoice(
    ctx,
    scene.owner,
    scene.chat_id,
    chat?.title ?? null,
  );
  const quiet =
    by === "other" &&
    (await ctx.store.othersFailedSince(scene.owner, scene.chat_id, nowSeconds() - HOUR));
  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, scene.owner);
  if (typeof routine === "string") {
    if (!quiet) await tell(where + t.fireFailed(routine));
    return null;
  }
  const result = await fire(routine.triggerId, routine.token, scenePayload(scene.id, seq, by));
  if (!result.ok) {
    console.error(
      JSON.stringify({ event: "scene_wake_failed", user: scene.owner, detail: result.detail }),
    );
    const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
    if (!quiet) await tell(where + t.fireFailed(result.reason, minutes));
    return null;
  }
  // A session's own act keeps its session; the others' wakes never take the owner's.
  if (by !== "session") await ctx.store.setSceneSession(scene.id, result.sessionId, by === "other");
  return result.sessionId;
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
  const end = async (outcome: Parameters<WakeContext["store"]["endFire"]>[2]) => {
    if (scene && fireId !== null) await ctx.store.endFire(scene.chat_id, fireId, outcome);
  };
  if (!scene || scene.status !== "active" || !isAllowed(ctx.config, scene.owner)) {
    await end({ status: "failed" });
    return;
  }
  const by = job.from_session ? "session" : job.origin === "user" ? "user" : "other";
  const started = await wakeByRoutine(ctx, scene.id, job.message_id, by);
  await end(started ? { status: "started", sessionId: started } : { status: "failed" });
}
