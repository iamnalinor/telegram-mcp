/**
 * Setting up the user's routine from the private chat, and its test start.
 *
 * The routine's token arrives as an ordinary message. Such a message — or
 * anything else that looks like an Anthropic key — never reaches storage:
 * the webhook hands it here first, and it is deleted from the chat.
 */

import { isAllowed } from "../env";
import { fire, firePayload, loadRoutine, parseRoutine, saveRoutine } from "../routine";
import type { Message, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { texts } from "./texts";

function say(ctx: BotContext, chatId: number, text: string): Promise<unknown> {
  return ctx.api
    .call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    .catch(() => undefined);
}

/** Start the routine once, as a check: the session answers "ok" in the private chat. */
export async function testRoutine(ctx: BotContext, user: User, messageId: number): Promise<void> {
  const t = texts(user.language_code);
  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, user.id);
  if (typeof routine === "string") {
    await say(ctx, user.id, t.fireFailed(routine));
    return;
  }
  const result = await fire(
    routine.triggerId,
    routine.token,
    firePayload({ chat: user.id, message: messageId, by: "test" }),
  );
  if (result.ok) {
    await say(ctx, user.id, t.testStarted(result.sessionUrl));
    return;
  }
  console.error(
    JSON.stringify({ event: "routine_fire_failed", user: user.id, detail: result.detail }),
  );
  const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
  await say(ctx, user.id, t.fireFailed(result.reason, minutes));
}

/**
 * A private message that holds a key: deleted, never stored. If it carries a
 * trigger id and a token, it sets the user's routine, followed by a test start.
 */
export async function handleSecret(
  ctx: BotContext,
  message: Message & { from: User },
): Promise<WebhookReply | null> {
  const user = message.from;
  const t = texts(user.language_code);
  await ctx.api
    .call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id })
    .catch(() => undefined);
  const routine = parseRoutine(message.text ?? message.caption ?? "");
  if (!routine || !isAllowed(ctx.config, user.id) || !(await hasConnected(ctx, user.id))) {
    await say(ctx, message.chat.id, t.secretDropped);
    return null;
  }
  await saveRoutine(ctx.store, ctx.config.secretKey, user.id, routine);
  await say(ctx, message.chat.id, t.routineSaved(routine.triggerId));
  await testRoutine(ctx, user, message.message_id);
  return null;
}
