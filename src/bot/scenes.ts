/**
 * Scenes in Telegram: sending a scene's message, and every event on it.
 *
 * `applyEvent` is the one path every source takes — a press, a vote, a typed
 * reply, the owner's session acting through update_scene. It reads the scene
 * (one row), checks the event, runs the reducer (src/scenes/engine.ts) and
 * commits on the version it read: a concurrent event that got there first
 * makes it read again, up to three times. An event that changes nothing
 * writes nothing. The answer to a press is the webhook's own response.
 *
 * Edits keep to one a second per message: an event that comes sooner marks
 * the scene dirty and leaves a redraw for later (ExecutionContext.waitUntil),
 * which only one of those waiting performs. Telegram's 429 silences the scene
 * until retry_after; the next event draws what is owed.
 */

import { nowSeconds } from "../crypto";
import { TelegramError } from "../telegram/api";
import {
  displayName,
  type CallbackQuery,
  type InlineKeyboardMarkup,
  type Message,
  type User,
} from "../telegram/types";
import { allow } from "../limits";
import type { Compiled } from "../scenes/definition";
import { match, run, type Actor, type Effect, type SceneEvent } from "../scenes/engine";
import { equal, LangError, type Value } from "../scenes/lang";
import {
  callbackData,
  parseCallback,
  render,
  type Rendered,
  type RenderedButton,
} from "../scenes/render";
import {
  BOT_ACCOUNT,
  type SceneMessage,
  type ScenePatch,
  type SceneRow,
  type StoredButton,
} from "../store";
import type { BotContext, WebhookReply } from "./context";
import { toStored } from "./extract";
import { texts } from "./texts";

type Answer = { text?: string; alert?: boolean };

/** What a scene's I/O needs; tools pass their own context, which has these too. */
type SceneContext = Pick<BotContext, "api" | "store" | "bot" | "defer" | "sceneLimit">;

const ATTEMPTS = 3;
const EDIT_GAP_MS = 1000;
/** How long a held-back edit waits; tests shorten it. */
export const sceneTiming = { redrawDelayMs: 1200 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function actorOf(user: User): Actor {
  return { id: user.id, name: displayName(user) };
}

/** The scene's tree and state, parsed from its row. */
function loaded(row: SceneRow): {
  compiled: Compiled;
  state: Record<string, Value>;
  messages: SceneMessage[];
} {
  return {
    compiled: JSON.parse(row.def) as Compiled,
    state: JSON.parse(row.state) as Record<string, Value>,
    messages: JSON.parse(row.messages) as SceneMessage[],
  };
}

async function ownerOf(ctx: SceneContext, row: SceneRow): Promise<Actor> {
  const user = await ctx.store.getUser(row.owner);
  return {
    id: row.owner,
    name: user?.username ? `@${user.username}` : (user?.first_name ?? String(row.owner)),
  };
}

function keyboard(rows: RenderedButton[][], sceneId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({
        text: button.text,
        ...(button.url ? { url: button.url } : { callback_data: callbackData(sceneId, button) }),
        ...(button.style ? { style: button.style as "primary" | "success" | "danger" } : {}),
      })),
    ),
  };
}

/** The keyboard as the bot keeps it with the message; null when there is none. */
function storedButtons(rows: RenderedButton[][], sceneId: number): string | null {
  if (!rows.length) return null;
  const stored: StoredButton[][] = rows.map((row) =>
    row.map((button) => ({
      text: button.text,
      ...(button.url ? { url: button.url } : { data: callbackData(sceneId, button) }),
    })),
  );
  return JSON.stringify(stored);
}

