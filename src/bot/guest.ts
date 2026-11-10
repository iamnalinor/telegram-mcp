/**
 * Guest mode: the bot is called in a chat it is not a member of, by a mention
 * or a reply to its message there. Telegram delivers that one message (and
 * the one it replied to) with a query id, and lets the bot send one message
 * back — which it may then edit as often as it likes.
 *
 * Such a chat is connected the way a group is: the first call there by
 * someone who may use the bot and has a routine binds the chat to them, and
 * from then on their rules apply — their routine answers, their own calls
 * count as the user's, and other people's count only where they turned
 * "Others too" on for that chat, a few times an hour (see `claude_chats`).
 * They see and change it in the menu; when they let go, the next caller
 * takes the chat.
 *
 * A call is answered at once with a placeholder, whose id is kept, and handed
 * to a session: that chat's session of the day when the relay is online, a new
 * one otherwise. A reply to the bot's own message there goes to the chat's
 * latest session however old. The session reads the call with get_guest_call
 * and answers by editing that message (answer_guest).
 *
 * The chat's id may coincide with one of the bot's chats, so everything of it
 * is filed under a key of its own (`guest_chats`), and nothing else of it is
 * ever seen or stored.
 */

import { nowSeconds } from "../crypto";
import { isAllowed } from "../env";
import { guestEnvelope } from "../agents/envelopes";
import { activeProvider, startsPerHour } from "../agents/route";
import { providerOf, type Delivery } from "../agents/types";
import { redactSecrets } from "../secrets";
import {
  GUEST_BASE,
  type ClaudeChat,
  type GuestCall,
  type GuestReply,
  type StoredButton,
} from "../store";
import { displayName, type CallbackQuery, type Message } from "../telegram/types";
import type { BotContext, WebhookReply } from "./context";
import { hasContent, realReply, toStored } from "./extract";
import { releaseChat } from "./scenes";
import { spinnerLine } from "./spinner";
import { texts } from "./texts";
import { excerptOf, holderName, launch } from "./triggers";

const DAY = 86_400;

/** What Telegram calls the chat: its title, or the person's name in a private one. */
function titleOf(message: Message): string | null {
  const chat = message.chat;
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || null);
}

/** Change the bot's message for a call. Best effort: the chat may be gone. */
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

/**
 * Whose chat this is, binding it to the caller when it is nobody's yet. Null
 * when the call is to be dropped: the caller may not use the bot or has no
 * routine, or the chat is someone else's and closed to others.
 */
async function holderOf(
  ctx: BotContext,
  message: Message,
  callerId: number,
): Promise<{ key: number; claim: ClaudeChat } | null> {
  const chat = message.chat;
  const title = titleOf(message);
  // A private chat is known by the other person's id, which two callers' chats
  // with that person share: each caller's is a chat of its own.
  const type = chat.type === "private" ? `private:${callerId}` : chat.type;
  let known = await ctx.store.guestChat(type, chat.id);
  let claim = known ? await ctx.store.getClaudeChat(GUEST_BASE + known.id) : null;
  if (claim && !isAllowed(ctx.config, claim.user_id)) {
    // A holder who may no longer use the bot holds nothing.
    await releaseChat(ctx, claim.user_id, GUEST_BASE + known!.id);
    claim = null;
  }
  if (!claim) {
    // The first call binds the chat — for someone who could turn Claude on in a group, too.
    if (!isAllowed(ctx.config, callerId) || !(await ctx.store.hasAssistant(callerId))) return null;
    known = await ctx.store.upsertGuestChat(type, chat.id, title);
    await ctx.store.claimClaudeChat(callerId, GUEST_BASE + known.id);
    claim = await ctx.store.getClaudeChat(GUEST_BASE + known.id);
  } else if (known && known.title !== title) {
    await ctx.store.upsertGuestChat(type, chat.id, title);
  }
  if (!known || !claim) return null;
  if (callerId !== claim.user_id && !claim.others) {
    await tellHeld(ctx, message, callerId, claim.user_id, known.id);
    return null;
  }
  return { key: GUEST_BASE + known.id, claim };
}

