/**
 * Setting up the user's assistant from the private chat — Claude's routine,
 * or an OpenAI API key — and its test start; Codex's test start too.
 *
 * Tokens and keys arrive as ordinary messages. Such a message — or anything
 * else that looks like a key (src/secrets.ts) — never reaches storage: the
 * webhook hands it here first, and it is deleted from the chat.
 */

import { codex } from "../agents/codex";
import { loadOpenAI, MODELS, openai, saveOpenAI } from "../agents/openai";
import { isAllowed } from "../env";
import { fire, firePayload, loadRoutine, parseRoutine, saveRoutine } from "../routine";
import { openaiKey, TOO_LONG, webhookSecret } from "../secrets";
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

/**
 * When each user's last test start went out, per provider, in this isolate.
 * Every start is a billed cloud session, and a retried webhook or a double
 * tap must not make two; this costs no write, and a different isolate is rare
 * enough. Setting up one provider right after the other tests both.
 */
const lastTest = new Map<string, number>();
const TEST_COOLDOWN_MS = 60_000;

export function resetTestStarts(): void {
  lastTest.clear();
}

/** False, and the user told so, when a test start went out less than a minute ago. */
async function testAllowed(
  ctx: BotContext,
  user: User,
  provider: "claude" | "openai" | "codex",
): Promise<boolean> {
  const last = lastTest.get(`${provider}:${user.id}`);
  if (last !== undefined && Date.now() - last < TEST_COOLDOWN_MS) {
    await say(ctx, user.id, texts(user.language_code).testTooSoon);
    return false;
  }
  lastTest.set(`${provider}:${user.id}`, Date.now());
  return true;
}

/** Start the routine once, as a check: the session answers "ok" in the private chat. */
export async function testRoutine(ctx: BotContext, user: User, messageId: number): Promise<void> {
  const t = texts(user.language_code);
  const routine = await loadRoutine(ctx.store, ctx.config.secretKey, user.id);
  if (typeof routine === "string") {
    await say(ctx, user.id, t.fireFailed(routine, undefined, "claude"));
    return;
  }
  if (!(await testAllowed(ctx, user, "claude"))) return;
  const result = await fire(
    routine.triggerId,
    routine.token,
    firePayload({ chat: user.id, message: messageId, by: "test" }),
  );
  if (result.ok) {
    await ctx.store.setRoutineTest(user.id, result.sessionId);
    await say(ctx, user.id, t.testStarted(result.sessionUrl));
    return;
  }
  lastTest.delete(`claude:${user.id}`); // Nothing started: trying again at once is fine.
  console.error(
    JSON.stringify({ event: "routine_fire_failed", user: user.id, detail: result.detail }),
  );
  const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
  await say(ctx, user.id, t.fireFailed(result.reason, minutes, "claude"));
}

/** Start an OpenAI session once, as a check, the same way. True when it started. */
export async function testOpenAI(ctx: BotContext, user: User, messageId: number): Promise<boolean> {
  const t = texts(user.language_code);
  const config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
  if (typeof config === "string") {
    await say(ctx, user.id, t.fireFailed(config, undefined, "openai"));
    return false;
  }
  if (!(await testAllowed(ctx, user, "openai"))) return false;
  const result = await openai.start(ctx, user.id, {
    kind: "test",
    chat: user.id,
    message: messageId,
  });
  if (result.ok) {
    await say(ctx, user.id, t.testStarted(null));
    return true;
  }
  lastTest.delete(`openai:${user.id}`);
  const minutes = result.retryAfter ? Math.ceil(result.retryAfter / 60) : undefined;
  await say(ctx, user.id, t.fireFailed(result.reason, minutes, "openai"));
  return false;
}

/** Start a Codex session once, as a check, on the relay's machine. */
export async function testCodex(ctx: BotContext, user: User, messageId: number): Promise<void> {
  const t = texts(user.language_code);
  if (!(await testAllowed(ctx, user, "codex"))) return;
  const result = await codex.start(ctx, user.id, {
    kind: "test",
    chat: user.id,
    message: messageId,
  });
  if (result.ok) {
    await say(ctx, user.id, t.testStarted(null));
    return;
  }
  lastTest.delete(`codex:${user.id}`);
  await say(ctx, user.id, t.fireFailed(result.reason, undefined, "codex"));
}

