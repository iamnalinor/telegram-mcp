/**
 * What becomes of a job the relay (src/relay.ts) could not pass on: it goes
 * the way it would have without a relay — a new session, told why, through
 * the same routing as everything else (src/agents/route.ts). A Codex start
 * that did not go through is not tried elsewhere, nor is a message its thread
 * took and failed on: the user hears of it.
 */

import { codexStartFailed } from "../agents/codex";
import { wakeFallback } from "../scenes/wake";
import { BOT_ACCOUNT, isGuestKey, type GuestReply, type RelayJob } from "../store";
import type { BotContext } from "./context";
import { startGuest } from "./guest";
import { texts } from "./texts";
import { holderVoice, launch } from "./triggers";

/**
 * A Telegram reply the relay could not pass on starts a session after all,
 * told why, so it can say so to whoever wrote.
 */
export async function fallBack(
  ctx: BotContext,
  job: RelayJob,
  why: "login" | "offline" | "failed",
): Promise<void> {
  // A start, or a message for a thread its start never made: what waited on it fails too.
  if (
    job.runner === "codex-start" ||
    (job.runner === "codex-resume" &&
      !(await ctx.store.getAgentSession(job.user_id, job.target_session))?.external_id)
  ) {
    const { tell, error } = await codexStartFailed(ctx.store, job);
    if (!tell) return;
    const t = texts((await ctx.store.getUser(job.user_id))?.language);
    await ctx.api
      .call("sendMessage", {
        chat_id: job.user_id,
        text: t.codexStartFailed(error),
        parse_mode: "HTML",
      })
      .catch(() => undefined);
    return;
  }
  // The thread is there and the relay ran the message, which failed: a new session would not know
  // what this one did, and could fail the same way. Only one that never ran it starts afresh.
  if (job.runner === "codex-resume" && why === "failed") {
    await codexResumeFailed(ctx, job);
    return;
  }
  if (job.chat_id === null || job.message_id === null) return;
  if (job.kind === "scene") {
    // The session the scene knew is out of reach: a new one reads the scene.
    await wakeFallback(ctx, job);
    return;
  }
  if (job.kind === "day") {
    // One new session for the day, not one per message queued behind this one.
    for (const later of await ctx.store.foldDayJobs(job.user_id, job.target_session)) {
      if (later.chat_id !== null && later.message_id !== null) {
        await ctx.store.endFire(later.chat_id, later.message_id, { status: "joined" });
      }
    }
  }
  if (job.kind === "guest") {
    // A call that answered the bot's own message there carries on from that session.
    const call = await ctx.store.getGuestCall(job.user_id, job.message_id);
    let toOwn: boolean;
    try {
      toOwn = call?.reply ? (JSON.parse(call.reply) as GuestReply).own : false;
    } catch {
      toOwn = false;
    }
    await startGuest(ctx, job.user_id, job.message_id, toOwn ? job.target_session : null);
    return;
  }
  const chat = await ctx.store.getChat(job.chat_id);
  // The agent whose message a reply answers is on that message, not on the job.
  const scope = { account_id: BOT_ACCOUNT, chat_id: job.chat_id };
  const replied =
    job.kind === "reply" ? (await ctx.store.getMessage(scope, job.message_id))?.reply_to_id : null;
  const agent = replied ? ((await ctx.store.getMessage(scope, replied))?.agent ?? null) : null;
  await launch(ctx, {
    holder: job.user_id,
    chat: { id: job.chat_id, title: chat?.title ?? null, private: job.chat_id > 0 },
    messageId: job.message_id,
    topic: job.thread_id,
    byOther: job.origin !== "user",
    // A day's message never named that session: the new one starts afresh.
    continues: job.kind === "reply" ? job.target_session : null,
    agent,
    relay: job.kind === "reply" ? why : null,
  });
}

/** A message a Codex thread took and failed on: its start in the log fails, and the holder hears. */
async function codexResumeFailed(ctx: BotContext, job: RelayJob): Promise<void> {
  // Another session's ask: that session hears of it when it waits for the answer.
  if (job.chat_id === null || job.message_id === null || job.kind === "ask") return;
  let chat = job.chat_id;
  let fire = job.message_id;
  if (job.kind === "scene") {
    // A scene's job names the scene and the start it was claimed as.
    const scene = await ctx.store.getScene(job.chat_id);
    if (!scene || job.thread_id === null) return;
    chat = scene.chat_id;
    fire = job.thread_id;
  }
  await ctx.store.endFire(chat, fire, { status: "failed" });
  const title = isGuestKey(chat)
    ? ((await ctx.store.guestChatByKey(chat))?.title ?? null)
    : chat < 0
      ? ((await ctx.store.getChat(chat))?.title ?? null)
      : null;
  const { tell, where, t } = await holderVoice(ctx, job.user_id, chat, title);
  await tell(where + t.codexDeliverFailed(job.target_session, job.error ?? "unknown error"));
}