/** Callers already told that a chat is someone else's, in this isolate: once is enough. */
const toldHeld = new Set<string>();

/**
 * Someone who could have taken the chat finds it held by another: unlike in a
 * group, nothing shows them that, so they hear it once in private.
 */
async function tellHeld(
  ctx: BotContext,
  message: Message,
  callerId: number,
  holder: number,
  chat: number,
): Promise<void> {
  const mark = `${chat}:${callerId}`;
  if (toldHeld.has(mark) || !isAllowed(ctx.config, callerId)) return;
  if (!(await ctx.store.hasAssistant(callerId))) return;
  toldHeld.add(mark);
  const t = texts(message.from?.language_code);
  await ctx.api
    .call("sendMessage", {
      chat_id: callerId,
      text: t.guestHeld(titleOf(message) ?? "", await holderName(ctx, holder)),
      parse_mode: "HTML",
      disable_notification: true,
    })
    .catch(() => undefined);
}

export async function onGuestMessage(ctx: BotContext, message: Message): Promise<void> {
  const from = message.from;
  const queryId = message.guest_query_id;
  // Posted as a channel or the chat, no person is known: nobody's call.
  if (!from || from.is_bot || message.sender_chat || !queryId || !hasContent(message)) return;
  // As in a group: a forward or an inline bot's text is not the sender's own, and calls on nobody.
  if (message.forward_origin || message.via_bot) return;
  const held = await holderOf(ctx, message, from.id);
  if (!held) return;
  const { key, claim } = held;
  const holder = claim.user_id;
  const byOther = from.id !== holder;

  const stored = toStored(message, ctx.bot);
  const target = realReply(message);
  const replied = target ? toStored(target, ctx.bot) : null;
  const toOwn = target?.from?.id === ctx.bot.id;
  const reply: GuestReply | null = replied && {
    from_id: replied.from_id,
    from_name: replied.from_name,
    from_username: replied.from_username,
    text: redactSecrets(replied.text),
    own: toOwn,
  };
  const title = titleOf(message);
  const id = await ctx.store.insertGuestCall({
    user_id: holder,
    chat_key: key,
    query_id: queryId,
    from_id: from.id,
    from_name: displayName(from),
    from_username: from.username ?? null,
    by_other: byOther ? 1 : 0,
    text: stored.text,
    file: stored.file_kind ? `${stored.file_kind} ${stored.file_name ?? ""}`.trim() : null,
    reply: reply ? JSON.stringify(reply) : null,
  });
  if (id === null) return; // Telegram retried the update.

  const owner = await ctx.store.getUser(holder);
  const tellHolder = (text: string) =>
    ctx.api
      .call("sendMessage", {
        chat_id: holder,
        text,
        parse_mode: "HTML",
        disable_notification: true,
      })
      .catch(() => undefined);

  // Claimed before anything is posted: past the limit the bot stays silent
  // there, so nobody can make it fill a chat with placeholders.
  const entry = {
    chatId: key,
    messageId: id,
    userId: holder,
    byOther,
    fromName: displayName(from),
    excerpt: excerptOf(stored.text, ctx.bot),
    album: null,
  };
  const active = await activeProvider(ctx, holder);
  const claimed = await ctx.store.beginFire(entry, {
    user: startsPerHour(active),
    others: claim.others_limit,
  });
  if (claimed === "again") return;
  if (claimed === "limit") {
    if (await ctx.store.noteLimited(entry)) {
      const ot = texts(owner?.language);
      await tellHolder(
        `${ot.inChat(title ?? "")} ` +
          (byOther ? ot.othersLimited(claim.others_limit) : ot.tooManyStarts),
      );
    }
    return;
  }

  // The one message the bot gets for this call. Without it there is nowhere to answer.
  const sent = await ctx.api
    .call<{ inline_message_id?: string }>("answerGuestQuery", {
      guest_query_id: queryId,
      result: {
        type: "article",
        id: String(id),
        title: "Claude",
        input_message_content: { message_text: spinnerLine() },
      },
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "guest_answer_failed", error: String(error) }));
      return null;
    });
  if (!sent?.inline_message_id) {
    // Telegram retries nothing here: the holder hears why nothing came.
    await ctx.store.endFire(key, id, { status: "failed" });
    if (!byOther) await tellHolder(texts(owner?.language).guestNoAnswer(title ?? ""));
    return;
  }
  await ctx.store.setGuestMessage(id, sent.inline_message_id);

  // Where it goes: the chat's session of the day, if the provider the holder
  // answers with now made it; a reply to the bot's message there, to the
  // chat's latest session however old, whoever made it.
  const now = nowSeconds();
  const latest = await ctx.store.latestSession(
    holder,
    [key],
    toOwn ? 0 : now - (now % DAY),
    byOther,
  );
  const session = latest && (toOwn || providerOf(latest) === active?.kind) ? latest : null;
  const into: Delivery | null = session
    ? {
        session,
        job: {
          origin: byOther ? "other" : "user",
          from_session: null,
          chat_id: key,
          message_id: id,
          thread_id: null,
          wants_answer: 0,
          kind: "guest",
        },
        envelope: () =>
          guestEnvelope({
            user: {
              id: holder,
              username: owner?.username ?? null,
              name: owner?.first_name ?? null,
            },
            call: id,
            chat: title,
            sender: { id: from.id, name: displayName(from) },
            byUser: !byOther,
          }),
      }
    : null;
  await startGuest(ctx, holder, id, toOwn ? session : null, into);
}

