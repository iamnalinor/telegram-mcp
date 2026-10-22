/**
 * POST /telegram — every update Telegram sends the bot.
 *
 * Two gates before the body is even read: the caller's IP must be in
 * Telegram's published ranges, and X-Telegram-Bot-Api-Secret-Token must match
 * the secret we registered (derived from the bot token, compared in constant
 * time). Either failing is a 403.
 *
 * Past the gates the answer is always 200. Telegram retries anything else,
 * and a retried update is safe anyway — inserts are idempotent — but a retry
 * storm on a poison update would only burn quota.
 *
 * What gets written is deliberately narrow, because D1 bills per row: a
 * private chat only once its owner has pressed /start (or signed in), a group
 * only while at least one user holds a grant on it. Everything else is read
 * and dropped.
 */

import { nowSeconds, timingSafeEqual } from "../crypto";
import { isAllowed } from "../env";
import { TelegramError } from "../telegram/api";
import { isTelegramIp } from "../telegram/ip";
import {
  displayName,
  type CallbackQuery,
  type ChatFullInfo,
  type ChatMemberUpdated,
  type Message,
  type MessageReactionUpdated,
  type Update,
} from "../telegram/types";
import type { Guard } from "../store";
import type { BotContext, WebhookReply } from "./context";
import { handleAssistantButton, handleChatShared, handleCommand, handleRevoke } from "./commands";
import { parseCommand, realReply, toStored, topicName, topicOf } from "./extract";
import { texts } from "./texts";

function webhookAllowed(request: Request, ctx: Pick<BotContext, "config">): boolean {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ctx.config.skipIpCheck && !isTelegramIp(ip)) return false;
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(secret, ctx.config.webhookSecret);
}

/** Which guard a chat's messages are written under, or null when they never are. */
function guardFor(ctx: BotContext, message: Message): Guard | null {
  const chat = message.chat;
  if (chat.type === "private") return isAllowed(ctx.config, chat.id) ? "dm" : null;
  if (chat.type === "group" || chat.type === "supergroup") return "group";
  return null;
}

/** Topic names repeat on every message in a topic; skip the write once seen in this isolate. */
const topicNames = new Map<string, string>();

async function learnTopic(ctx: BotContext, message: Message): Promise<void> {
  const thread = topicOf(message);
  const name = topicName(message);
  if (!thread || !name) return;
  const key = `${message.chat.id}:${thread}`;
  if (topicNames.get(key) === name) return;
  await ctx.store.upsertTopic(message.chat.id, thread, name);
  topicNames.set(key, name);
}

// --- handlers --------------------------------------------------------------

async function onMessage(
  ctx: BotContext,
  message: Message,
  edited: boolean,
): Promise<WebhookReply | null> {
  if (message.migrate_to_chat_id) {
    await ctx.store.migrateChat(message.chat.id, message.migrate_to_chat_id);
    return null;
  }

  const guard = guardFor(ctx, message);
  if (guard) {
    const stored = toStored(message, ctx.bot);
    const fresh = edited
      ? (await ctx.store.upsertEditedMessage(stored, guard), true)
      : await ctx.store.insertMessage(stored, guard);
    // The message being replied to comes along in full. Keep it too, so the
    // reply makes sense even when the bot never saw the original (it predates
    // the bot, or privacy mode hid it). Ignored if already stored.
    const target = realReply(message);
    const cutoff = nowSeconds() - ctx.config.retentionDays * 86_400;
    if (fresh && !edited && target && target.chat.id === message.chat.id && target.date >= cutoff) {
      await ctx.store.insertMessage(toStored(target, ctx.bot), guard);
    }
    if (fresh && guard === "group") {
      await learnTopic(ctx, message);
      if (message.new_chat_title)
        await ctx.store.renameChat(message.chat.id, message.new_chat_title);
    }
  }

  if (edited) return null;
  if (message.chat_shared) return handleChatShared(ctx, message);

  const command = parseCommand(message, ctx.bot);
  if (command) {
    return handleCommand(ctx, message, command);
  }
  return null;
}

