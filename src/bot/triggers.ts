/**
 * Starting the user's routine from Telegram.
 *
 * In a group where Claude answers (see `claude_chats`), a message calls on it
 * by mentioning the bot or replying to a message the bot sent for the chat's
 * holder; forwards and messages via inline bots call on nobody. In the
 * holder's private chat with the bot, every message does — forwards too —
 * except commands and an answer a waiting session (ask_user, wait_for_reply)
 * is about to take.
 *
 * Where it goes: a reply to a session's message goes back into that session,
 * and a chat's messages of the day (from 00:00 UTC) go to one session — when
 * the user's relay is online (src/agents/route.ts). A group has two such sessions:
 * the holder's own, and one for the other members, so the session the holder
 * works in never hears a third party. Otherwise each message starts a new
 * session; one right after a start in the private chat (a forward, then what
 * to do with it) joins it, as that session reads along.
 *
 * Other members' messages count only where the holder allowed them, a few
 * times an hour; a message posted as a channel or the chat is always someone
 * else's. Each start goes into the chat's log in the menu; failures go to the
 * holder's private chat, never into the chat itself.
 *
 * Scenes (src/scenes/wake.ts) keep the same promise: the owner's wakes go to
 * the session that made the scene, other members' to one of their own, and a
 * session a scene woke is no chat's session of the day.
 */

import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { messageLink } from "../links";
import { replyEnvelope } from "../agents/envelopes";
import { activeProvider, route } from "../agents/route";
import type { Delivery } from "../agents/types";
import { redactSecrets } from "../secrets";
import { BOT_ACCOUNT, isGuestKey } from "../store";
import { TelegramError } from "../telegram/api";
import { displayName, isMember, type ChatMember, type Message } from "../telegram/types";
import type { BotContext } from "./context";
import { bodyOf, hasContent, realReply, tagsBot, type BotIdentity, type Command } from "./extract";
import { escapeHtml, texts } from "./texts";

/** A reply this long after a wait ended is a new task, not the answer. */
const AWAIT_GRACE = 60;
/** How much of the message the log keeps. */
const EXCERPT_LENGTH = 20;
/** A private-chat message this soon after a start is read by that session. */
const BURST_SECONDS = 20;
const DAY = 86_400;

const silent = {
  parse_mode: "HTML",
  disable_notification: true,
  link_preview_options: { is_disabled: true },
};