/**
 * Route a guest call: into the chat's session (`into`), else a new session —
 * the usual way, and when the relay could not pass it on. `continues`: the
 * session whose answer the call replies to.
 */
export async function startGuest(
  ctx: BotContext,
  userId: number,
  id: number,
  continues: string | null,
  into?: Delivery | null,
): Promise<void> {
  const call = await ctx.store.getGuestCall(userId, id);
  if (!call) return;
  const chat = await ctx.store.guestChatByKey(call.chat_key);
  const started = await launch(ctx, {
    holder: userId,
    chat: { id: call.chat_key, title: chat?.title ?? null, private: false },
    messageId: id,
    topic: null,
    byOther: call.by_other === 1,
    continues,
    guest: true,
    into,
  });
  if (!started) {
    const t = texts((await ctx.store.getUser(userId))?.language);
    await guestSay(ctx, call, t.guestFailed);
  }
}

/** Presses kept per call: past it the buttons still answer, but nothing more is recorded. */
export const GUEST_PRESSES = 200;

/**
 * Which set of buttons a guest call's message carries (its stored buttons,
 * hashed short): the callback data names it, so that a press on a keyboard an
 * answer has since replaced is not read against the new one. The same buttons
 * give the same revision, and mean the same.
 */
export function guestRevision(buttons: string): string {
  // FNV-1a, 32 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < buttons.length; i++) {
    hash ^= buttons.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A press on a button answer_guest put on the bot's message for a call. Only
 * the buttons that message carries now count; the press is recorded under the
 * call (its chat's key and its number) for get_guest_call to show.
 */
export async function handleGuestPress(
  ctx: BotContext,
  query: CallbackQuery,
  revision: string,
  row: number,
  column: number,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text,
  });
  // Telegram names a guest call's message by its inline id alone.
  const call =
    query.inline_message_id && !query.message
      ? await ctx.store.guestCallByMessage(query.inline_message_id)
      : null;
  if (!call) return answer(t.alreadyAnswered);
  if (!call.buttons || guestRevision(call.buttons) !== revision) return answer(t.sceneStale);
  let buttons: StoredButton[][] | null;
  try {
    buttons = JSON.parse(call.buttons) as StoredButton[][];
  } catch {
    buttons = null;
  }
  const button = buttons?.[row]?.[column];
  if (!button || button.url || button.copy) return answer(t.sceneStale);
  await ctx.store.insertPress(
    {
      chat_id: call.chat_key,
      message_id: call.id,
      callback_id: query.id,
      user_id: query.from.id,
      user_name: query.from.username ? `@${query.from.username}` : displayName(query.from),
      label: button.text,
      data: button.data ?? button.text,
      date: nowSeconds(),
    },
    GUEST_PRESSES,
  );
  return answer(t.pressed(button.text));
}
