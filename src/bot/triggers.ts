/**
 * Starting the user's routine from Telegram.
 *
 * In a chat where Claude answers (see `claude_chats`), a message starts a
 * cloud session when it calls on the bot: `/claude …`, a mention, or a reply
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
/** Starts from other members, per chat per hour. */
const OTHERS_PER_HOUR = 5;
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
  if (command && command.name !== "claude") return;
  const chat = message.chat;
  if (chat.type !== "private" && chat.type !== "group" && chat.type !== "supergroup") return;

  const claim = await ctx.store.getClaudeChat(chat.id);
  if (!claim) return;
  const holder = claim.user_id;
  const byOther = from.id !== holder;
  if (byOther && (chat.type === "private" || !claim.others)) return;

  // A reply counts when it answers what the bot sent for the holder.
  const target = realReply(message);
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

  const counts = await ctx.store.fireCounts(holder, chat.id, now - 3600);
  if (byOther && counts.others >= OTHERS_PER_HOUR) return;
  if (counts.user >= USER_PER_HOUR) {
    if (!byOther) await tell(where + ot.tooManyStarts);
    return;
  }

  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, holder);
  if (typeof routine === "string") {
    if (!byOther || counts.othersFailed === 0) await tell(where + ot.fireFailed(routine));
    return;
  }
  if (!(await ctx.store.beginFire(chat.id, message.message_id, holder, byOther))) return;

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
    if (!byOther || counts.othersFailed === 0)
      await tell(where + ot.fireFailed(result.reason, minutes));
    return;
  }
  await ctx.store.endFire(chat.id, message.message_id, {
    status: "started",
    sessionId: result.sessionId,
  });
  await ctx.api
    .call("setMessageReaction", {
      chat_id: chat.id,
      message_id: message.message_id,
      reaction: [{ type: "emoji", emoji: "👀" }],
    })
    .catch(() => undefined); // Reactions may be off in that chat.

  if (chat.type === "private") {
    await tell(ot.startedHere(result.sessionUrl), message.message_id);
    return;
  }
  const excerpt = Array.from(redactSecrets(message.text ?? message.caption ?? ""))
    .slice(0, 200)
    .join("");
  await tell(
    ot.startedIn({
      chat: chat.title ?? String(chat.id),
      who: byOther ? displayName(from) : null,
      text: excerpt,
      url: result.sessionUrl,
    }),
  );
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