/** The bot itself was added to, removed from, or promoted in a chat. */
async function onMyChatMember(
  ctx: BotContext,
  update: ChatMemberUpdated,
): Promise<WebhookReply | null> {
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return null;

  const was = update.old_chat_member.status;
  const now = update.new_chat_member.status;
  const present = (status: string) => !["left", "kicked"].includes(status);

  if (!present(now)) {
    await ctx.store.deleteChat(chat.id);
    return null;
  }

  const isAdmin = now === "administrator" || now === "creator";

  if (!present(was)) {
    // Just added. Whoever added the bot gets access, if they may use it at all.
    const adder = update.from;
    if (!isAllowed(ctx.config, adder.id) || adder.is_bot) {
      await ctx.api.call("leaveChat", { chat_id: chat.id }).catch(() => undefined);
      return null;
    }

    await ctx.store.upsertChat({
      chat_id: chat.id,
      type: chat.type,
      title: chat.title,
      username: chat.username,
      is_forum: chat.is_forum,
      bot_is_admin: isAdmin,
    });
    await ctx.store.upsertUser({
      user_id: adder.id,
      username: adder.username,
      first_name: adder.first_name,
      language: adder.language_code,
    });
    // Nothing older than this moment exists for the bot, so there is nothing to hide.
    await ctx.store.upsertGrant(adder.id, chat.id, "added_bot", 0);

    const t = texts(adder.language_code);
    return {
      method: "sendMessage",
      chat_id: chat.id,
      parse_mode: "HTML",
      text: t.addedGreeting({
        name: displayName(adder),
        retention: ctx.config.retentionDays,
        privacyOn: !ctx.bot.canReadAll,
        admin: isAdmin,
      }),
    };
  }

  // Promoted or demoted. An admin bot can see whether history is visible to newcomers.
  let visible: boolean | null = null;
  if (isAdmin) {
    const info = await ctx.api
      .call<ChatFullInfo>("getChat", { chat_id: chat.id })
      .catch(() => null);
    visible = info?.has_visible_history ?? null;
  }
  await ctx.store.upsertChat({
    chat_id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    is_forum: chat.is_forum,
    bot_is_admin: isAdmin,
    visible_history: visible,
  });
  return null;
}

/** Someone else joined or left. Only reaches admin bots. */
async function onChatMember(ctx: BotContext, update: ChatMemberUpdated): Promise<void> {
  const status = update.new_chat_member.status;
  const left =
    status === "left" ||
    status === "kicked" ||
    (status === "restricted" && update.new_chat_member.is_member === false);
  if (!left) return;

  const userId = update.new_chat_member.user.id;
  if (!(await ctx.store.getGrant(userId, update.chat.id))) return;
  await ctx.store.revokeGrant(userId, update.chat.id);
}

async function onCallback(ctx: BotContext, query: CallbackQuery): Promise<WebhookReply | null> {
  const data = query.data ?? "";

  const revoke = /^rv:(-?\d+)$/.exec(data);
  if (revoke) {
    if (!isAllowed(ctx.config, query.from.id)) {
      return {
        method: "answerCallbackQuery",
        callback_query_id: query.id,
        text: texts(query.from.language_code)
          .notAllowed(query.from.id)
          .replace(/<[^>]+>/g, ""),
      };
    }
    return handleRevoke(ctx, query, Number(revoke[1]));
  }

  const press = /^cb:(\d+)\.(\d+)$/.exec(data);
  if (press) return handleAssistantButton(ctx, query, Number(press[1]), Number(press[2]));

  return {
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text: texts(query.from.language_code).alreadyAnswered,
  };
}

/** Reactions are kept only on the bot's own messages — they are answers to it. */
async function onReaction(ctx: BotContext, update: MessageReactionUpdated): Promise<void> {
  const user = update.user;
  if (!user) return;
  const stored = await ctx.store.getMessage(update.chat.id, update.message_id);
  if (!stored?.outgoing) return;

  const emoji = update.new_reaction
    .map((reaction) => (reaction.type === "emoji" ? reaction.emoji : `[${reaction.type}]`))
    .filter(Boolean)
    .join("");
  if (!emoji) {
    await ctx.store.deleteReaction(update.chat.id, update.message_id, user.id);
    return;
  }
  await ctx.store.setReaction({
    chat_id: update.chat.id,
    message_id: update.message_id,
    user_id: user.id,
    user_name: user.username ? `@${user.username}` : displayName(user),
    emoji,
    date: update.date || nowSeconds(),
  });
}

async function dispatch(ctx: BotContext, update: Update): Promise<WebhookReply | null> {
  if (update.message) return onMessage(ctx, update.message, false);
  if (update.edited_message) return onMessage(ctx, update.edited_message, true);
  if (update.my_chat_member) return onMyChatMember(ctx, update.my_chat_member);
  if (update.chat_member) {
    await onChatMember(ctx, update.chat_member);
    return null;
  }
  if (update.callback_query) return onCallback(ctx, update.callback_query);
  if (update.message_reaction) {
    await onReaction(ctx, update.message_reaction);
    return null;
  }
  return null;
}

export async function handleWebhook(
  request: Request,
  makeContext: () => Promise<BotContext>,
  base: Pick<BotContext, "config">,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!webhookAllowed(request, base)) return new Response(null, { status: 403 });

  let update: Update;
  try {
    update = await request.json<Update>();
  } catch {
    return new Response(null, { status: 200 });
  }

  try {
    const ctx = await makeContext();
    const reply = await dispatch(ctx, update);
    if (reply) return Response.json(reply);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "webhook_error",
        update_id: update.update_id,
        error: error instanceof Error ? error.message : String(error),
        telegram: error instanceof TelegramError ? error.description : undefined,
      }),
    );
    // A press left unanswered keeps spinning in the user's client.
    if (update.callback_query) {
      return Response.json({
        method: "answerCallbackQuery",
        callback_query_id: update.callback_query.id,
        text: "Something went wrong. Try again.",
      });
    }
  }
  return new Response(null, { status: 200 });
}
