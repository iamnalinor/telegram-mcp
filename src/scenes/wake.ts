/**
 * Waking the session from a scene.
 *
 * Not a press but a wake() in a rule wakes the session, and before such a
 * rule runs the gate decides whether it may: the event must be the owner's,
 * or come from a chat where the owner let others start Claude ("Others too");
 * someone must be able to answer (a routine, or the relay with the scene's
 * session); and the limits must allow it — the scene's own, per hour, and
 * the ones every start shares (src/bot/triggers.ts). A refusal means the rule
 * does not run at all.
 *
 * A wake goes to the session that set the scene up when the relay can reach
 * it; otherwise it starts the owner's routine. Either way it is a start in
 * the chat's log, under a number of its own (negative: no message has it).
 */

import type { BotContext } from "../bot/context";
import { excerptOf, holderVoice, USER_PER_HOUR } from "../bot/triggers";
import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { messageLink } from "../links";
import { enqueue, relayState, sceneEnvelope } from "../relay";
import { fire, loadRoutine, scenePayload } from "../routine";
import type { SceneRow } from "../store";
import type { Actor } from "./engine";

type WakeContext = Pick<BotContext, "api" | "store" | "bot" | "config">;

export type WakeGate =
  | { ok: true; fireId: number; byOther: boolean }
  | { ok: false; answer: "not_for_you" | "nobody" | "resting"; minutes?: number };

const HOUR = 3600;

/** Minutes until a count that started at `oldest` lets one more through. */
function minutesLeft(oldest: number | null, now: number): number {
  return oldest === null ? 60 : Math.max(1, Math.ceil((oldest + HOUR - now) / 60));
}

export async function gateWake(ctx: WakeContext, scene: SceneRow, actor: Actor): Promise<WakeGate> {
  const byOther = actor.id !== scene.owner;
  const claim = await ctx.store.getClaudeChat(scene.chat_id);
  if (byOther && !(claim?.user_id === scene.owner && claim.others === 1)) {
    return { ok: false, answer: "not_for_you" };
  }

  if (!isAllowed(ctx.config, scene.owner)) return { ok: false, answer: "nobody" };
  const relay = relayState(await ctx.store.getRelay(scene.owner));
  const reachable = relay === "online" && scene.session_id !== null;
  if (
    !reachable &&
    typeof (await loadRoutine(ctx.store, ctx.config.secretKey, scene.owner)) === "string"
  ) {
    return { ok: false, answer: "nobody" };
  }

  const now = nowSeconds();
  const wakes = await ctx.store.sceneWakes(scene.id, now - HOUR);
  if (wakes.n >= scene.wake_limit) {
    return { ok: false, answer: "resting", minutes: minutesLeft(wakes.oldest, now) };
  }
  const fireId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const claimed = await ctx.store.beginFire(
    {
      chatId: scene.chat_id,
      messageId: fireId,
      userId: scene.owner,
      byOther,
      fromName: actor.name,
      excerpt: excerptOf(scene.title, ctx.bot),
      album: null,
    },
    { user: USER_PER_HOUR, others: claim?.others_limit ?? 0 },
  );
  if (claimed !== "claimed") {
    const oldest = await ctx.store.oldestStart(scene.owner, now - HOUR);
    return { ok: false, answer: "resting", minutes: minutesLeft(oldest, now) };
  }
  return { ok: true, fireId, byOther };
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
  const relay = relayState(await ctx.store.getRelay(scene.owner));
  if (relay === "online" && scene.session_id) {
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
    const session = scene.session_id;
    await enqueue(
      ctx.store,
      {
        user_id: scene.owner,
        target_session: session,
        origin: gate.byOther ? "other" : "user",
        from_session: null,
        chat_id: scene.id,
        message_id: event.seq,
        thread_id: null,
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
          byUser: !gate.byOther,
        }),
    );
    await ctx.store.endFire(scene.chat_id, gate.fireId, { status: "relayed", sessionId: session });
    return;
  }
  const started = await wakeByRoutine(ctx, scene.id, event.seq, gate.byOther ? "other" : "user");
  await ctx.store.endFire(
    scene.chat_id,
    gate.fireId,
    started ? { status: "started", sessionId: started } : { status: "failed" },
  );
}

/**
 * Start the owner's routine on a scene's wake; the new session's id, or null
 * when nothing started (the owner hears why, at most once an hour for others').
 */
export async function wakeByRoutine(
  ctx: WakeContext,
  sceneId: number,
  seq: number,
  by: "user" | "other",
): Promise<string | null> {
  const scene = await ctx.store.getScene(sceneId);
  if (!scene) return null;
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
  // Later wakes reach this session through the relay, when it is up.
  await ctx.store.setSceneSession(scene.id, result.sessionId);
  return result.sessionId;
}