function body(rendered: Rendered): Record<string, unknown> {
  return rendered.format === "rich"
    ? { rich_message: { markdown: rendered.text } }
    : { text: rendered.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
}

function screenOf(row: SceneRow, view: string, owner: Actor): Rendered {
  const { compiled, state } = loaded(row);
  return render(compiled, view, state, { owner, now: nowSeconds() });
}

/** Send one of the scene's views as a new live message, and keep it like any the bot sent. */
async function sendView(
  ctx: SceneContext,
  row: SceneRow,
  view: string,
  options: { replyTo?: number; silent?: boolean } = {},
): Promise<Message> {
  const owner = await ownerOf(ctx, row);
  const rendered = screenOf(row, view, owner);
  const message = await ctx.api.call<Message>(
    rendered.format === "rich" ? "sendRichMessage" : "sendMessage",
    {
      chat_id: row.chat_id,
      ...body(rendered),
      ...(row.thread_id ? { message_thread_id: row.thread_id } : {}),
      ...(options.replyTo
        ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(options.silent ? { disable_notification: true } : {}),
      ...(rendered.rows.length ? { reply_markup: keyboard(rendered.rows, row.id) } : {}),
    },
  );
  const stored = toStored(message, ctx.bot);
  stored.outgoing = true;
  stored.mentions_bot = false;
  stored.text = rendered.plain;
  stored.buttons = storedButtons(rendered.rows, row.id);
  stored.sent_by = row.owner;
  stored.session_id = row.session_id;
  stored.agent = row.session_id ? row.agent : null;
  await ctx.store.insertMessage(stored, "always");
  await ctx.store.linkScene("message", `${row.chat_id}:${message.message_id}`, row.id, view);
  return message;
}

/**
 * Create a scene and send its first message. The row comes first (the
 * buttons carry its id); if Telegram refuses the message, the row goes.
 */
export async function startScene(
  ctx: SceneContext,
  p: {
    chatId: number;
    threadId: number | null;
    owner: number;
    session: string | null;
    agent: string | null;
    compiled: Compiled;
    state: Record<string, Value>;
    replyTo?: number;
    silent?: boolean;
  },
): Promise<{ id: number; message: Message }> {
  const id = await ctx.store.createScene({
    chat_id: p.chatId,
    thread_id: p.threadId,
    owner: p.owner,
    session_id: p.session,
    agent: p.agent,
    title: p.compiled.title,
    brief: p.compiled.brief,
    def: JSON.stringify(p.compiled),
    state: JSON.stringify(p.state),
    wake_limit: p.compiled.wakeLimit,
  });
  const row = (await ctx.store.getScene(id))!;
  let message: Message;
  try {
    message = await sendView(ctx, row, "main", { replyTo: p.replyTo, silent: p.silent });
  } catch (error) {
    await ctx.store.deleteScene(id);
    throw error;
  }
  await ctx.store.commitScene(id, row.version, {
    messages: JSON.stringify([{ id: message.message_id, view: "main" }]),
    edited_at: Date.now(),
  });
  return { id, message };
}

/** A press on a scene's button: the answer goes back as the webhook's response. */
export async function handleScenePress(
  ctx: BotContext,
  query: CallbackQuery,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const parsed = parseCallback(query.data ?? "");
  const message = query.message;
  const answer =
    parsed && message
      ? await applyEvent(
          ctx,
          parsed.sceneId,
          { on: `press:${parsed.press}`, user: actorOf(query.from), arg: parsed.arg },
          {
            query,
            chatId: message.chat.id,
            messageId: message.message_id,
            arg: parsed.arg,
            press: parsed.press,
          },
        )
      : { text: t.sceneStale };
  return {
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    ...(answer.text ? { text: answer.text } : {}),
    ...(answer.alert ? { show_alert: true } : {}),
  };
}

interface Press {
  query: CallbackQuery;
  chatId: number;
  messageId: number;
  press: string;
  arg: Value | undefined;
}

/** Whether the pressed button is on the message as it is drawn now. */
function onScreen(rendered: Rendered, press: Press): boolean {
  return rendered.rows.some((row) =>
    row.some(
      (button) =>
        button.press === press.press &&
        (button.arg === undefined
          ? press.arg === undefined
          : press.arg !== undefined && equal(button.arg, press.arg)),
    ),
  );
}

/**
 * Apply an event to a scene: every source comes through here. The answer is
 * for whoever caused it, in their language (a press shows it; other sources
 * may ignore it).
 */
async function applyEvent(
  ctx: SceneContext,
  sceneId: number,
  incoming: Omit<SceneEvent, "owner" | "now">,
  press?: Press,
  language?: string | null,
): Promise<Answer> {
  const t = texts(press?.query.from.language_code ?? language);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await ctx.store.getScene(sceneId);
    if (!row || row.status !== "active") return { text: t.sceneOver };
    const owner = await ownerOf(ctx, row);
    const { compiled, state, messages } = loaded(row);

    if (press) {
      // Only a button on the message as drawn now counts: an old keyboard, or
      // callback_data made up by a client, changes nothing.
      const shown = messages.find((message) => message.id === press.messageId);
      if (row.chat_id !== press.chatId || !shown) return { text: t.sceneStale };
      const view = shown === messages[0] ? row.view : shown.view;
      let current: Rendered;
      try {
        current = render(compiled, view, state, { owner, now: nowSeconds() });
      } catch {
        return { text: t.sceneFailed };
      }
      if (!onScreen(current, press)) return { text: t.sceneStale };
    }
    if (attempt === 0 && !(await allow(ctx.sceneLimit, `${sceneId}:${incoming.user.id}`))) {
      return { text: t.sceneTooFast };
    }

    const event: SceneEvent = { ...incoming, now: nowSeconds(), owner };
    const found = match(compiled, state, event);
    if ("refused" in found) {
      if (found.refused === "broken") {
        await recordError(ctx, row, event.user, "rule", found.text ?? "");
        return { text: t.sceneFailed };
      }
      if (found.refused === "not_for_you") {
        return { text: found.who === "owner" ? t.sceneNotForYou(owner.name) : t.sceneDenied };
      }
      return { text: found.refused === "said" && found.text ? found.text : t.sceneDenied };
    }
    if (found.wakes) {
      // Waking the session is not wired in yet: nobody can answer.
      return { text: t.sceneNobody };
    }

    const result = run(compiled, state, event, found.rule);
    if ("refused" in result) {
      if (result.refused === "full") return { text: t.sceneFull };
      await recordError(ctx, row, event.user, "rule", result.detail);
      return { text: t.sceneFailed };
    }

    const patch: ScenePatch = {};
    for (const effect of result.effects) {
      if (effect.kind === "show") patch.view = effect.view;
      if (effect.kind === "finish") patch.status = "finished";
    }
    const changed =
      !equal(result.state, state) ||
      (patch.view !== undefined && patch.view !== row.view) ||
      patch.status;
    if (changed) {
      const next: SceneRow = { ...row, ...patch, state: JSON.stringify(result.state) };
      // The new state must draw; a screen that cannot is refused before anything is written.
      try {
        for (const message of messages)
          screenOf(next, message === messages[0] ? next.view : message.view, owner);
      } catch (error) {
        if (!(error instanceof LangError)) throw error;
        await recordError(ctx, row, event.user, "view", error.message);
        return { text: t.sceneFailed };
      }
      const now = Date.now();
      const drawNow = now - row.edited_at >= EDIT_GAP_MS && now >= row.quiet_until;
      patch.state = next.state;
      if (drawNow) patch.edited_at = now;
      else patch.dirty = 1;
      if (!(await ctx.store.commitScene(row.id, row.version, patch))) continue;
      const committed: SceneRow = { ...next, ...patch, version: row.version + 1 };
      if (drawNow) await redraw(ctx, committed);
      else later(ctx, row.id);
    }
    return perform(ctx, row, event, result.effects);
  }
  return { text: t.sceneFailed };
}

/** What the event asked for besides the state: answers now, the rest after the commit. */
async function perform(
  ctx: SceneContext,
  row: SceneRow,
  event: SceneEvent,
  effects: Effect[],
): Promise<Answer> {
  let answer: Answer = {};
  for (const effect of effects) {
    switch (effect.kind) {
      case "toast":
        answer = { text: effect.text };
        break;
      case "alert":
        answer = { text: effect.text, alert: true };
        break;
      case "log":
        await ctx.store.addSceneEvent(row.id, {
          name: effect.name,
          user_id: event.user.id,
          user_name: event.user.name,
          data: event.arg === undefined ? null : JSON.stringify({ arg: event.arg }),
        });
        break;
      case "show":
      case "finish":
        break;
      default:
        await recordError(ctx, row, event.user, effect.kind, "not supported yet");
    }
  }
  return answer;
}

/** A failure the session should see in get_scene: an action Telegram refused, a rule that broke. */
async function recordError(
  ctx: SceneContext,
  row: SceneRow,
  user: Actor | null,
  action: string,
  description: string,
): Promise<void> {
  await ctx.store.addSceneEvent(row.id, {
    name: "error",
    user_id: user?.id ?? null,
    user_name: user?.name ?? null,
    data: JSON.stringify({ action, description: description.slice(0, 300) }),
  });
}

/** An edit held back: one of those waiting draws, a little later. */
function later(ctx: SceneContext, sceneId: number): void {
  const work = (async () => {
    await sleep(sceneTiming.redrawDelayMs);
    if (!(await ctx.store.claimRedraw(sceneId))) return;
    const row = await ctx.store.getScene(sceneId);
    if (!row) return;
    if (Date.now() < row.quiet_until) {
      await ctx.store.markSceneDrawn(sceneId, { dirty: 1 });
      return;
    }
    await ctx.store.markSceneDrawn(sceneId, { edited_at: Date.now() });
    await redraw(ctx, row);
  })().catch((error: unknown) =>
    console.error(
      JSON.stringify({ event: "scene_redraw_failed", scene: sceneId, error: String(error) }),
    ),
  );
  if (ctx.defer) ctx.defer(work);
}

/**
 * Bring every live message of the scene up to its state, editing only those
 * whose text or buttons changed since they were last drawn. A finished scene
 * loses its buttons.
 */
async function redraw(ctx: SceneContext, row: SceneRow): Promise<void> {
  const owner = await ownerOf(ctx, row);
  const { messages } = loaded(row);
  const finished = row.status !== "active";
  const chat = { account_id: BOT_ACCOUNT, chat_id: row.chat_id };
  for (const [index, message] of messages.entries()) {
    let rendered: Rendered;
    try {
      rendered = screenOf(row, index === 0 ? row.view : message.view, owner);
    } catch {
      continue;
    }
    const buttons = finished ? null : storedButtons(rendered.rows, row.id);
    const stored = await ctx.store.getMessage(chat, message.id);
    if (stored && stored.text === rendered.plain && stored.buttons === buttons) continue;
    try {
      await ctx.api.call("editMessageText", {
        chat_id: row.chat_id,
        message_id: message.id,
        ...body(rendered),
        reply_markup: finished ? { inline_keyboard: [] } : keyboard(rendered.rows, row.id),
      });
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      if (error.code === 429) {
        // Everything is committed; the scene stays quiet and the next event draws it.
        await ctx.store.markSceneDrawn(row.id, {
          dirty: 1,
          quiet_until: Date.now() + (error.retryAfter ?? 30) * 1000,
        });
        return;
      }
      if (/message to edit not found|message can't be edited/i.test(error.description)) {
        // The main message is gone: no press can reach the scene any more.
        if (index === 0) {
          await ctx.store.finishScene(row.id);
          return;
        }
        continue;
      }
      if (!/message is not modified/i.test(error.description)) {
        await recordError(ctx, row, null, "edit", error.description);
        continue;
      }
    }
    await ctx.store.updateOutgoing(chat, message.id, { text: rendered.plain, buttons });
  }
}