export async function maybeStart(
  ctx: BotContext,
  message: Message,
  command: Command | null,
): Promise<void> {
  const from = message.from;
  // Posted as a channel or the chat, `from` is Telegram's stand-in bot: no person is known.
  const asChat = message.sender_chat;
  if (!from || (from.is_bot && !asChat) || command) return;
  const chat = message.chat;
  const isPrivate = chat.type === "private";
  if (!isPrivate && chat.type !== "group" && chat.type !== "supergroup") return;
  // In the private chat a forward is the user's own pick; in a group it calls on nobody.
  if (!isPrivate && (message.forward_origin || message.via_bot)) return;
  const target = realReply(message);
  // Most group messages call on nobody: they cost no read.
  if (
    isPrivate ? !hasContent(message) : !tagsBot(message, ctx.bot) && target?.from?.id !== ctx.bot.id
  )
    return;

  const claim = await ctx.store.getClaudeChat(chat.id);
  if (!claim || !isAllowed(ctx.config, claim.user_id)) return;
  const holder = claim.user_id;
  const byOther = asChat !== undefined || from.id !== holder;
  if (byOther && (chat.type === "private" || !claim.others)) return;

  // A reply counts when it answers what the bot sent for the holder.
  const answered =
    target?.from?.id === ctx.bot.id
      ? await ctx.store.getMessage({ account_id: BOT_ACCOUNT, chat_id: chat.id }, target.message_id)
      : null;
  const replyToHolder = answered?.outgoing === true && answered.sent_by === holder;
  if (!isPrivate && !tagsBot(message, ctx.bot) && !replyToHolder) return;
  // An answer to the bot's own prompt (the menu asking for the routine, say) is for the bot.
  if (isPrivate && target?.from?.id === ctx.bot.id && !replyToHolder) return;

  // The session that sent it is listening: the answer is its to take.
  const now = nowSeconds();
  if (replyToHolder && answered.awaited_until && now <= answered.awaited_until + AWAIT_GRACE)
    return;
  if (chat.type === "private" && (await ctx.store.awaitedIn(chat.id, now - AWAIT_GRACE))) return;

  const entry = {
    chatId: chat.id,
    messageId: message.message_id,
    userId: holder,
    byOther,
    fromName: asChat ? (asChat.title ?? null) : displayName(from),
    excerpt: excerptOf(bodyOf(message), ctx.bot),
    album: message.media_group_id ?? null,
  };
  const claimed = await ctx.store.beginFire(entry, {
    user: (await activeProvider(ctx, holder)).limits.startsPerHour,
    others: claim.others_limit,
  });
  if (claimed === "again") return;
  if (claimed === "limit") {
    // Not silence: the sender sees the bot is resting, and the holder hears once an hour.
    await react(ctx, chat.id, message.message_id, "😴");
    if (await ctx.store.noteLimited(entry)) {
      const { tell, where, t: ot } = await holderVoice(ctx, holder, chat.id, chat.title ?? null);
      await tell(where + (byOther ? ot.othersLimited(claim.others_limit) : ot.tooManyStarts));
    }
    return;
  }

  const topic = message.is_topic_message ? (message.message_thread_id ?? null) : null;
  const continues = replyToHolder ? answered.session_id : null;
  const agent = continues ? (answered?.agent ?? null) : null;

  // Where it goes: the session it replies to, else the chat's session of the day.
  let into: { session: string; kind: "reply" | "day" } | null = continues
    ? { session: continues, kind: "reply" }
    : null;
  if (!into) {
    // A session just started reads this along: a forward, then what to do with it.
    if (
      isPrivate &&
      (await ctx.store.recentStart(chat.id, message.message_id, now - BURST_SECONDS))
    ) {
      await ctx.store.endFire(chat.id, message.message_id, { status: "joined" });
      return;
    }
    const day = await ctx.store.latestSession(holder, [chat.id], now - (now % DAY), byOther);
    if (day) into = { session: day, kind: "day" };
  }

  await launch(ctx, {
    holder,
    chat: { id: chat.id, title: chat.title ?? null, private: isPrivate },
    messageId: message.message_id,
    topic,
    byOther,
    continues,
    agent,
    into: into && {
      session: into.session,
      job: {
        origin: byOther ? "other" : "user",
        from_session: null,
        chat_id: chat.id,
        message_id: message.message_id,
        thread_id: topic,
        wants_answer: 0,
        kind: into.kind,
      },
      envelope: async () => {
        const owner = await ctx.store.getUser(holder);
        return replyEnvelope({
          kind: into.kind,
          user: { id: holder, username: owner?.username ?? null, name: owner?.first_name ?? null },
          chat: { id: chat.id, title: chat.title ?? null },
          messageId: message.message_id,
          link: messageLink(
            { type: chat.type, chat_id: chat.id, username: chat.username ?? null },
            message.message_id,
            topic,
            ctx.bot.username,
          ),
          sender: asChat
            ? { id: null, name: asChat.title ?? null }
            : { id: from.id, name: displayName(from) },
          byUser: !byOther,
          agent,
        });
      },
    },
  });
}

/** Messages to the holder's private chat, in their language, naming the chat when it is a group. */
export async function holderVoice(
  ctx: Pick<BotContext, "store" | "api">,
  holder: number,
  chatId: number,
  title: string | null,
) {
  const owner = await ctx.store.getUser(holder);
  const t = texts(owner?.language);
  const tell = (text: string) =>
    ctx.api.call("sendMessage", { chat_id: holder, text, ...silent }).catch(() => undefined);
  const isPrivate = chatId > 0 && !isGuestKey(chatId);
  const where = isPrivate ? "" : `${t.inChat(title ?? String(chatId))} `;
  return { t, tell, where };
}

/**
 * Route a message already claimed in `fires`: into the session it belongs to
 * (`into`), else a new session of the holder's — the usual way, and the
 * fallback when the relay could not pass a reply on. `relay` tells the new
 * session why the reply did not reach the session it answers. A guest call
 * (`guest`: the chat is its key, the message id the call's id) goes the same
 * way; nothing can be reacted to there. False when it got nowhere.
 */