/**
 * A private message that holds a key: deleted, never stored. A trigger id
 * with a token sets the user's routine; an OpenAI key, their OpenAI setup;
 * either is followed by a test start. A webhook secret joins the OpenAI setup.
 * A key longer than any real one is refused whole, never cut to fit.
 */
export async function handleSecret(
  ctx: BotContext,
  message: Message & { from: User },
): Promise<WebhookReply | null> {
  const user = message.from;
  const t = texts(user.language_code);
  const deleted = await ctx.api
    .call("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id })
    .then(() => true)
    .catch(() => false);
  // If it stays in the chat, the key is exposed there: the user has to know.
  const after = deleted ? "" : `\n\n${t.deleteYourself}`;
  const text = message.text ?? message.caption ?? "";
  const routine = parseRoutine(text);
  const key = routine ? null : openaiKey(text);
  const hook = routine || key ? null : webhookSecret(text);
  if (
    !(routine || key || hook) ||
    !isAllowed(ctx.config, user.id) ||
    !(await hasConnected(ctx, user.id))
  ) {
    await say(ctx, message.chat.id, t.secretDropped(deleted) + after);
    return null;
  }
  if (key === TOO_LONG || hook === TOO_LONG) {
    await say(ctx, message.chat.id, t.secretTooLong + after);
    return null;
  }
  // Answering in the private chat comes on with the first assistant; groups are turned on one by one.
  const first = !(await ctx.store.hasAssistant(user.id));
  if (hook) {
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
    if (typeof config === "string") {
      await say(ctx, message.chat.id, t.webhookNoKey + after);
      return null;
    }
    await saveOpenAI(ctx.store, ctx.config.secretKey, user.id, { ...config, webhookSecret: hook });
    await say(ctx, message.chat.id, t.webhookSaved(deleted) + after);
    return null;
  }
  if (key) {
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
    try {
      // A new key keeps the models chosen before.
      await saveOpenAI(ctx.store, ctx.config.secretKey, user.id, {
        ...(typeof config === "string" ? { chatModel: MODELS[0], taskModel: MODELS[1] } : config),
        key,
      });
    } catch (error) {
      console.error(
        JSON.stringify({ event: "openai_save_failed", user: user.id, error: String(error) }),
      );
      await say(ctx, message.chat.id, t.openaiNotSaved + after);
      return null;
    }
    const active = (await ctx.store.getUser(user.id))?.active_provider ?? null;
    await say(ctx, message.chat.id, t.openaiSaved(deleted) + after);
    // OpenAI answers from now on if nothing else does — once the key has started a session. Another
    // that answers already stays: switching is the user's, in the menu.
    if (await testOpenAI(ctx, user, message.message_id)) {
      if (first) await ctx.store.claimClaudeChat(user.id, user.id);
      await adopt(ctx, user, "openai", active);
    } else if (active !== "openai") {
      await say(ctx, message.chat.id, t.openaiNotActive(first));
    }
    return null;
  }
  try {
    await saveRoutine(ctx.store, ctx.config.secretKey, user.id, routine!);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "routine_save_failed", user: user.id, error: String(error) }),
    );
    await say(ctx, message.chat.id, t.routineNotSaved + after);
    return null;
  }
  const active = (await ctx.store.getUser(user.id))?.active_provider ?? null;
  if (first) await ctx.store.claimClaudeChat(user.id, user.id);
  await say(ctx, message.chat.id, t.routineSaved(routine!.triggerId, deleted) + after);
  // Likewise a routine, which its test start then checks.
  await adopt(ctx, user, "claude", active);
  await testRoutine(ctx, user, message.message_id);
  return null;
}

const NAMES = { claude: "Claude", codex: "Codex", openai: "OpenAI" } as const;

/**
 * A provider just set up answers if none does yet, and the user hears which
 * answers now. One answers already: it stays — switching is only ever the
 * user's, in the menu.
 */
async function adopt(
  ctx: BotContext,
  user: User,
  kind: keyof typeof NAMES,
  active: string | null,
): Promise<void> {
  if (active === kind) return;
  const t = texts(user.language_code);
  if (active && Object.hasOwn(NAMES, active)) {
    await say(ctx, user.id, t.providerReady(NAMES[kind], NAMES[active as keyof typeof NAMES]));
    return;
  }
  await ctx.store.setActiveProvider(user.id, kind);
  await say(ctx, user.id, t.providerActive(NAMES[kind]));
}
