/**
 * Guest mode: the user calls the bot in a chat it is not a member of, by
 * mentioning it or replying to its message there. Telegram delivers that one
 * message (and the one it replied to) with a query id, and lets the bot send
 * one message back — which it may then edit as often as it likes.
 *
 * So the bot answers at once with a placeholder, keeps the message's id, and
 * hands the call to a session: the day's session of the private chat when the
 * relay is online, a new one otherwise. The session reads the call with
 * get_guest_call and answers by editing that message (answer_guest).
 *
 * Only the user's own calls count, and only while Claude is on in their
 * private chat. Nobody else can start anything from a chat the bot is not in.
 * Calls are kept in a table of their own: such a chat's id may coincide with
 * one of the bot's chats, and nothing else of it is ever seen.
 */

import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { enqueue, guestEnvelope, relayState } from "../relay";
import type { GuestCall, GuestReply } from "../store";
import type { Message } from "../telegram/types";
import type { BotContext } from "./context";
import { hasContent, realReply, toStored } from "./extract";
import { texts } from "./texts";
import { excerptOf, GUEST_CHAT, launch } from "./triggers";

/** Starts in all, per user per hour, as in src/bot/triggers.ts. */
const USER_PER_HOUR = 30;
const DAY = 86_400;

/** What Telegram calls the chat: its title, or the person's name in a private one. */
function titleOf(message: Message): string | null {
  const chat = message.chat;
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || null);
}

/** Change the bot's one message in the guest chat. Best effort: the chat may be gone. */
async function guestSay(
  ctx: Pick<BotContext, "api">,
  call: Pick<GuestCall, "inline_message_id">,
  text: string,
): Promise<void> {
  if (!call.inline_message_id) return;
  await ctx.api
    .call("editMessageText", { inline_message_id: call.inline_message_id, text })
    .catch(() => undefined);
}

export async function onGuestMessage(ctx: BotContext, message: Message): Promise<void> {
  const from = message.from;
  const queryId = message.guest_query_id;
  // Posted as a channel or the chat, no person is known: never the user.
  if (!from || from.is_bot || message.sender_chat || !queryId) return;
  if (!isAllowed(ctx.config, from.id) || !hasContent(message)) return;
  // Guest calls follow the private chat's switch: off there, off everywhere.
  if ((await ctx.store.getClaudeChat(from.id))?.user_id !== from.id) return;

  const stored = toStored(message, ctx.bot);
  const target = realReply(message);
  const replied = target ? toStored(target, ctx.bot) : null;
  const reply: GuestReply | null = replied && {
    from_id: replied.from_id,
    from_name: replied.from_name,
    from_username: replied.from_username,
    text: replied.text,
    own: target?.from?.id === ctx.bot.id,
  };
  const title = titleOf(message);
  const id = await ctx.store.insertGuestCall({
    user_id: from.id,
    query_id: queryId,
    chat_id: message.chat.id,
    chat_type: message.chat.type,
    chat_title: title,
    text: stored.text,
    file: stored.file_kind ? `${stored.file_kind} ${stored.file_name ?? ""}`.trim() : null,
    reply: reply ? JSON.stringify(reply) : null,
  });
  if (id === null) return; // Telegram retried the update.

  const t = texts(from.language_code);
  // The one message the bot gets there. Without it there is nowhere to answer.
  const sent = await ctx.api.call<{ inline_message_id?: string }>("answerGuestQuery", {
    guest_query_id: queryId,
    result: {
      type: "article",
      id: String(id),
      title: "Claude",
      input_message_content: { message_text: t.guestThinking },
    },
  });
  if (!sent.inline_message_id) return;
  await ctx.store.setGuestMessage(id, sent.inline_message_id);
  const call = { inline_message_id: sent.inline_message_id };

  const claimed = await ctx.store.beginFire(
    {
      chatId: GUEST_CHAT,
      messageId: id,
      userId: from.id,
      byOther: false,
      fromName: title,
      excerpt: excerptOf(stored.text, ctx.bot),
      album: null,
    },
    { user: USER_PER_HOUR, others: 0 },
  );
  if (claimed === "again") return;
  if (claimed === "limit") {
    await guestSay(ctx, call, t.tooManyStarts);
    return;
  }

  const now = nowSeconds();
  const day =
    relayState(await ctx.store.getRelay(from.id)) === "online"
      ? await ctx.store.latestSession(from.id, [from.id, GUEST_CHAT], now - (now % DAY), false)
      : null;
  if (day) {
    await enqueue(
      ctx.store,
      {
        user_id: from.id,
        target_session: day,
        origin: "user",
        from_session: null,
        chat_id: GUEST_CHAT,
        message_id: id,
        thread_id: null,
        wants_answer: 0,
        kind: "guest",
      },
      () =>
        guestEnvelope({
          user: { id: from.id, username: from.username ?? null, name: from.first_name },
          call: id,
          chat: title,
        }),
    );
    await ctx.store.endFire(GUEST_CHAT, id, { status: "relayed", sessionId: day });
    return;
  }
  await startGuest(ctx, from.id, id);
}

/** Start a session on a guest call: the usual way, and when the relay could not pass it on. */
export async function startGuest(ctx: BotContext, userId: number, id: number): Promise<void> {
  const call = await ctx.store.getGuestCall(userId, id);
  if (!call) return;
  const started = await launch(ctx, {
    holder: userId,
    chat: { id: GUEST_CHAT, title: call.chat_title, private: false },
    messageId: id,
    topic: null,
    byOther: false,
    continues: null,
    guest: true,
  });
  if (!started) {
    const t = texts((await ctx.store.getUser(userId))?.language);
    await guestSay(ctx, call, t.guestFailed);
  }
}
