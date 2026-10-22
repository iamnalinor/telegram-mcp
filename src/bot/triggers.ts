/**
 * Starting the user's routine from Telegram.
 *
 * In a chat where Claude answers (see `claude_chats`), a message starts a
 * cloud session when it calls on the bot: `/run …` (private chat only), a mention, or a reply
 * to a message the bot sent for the chat's holder. A mention in the private
 * chat must be spelled out — everything there is "for the bot".
 *
 * Nothing starts for a forward, a message via an inline bot or posted as the
 * chat, or a reply that a waiting session (ask_user, wait_for_reply) is about
 * to take. Other members' messages start it only where the holder allowed
 * them, a few times an hour. Failures go to the holder's private chat, never
 * into the chat itself.
 */

import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { fire, firePayload, loadRoutine } from "../routine";
import { redactSecrets } from "../secrets";
import { BOT_ACCOUNT } from "../store";
import { TelegramError } from "../telegram/api";
import { displayName, isMember, type ChatMember, type Message } from "../telegram/types";
import type { BotContext } from "./context";
import { realReply, tagsBot, type Command } from "./extract";
import { escapeHtml, texts } from "./texts";

/** A reply this long after a wait ended is a new task, not the answer. */
const AWAIT_GRACE = 60;
/** Starts in all, per user per hour: Anthropic allows a routine about 30. */
const USER_PER_HOUR = 30;

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
  if (!from || from.is_bot) return;
  if (message.forward_origin || message.via_bot || message.sender_chat) return;
  const chat = message.chat;
  // /run is for the private chat; in groups, commands start nothing — a mention does.
  if (command && (command.name !== "run" || chat.type !== "private")) return;
  if (chat.type !== "private" && chat.type !== "group" && chat.type !== "supergroup") return;
  // Most messages call on nobody: they cost no read.
  const target = realReply(message);
  if (!command && !tagsBot(message, ctx.bot) && target?.from?.id !== ctx.bot.id) return;

  const claim = await ctx.store.getClaudeChat(chat.id);
  if (!claim || !isAllowed(ctx.config, claim.user_id)) return;
  const holder = claim.user_id;
  const byOther = from.id !== holder;
  if (byOther && (chat.type === "private" || !claim.others)) return;

  // A reply counts when it answers what the bot sent for the holder.
  const answered =
    target?.from?.id === ctx.bot.id
      ? await ctx.store.getMessage({ account_id: BOT_ACCOUNT, chat_id: chat.id }, target.message_id)
      : null;
  const replyToHolder = answered?.outgoing === true && answered.sent_by === holder;
  if (!command && !tagsBot(message, ctx.bot) && !replyToHolder) return;

  const t = texts(from.language_code);
  if (command && !command.args && !replyToHolder && chat.type === "private") {
    await ctx.api
      .call("sendMessage", { chat_id: chat.id, text: t.claudeHelp, ...silent })
      .catch(() => undefined);
    return;
  }

  // The session that sent it is listening: the answer is its to take.
  const now = nowSeconds();
  if (replyToHolder && answered.awaited_until && now <= answered.awaited_until + AWAIT_GRACE)
    return;
  if (chat.type === "private" && (await ctx.store.awaitedIn(chat.id, now - AWAIT_GRACE))) return;

  const owner = (await ctx.store.getUser(holder)) ?? null;
  const ot = texts(owner?.language ?? from.language_code);
  const tell = (text: string, replyTo?: number) =>
    ctx.api
      .call("sendMessage", {
        chat_id: holder,
        text,
        ...silent,
        ...(replyTo
          ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
          : {}),
      })
      .catch(() => undefined);
  const where = chat.type === "private" ? "" : `${ot.inChat(chat.title ?? String(chat.id))} `;

  // Others' failures reach the holder once an hour per chat: a broken routine
  // must not turn every member's message into a notice.
  const quiet = byOther && (await ctx.store.othersFailedSince(holder, chat.id, now - 3600));
  const claimed = await ctx.store.beginFire(
    { chatId: chat.id, messageId: message.message_id, userId: holder, byOther },
    { user: USER_PER_HOUR, others: claim.others_limit },
  );
  if (claimed === "again") return;
  if (claimed === "limit") {
    if (!byOther) {
      await tell(where + ot.tooManyStarts);
      return;
    }
    // Not silence: the sender sees the bot is resting, and the holder hears once an hour.
    await react(ctx, chat.id, message.message_id, "😴");
    if (await ctx.store.noteLimited(chat.id, message.message_id, holder)) {
      await tell(where + ot.othersLimited(claim.others_limit));
    }
    return;
  }

  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, holder);
  if (typeof routine === "string") {
    await ctx.store.endFire(chat.id, message.message_id, { status: "failed" });
    if (!quiet) await tell(where + ot.fireFailed(routine));
    return;
  }

  const result = await fire(
    routine.triggerId,
    routine.token,
    firePayload({
      chat: chat.id,
      topic: message.is_topic_message ? (message.message_thread_id ?? null) : null,
      message: message.message_id,
      by: byOther ? "other" : "user",
      continues: replyToHolder ? answered.session_id : null,
    }),
  );
  if (!result.ok) {
    await ctx.store.endFire(chat.id, message.message_id, { status: "failed" });
    console.error(
      JSON.stringify({ event: "routine_fire_failed", user: holder, detail: result.detail }),
    );
    const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
    if (!quiet) await tell(where + ot.fireFailed(result.reason, minutes));
    return;
  }
  await ctx.store.endFire(chat.id, message.message_id, {
    status: "started",
    sessionId: result.sessionId,
  });
  await react(ctx, chat.id, message.message_id, "👀");

  // The holder's own starts need no notice: 👀 says it, and the session answers there.
  if (!byOther) return;
  const excerpt = Array.from(redactSecrets(message.text ?? message.caption ?? ""))
    .slice(0, 200)
    .join("");
  await tell(
    ot.startedIn({
      chat: chat.title ?? String(chat.id),
      who: displayName(from),
      text: excerpt,
      url: result.sessionUrl,
    }),
  );
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