export async function launch(
  ctx: BotContext,
  p: {
    holder: number;
    chat: { id: number; title: string | null; private: boolean };
    messageId: number;
    topic: number | null;
    byOther: boolean;
    continues: string | null;
    agent?: string | null;
    relay?: "login" | "offline" | "failed" | null;
    guest?: boolean;
    into?: Delivery | null;
  },
): Promise<boolean> {
  const by = p.byOther ? "other" : "user";
  const routed = await route(ctx, {
    holder: p.holder,
    into: p.into,
    start: p.guest
      ? { kind: "guest", call: p.messageId, by, continues: p.continues }
      : {
          kind: "message",
          chat: p.chat.id,
          topic: p.topic,
          message: p.messageId,
          by,
          continues: p.continues,
          agent: p.agent ?? null,
          relay: p.relay ?? null,
        },
  });
  if (routed.via === "delivered") {
    // Passed on to a session that exists: no new start, so no 👀.
    await ctx.store.endFire(p.chat.id, p.messageId, {
      status: "relayed",
      sessionId: routed.session,
    });
    return true;
  }
  if (routed.via === "started") {
    await ctx.store.endFire(p.chat.id, p.messageId, {
      status: "started",
      sessionId: routed.session,
    });
    // No notice: 👀 says it started, and the chat's log in the menu has the session.
    if (!p.guest) await react(ctx, p.chat.id, p.messageId, "👀");
    return true;
  }
  // Others' failures reach the holder once an hour per chat: a broken routine
  // must not turn every member's message into a notice.
  const quiet =
    p.byOther && (await ctx.store.othersFailedSince(p.holder, p.chat.id, nowSeconds() - 3600));
  await ctx.store.endFire(p.chat.id, p.messageId, { status: "failed" });
  if (routed.via === "unreachable") return false;
  if (routed.reason !== "none" && routed.reason !== "broken") {
    console.error(
      JSON.stringify({ event: "routine_fire_failed", user: p.holder, detail: routed.detail }),
    );
  }
  if (!quiet) {
    const { tell, where, t } = await holderVoice(ctx, p.holder, p.chat.id, p.chat.title);
    const minutes = routed.retryAfter ? Math.ceil(routed.retryAfter / 60) : undefined;
    await tell(where + t.fireFailed(routed.reason, minutes, routed.provider));
  }
  return false;
}

/** The first words, without the mention that called the bot. */
export function excerptOf(text: string, bot: BotIdentity): string {
  const names = [bot.username, ...(bot.aliases ?? [])].join("|");
  const mention = new RegExp(`@(?:${names})\\b`, "gi");
  const chars = Array.from(redactSecrets(text).replace(mention, "").replace(/\s+/g, " ").trim());
  return chars.length > EXCERPT_LENGTH
    ? `${chars.slice(0, EXCERPT_LENGTH).join("")}…`
    : chars.join("");
}

function react(ctx: BotContext, chatId: number, messageId: number, emoji: string) {
  return ctx.api
    .call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    })
    .catch(() => undefined); // Reactions may be off in that chat.
}

/**
 * Whether a user is still in a group, by Telegram; null when Telegram could
 * not say. Used before a claim is taken over, and by the daily check.
 */
export async function stillMember(
  ctx: Pick<BotContext, "api">,
  chatId: number,
  userId: number,
): Promise<boolean | null> {
  try {
    return isMember(
      await ctx.api.call<ChatMember>("getChatMember", { chat_id: chatId, user_id: userId }),
    );
  } catch (error) {
    if (
      error instanceof TelegramError &&
      /user not found|PARTICIPANT_ID_INVALID/i.test(error.description)
    )
      return false;
    return null;
  }
}

/** For the menu: the holder's name, HTML-escaped. */
export async function holderName(ctx: BotContext, userId: number): Promise<string> {
  const row = await ctx.store.getUser(userId);
  return escapeHtml(row?.username ? `@${row.username}` : (row?.first_name ?? String(userId)));
}
