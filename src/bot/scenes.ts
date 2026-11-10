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
  type Poll,
  type PollAnswer,
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
  RenderError,
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
import { deliverWake, gateWake, releaseWake, type WakeGate, type WakeSource } from "../scenes/wake";

/**
 * The answer for whoever caused the event: `applied` when a rule ran,
 * `said` when a rule refused in its own words, `noRule` when none took it.
 */
export type Answer = {
  text?: string;
  alert?: boolean;
  applied?: boolean;
  said?: boolean;
  noRule?: boolean;
};

/** What a scene's I/O needs; tools pass their own context, which has these too. */
type SceneContext = Pick<BotContext, "api" | "store" | "bot" | "config" | "defer" | "sceneLimit">;

const ATTEMPTS = 3;
const EDIT_GAP_MS = 1000;
/** How long a held-back edit waits; tests shorten it. */
export const sceneTiming = { redrawDelayMs: 1200 };
/** A held-back edit waits out Telegram's quiet if it is this short; a longer one is left to the next event. */
const QUIET_WAIT_MS = 20_000;
/** A scene in use but unchanged is marked used once a day, so the daily cleanup leaves it. */
const TOUCH_AFTER = 86_400;
/** Telegram's limit for a press's answer. */
const ANSWER_LENGTH = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function actorOf(user: User): Actor {
  return { id: user.id, name: displayName(user) };
}

/** Compiled definitions by their text: parsed once per isolate, not once per render. */
const compiledCache = new Map<string, Compiled>();
const COMPILED_KEPT = 64;

function compiledOf(def: string): Compiled {
  let compiled = compiledCache.get(def);
  if (!compiled) {
    compiled = JSON.parse(def) as Compiled;
    if (compiledCache.size >= COMPILED_KEPT) {
      compiledCache.delete(compiledCache.keys().next().value!);
    }
    compiledCache.set(def, compiled);
  }
  return compiled;
}

/** The scene's tree and state, parsed from its row. */
export function loaded(row: SceneRow): {
  compiled: Compiled;
  state: Record<string, Value>;
  messages: SceneMessage[];
} {
  return {
    compiled: compiledOf(row.def),
    state: JSON.parse(row.state) as Record<string, Value>,
    messages: JSON.parse(row.messages) as SceneMessage[],
  };
}

/** How the user is named to members ("This button is only for …"). */
function nameOf(user: { username: string | null; first_name: string | null } | null, id: number) {
  return user?.username ? `@${user.username}` : (user?.first_name ?? String(id));
}

async function ownerOf(ctx: SceneContext, row: SceneRow): Promise<Actor> {
  if (row.owner_name) return { id: row.owner, name: row.owner_name };
  return { id: row.owner, name: nameOf(await ctx.store.getUser(row.owner), row.owner) };
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

/** The view each live message shows: the main one follows the scene's view. */
function viewOf(row: SceneRow, messages: SceneMessage[], index: number): string {
  return index === 0 ? row.view : messages[index].view;
}

/** Every view the scene's live messages show, each rendered once. */
function screens(row: SceneRow, owner: Actor): Map<string, Rendered> {
  const { compiled, state, messages } = loaded(row);
  const drawn = new Map<string, Rendered>();
  for (const index of messages.keys()) {
    const view = viewOf(row, messages, index);
    if (!drawn.has(view)) {
      drawn.set(view, render(compiled, view, state, { owner, now: nowSeconds(), sceneId: row.id }));
    }
  }
  return drawn;
}

/** Send one of the scene's views as a new live message, and keep it like any the bot sent. */
async function sendView(
  ctx: SceneContext,
  row: SceneRow,
  view: string,
  options: { replyTo?: number; silent?: boolean } = {},
): Promise<Message> {
  const owner = await ownerOf(ctx, row);
  const { compiled, state } = loaded(row);
  const rendered = render(compiled, view, state, { owner, now: nowSeconds(), sceneId: row.id });
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
    /** The saved scene it comes from. */
    templateId?: number | null;
    replyTo?: number;
    silent?: boolean;
  },
): Promise<{ id: number; message: Message }> {
  const id = await ctx.store.createScene({
    chat_id: p.chatId,
    thread_id: p.threadId,
    owner: p.owner,
    owner_name: nameOf(await ctx.store.getUser(p.owner), p.owner),
    session_id: p.session,
    agent: p.agent,
    title: p.compiled.title,
    brief: p.compiled.brief,
    def: JSON.stringify(p.compiled),
    state: JSON.stringify(p.state),
    wake_limit: p.compiled.wakeLimit,
    template_id: p.templateId ?? null,
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

function cut(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length > length ? `${chars.slice(0, length - 1).join("")}…` : text;
}

/** A press on a scene's button: the answer goes back as the webhook's response. */
export async function handleScenePress(
  ctx: BotContext,
  query: CallbackQuery,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const parsed = parseCallback(query.data ?? "");
  const message = query.message;
  let answer: Answer;
  try {
    answer =
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
  } catch (error) {
    // Failures after the commit are handled inside; anything here came before it.
    console.error(JSON.stringify({ event: "scene_press_failed", error: String(error) }));
    answer = { text: t.sceneFailed };
  }
  return {
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    // Telegram refuses a longer answer, and the press would keep spinning.
    ...(answer.text ? { text: cut(answer.text, ANSWER_LENGTH) } : {}),
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

/** Events no person caused one by one (poll totals, a die's value): not counted per person. */
function limited(event: Omit<SceneEvent, "owner" | "now">): boolean {
  return event.user.id !== TELEGRAM.id && event.on !== DICE_EVENT;
}

/**
 * Apply an event to a scene: every source comes through here. The answer is
 * for whoever caused it, in their language (a press shows it; other sources
 * may ignore it).
 */
export async function applyEvent(
  ctx: SceneContext,
  sceneId: number,
  incoming: Omit<SceneEvent, "owner" | "now">,
  press?: Press,
  language?: string | null,
  /** A session of the owner's acting through update_scene, rather than a person in Telegram. */
  source?: WakeSource,
): Promise<Answer> {
  const wake: Wake = { gate: null, row: null, used: false, source };
  try {
    return await attempt(ctx, sceneId, incoming, press, language, wake);
  } finally {
    // The gate claimed a start; a rule that in the end did not wake lets it go.
    if (wake.gate && wake.row && !wake.used) await releaseWake(ctx, wake.row, wake.gate);
  }
}

/** A gate passed for this event, once, whatever the retries. */
interface Wake {
  gate: (WakeGate & { ok: true }) | null;
  row: SceneRow | null;
  used: boolean;
  source?: WakeSource;
}

/** After the commit nothing may undo the event: a failure is logged and kept for the session. */
async function afterCommit(ctx: SceneContext, row: SceneRow, user: Actor, error: unknown) {
  console.error(
    JSON.stringify({ event: "scene_after_commit_failed", scene: row.id, error: String(error) }),
  );
  await recordError(ctx, row, user, "after", String(error)).catch(() => undefined);
}

async function attempt(
  ctx: SceneContext,
  sceneId: number,
  incoming: Omit<SceneEvent, "owner" | "now">,
  press: Press | undefined,
  language: string | null | undefined,
  wake: Wake,
): Promise<Answer> {
  const t = texts(press?.query.from.language_code ?? language);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await ctx.store.getScene(sceneId);
    if (!row) return { text: t.sceneOver };
    if (row.status !== "active") {
      // A finished scene's last drawing may still be owed (Telegram asked for quiet then).
      if (row.dirty) await drawOwed(ctx, row.id);
      return { text: t.sceneOver };
    }
    // A redelivered update: this press was applied already.
    if (press && row.last_query === press.query.id) return { applied: true };
    // Before anything is drawn: stale and forged presses count against the limit too.
    if (attempt === 0 && limited(incoming)) {
      if (!(await allow(ctx.sceneLimit, `${sceneId}:${incoming.user.id}`))) {
        return { text: t.sceneTooFast };
      }
    }
    const owner = await ownerOf(ctx, row);
    const { compiled, state, messages } = loaded(row);

    if (press) {
      // Only a button on the message as drawn now counts: an old keyboard, or
      // callback_data made up by a client, changes nothing.
      const index = messages.findIndex((message) => message.id === press.messageId);
      if (row.chat_id !== press.chatId || index < 0) return { text: t.sceneStale };
      let current: Rendered;
      try {
        current = render(compiled, viewOf(row, messages, index), state, {
          owner,
          now: nowSeconds(),
          sceneId: row.id,
        });
      } catch {
        return { text: t.sceneFailed };
      }
      if (!onScreen(current, press)) return { text: t.sceneStale };
    }

    const event: SceneEvent = { ...incoming, now: nowSeconds(), owner };
    let found: ReturnType<typeof match>;
    try {
      found = match(compiled, state, event);
    } catch (error) {
      found = { refused: "broken", text: String(error) };
    }
    if ("refused" in found) {
      if (found.refused === "broken") {
        await recordError(ctx, row, event.user, "rule", found.text ?? "");
        return { text: t.sceneFailed };
      }
      if (found.refused === "not_for_you") {
        return { text: found.who === "owner" ? t.sceneNotForYou(owner.name) : t.sceneDenied };
      }
      if (found.refused === "no_rule") return { text: t.sceneDenied, noRule: true };
      return found.text ? { text: found.text, said: true } : { text: t.sceneDenied, said: true };
    }
    if (found.wakes && !wake.gate) {
      const gate = await gateWake(ctx, row, event.user, wake.source);
      if (!gate.ok) {
        if (gate.answer === "not_for_you") return { text: t.sceneNotForYou(owner.name) };
        if (gate.answer === "nobody") return { text: t.sceneNobody };
        if (gate.answer === "session") return { text: SESSION_REFUSAL };
        return { text: t.sceneResting(gate.minutes ?? 60) };
      }
      wake.gate = gate;
      wake.row = row;
    }

    let result: ReturnType<typeof run>;
    try {
      result = run(compiled, state, event, found.rule);
    } catch (error) {
      result = { refused: "broken", detail: String(error) };
    }
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
      patch.status !== undefined;
    let current = row;
    if (changed) {
      const next: SceneRow = { ...row, ...patch, state: JSON.stringify(result.state) };
      // The new state must draw; a screen Telegram would refuse is refused before anything is written.
      let drawn: Map<string, Rendered>;
      try {
        drawn = screens(next, owner);
      } catch (error) {
        if (error instanceof RenderError) return { text: t.sceneFull };
        await recordError(
          ctx,
          row,
          event.user,
          "view",
          String(error instanceof Error ? error.message : error),
        );
        return { text: t.sceneFailed };
      }
      const now = Date.now();
      // The last drawing of a finished scene does not wait its second; Telegram's quiet it does.
      const drawNow =
        (patch.status !== undefined || now - row.edited_at >= EDIT_GAP_MS) &&
        now >= row.quiet_until;
      patch.state = next.state;
      if (press) patch.last_query = press.query.id;
      if (drawNow) patch.edited_at = now;
      else patch.dirty = 1;
      if (!(await ctx.store.commitScene(row.id, row.version, patch))) continue;
      current = { ...next, ...patch, version: row.version + 1 };
      try {
        if (drawNow) await redraw(ctx, current, drawn);
        else later(ctx, row.id);
      } catch (error) {
        await afterCommit(ctx, current, event.user, error);
      }
    } else if (row.updated < nowSeconds() - TOUCH_AFTER) {
      await ctx.store.touchScene(row.id);
    }
    try {
      return {
        ...(await perform(ctx, current, event, result.effects, wake, press?.query.id)),
        applied: true,
      };
    } catch (error) {
      await afterCommit(ctx, current, event.user, error);
      return { applied: true };
    }
  }
  return { text: t.sceneFailed };
}

/** What the event asked for besides the state: answers now, the rest after the commit. */
async function perform(
  ctx: SceneContext,
  row: SceneRow,
  event: SceneEvent,
  effects: Effect[],
  wake: Wake,
  callbackId?: string,
): Promise<Answer> {
  let answer: Answer = {};
  const out = new Outbox(ctx, row);
  for (const effect of effects) {
    switch (effect.kind) {
      case "post":
      case "poll":
      case "close_poll":
      case "dice":
      case "tag":
      case "whisper":
        await out.send(effect, event, callbackId, wake.source);
        break;
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
      case "wake": {
        // One start per event: a second wake() in the same rule is only logged.
        const gate = wake.used ? null : wake.gate;
        const seq = await ctx.store.addSceneEvent(row.id, {
          name: effect.name,
          user_id: event.user.id,
          user_name: event.user.name,
          data: event.arg === undefined ? null : JSON.stringify({ arg: event.arg }),
          woke: gate !== null,
        });
        if (!gate) break;
        wake.used = true;
        await deliverWake(ctx, row, gate, { seq, name: effect.name, actor: event.user }).catch(
          async (error: unknown) => {
            console.error(JSON.stringify({ event: "scene_wake_failed", error: String(error) }));
            await ctx.store.endFire(row.chat_id, gate.fireId, { status: "failed" });
          },
        );
        break;
      }
      case "show":
      case "finish":
        break;
    }
  }
  return answer;
}

/** For the model, in update_scene's result: only the scene's own session may wake through act. */
const SESSION_REFUSAL =
  "wake() through act works only from the session that set the scene up: pass your session id as " +
  "`session`, and only on a scene that session created.";

/** Posts a minute per scene; a die counts as one. */
const POSTS_PER_MINUTE = 5;
/** Live messages a scene may have, the main one included. */
const LIVE_MESSAGES = 3;
const DICE_EVENT = "dice";

/**
 * The actions that talk to Telegram, carried out after the commit. What
 * Telegram refuses is recorded for the session to see; the state stays.
 * What they keep on the scene (posts, live messages, the poll) changes by
 * targeted statements, so concurrent events cannot overwrite each other.
 */
class Outbox {
  private readonly main: number | undefined;

  constructor(
    private readonly ctx: SceneContext,
    private readonly row: SceneRow,
  ) {
    this.main = loaded(row).messages[0]?.id;
  }

  private where(): Record<string, unknown> {
    return {
      chat_id: this.row.chat_id,
      ...(this.row.thread_id ? { message_thread_id: this.row.thread_id } : {}),
      ...(this.main
        ? { reply_parameters: { message_id: this.main, allow_sending_without_reply: true } }
        : {}),
    };
  }

  private async keep(message: Message, text: string): Promise<void> {
    const stored = toStored(message, this.ctx.bot);
    stored.outgoing = true;
    stored.mentions_bot = false;
    stored.text = text || stored.text;
    stored.sent_by = this.row.owner;
    stored.session_id = this.row.session_id;
    await this.ctx.store.insertMessage(stored, "always");
  }

  async send(
    effect: Effect,
    event: SceneEvent,
    callbackId: string | undefined,
    source: WakeSource | undefined,
  ): Promise<void> {
    try {
      await this.perform(effect, event, callbackId, source);
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      await recordError(this.ctx, this.row, event.user, effect.kind, error.description);
    }
  }

  private async perform(
    effect: Effect,
    event: SceneEvent,
    callbackId: string | undefined,
    source: WakeSource | undefined,
  ) {
    const refuse = (why: string) => recordError(this.ctx, this.row, event.user, effect.kind, why);
    const spend = () => this.ctx.store.spendScenePost(this.row.id, POSTS_PER_MINUTE);
    const overLimit = `at most ${POSTS_PER_MINUTE} posts a minute`;
    switch (effect.kind) {
      case "whisper": {
        // An ephemeral reply to the press (Bot API 10.4): only the presser sees it.
        if (!callbackId) return refuse("whisper() answers a press only");
        await this.ctx.api.call("sendMessage", {
          chat_id: this.row.chat_id,
          text: effect.text,
          ephemeral_message_parameters: { callback_query_id: callbackId },
        });
        return;
      }
      case "post": {
        if (effect.view && loaded(this.row).messages.length >= LIVE_MESSAGES) {
          return refuse(`a scene has at most ${LIVE_MESSAGES} live messages`);
        }
        if (!(await spend())) return refuse(overLimit);
        if (effect.view) {
          const sent = await sendView(this.ctx, this.row, effect.view, { replyTo: this.main });
          const entry = { id: sent.message_id, view: effect.view };
          if (!(await this.ctx.store.addLiveMessage(this.row.id, entry, LIVE_MESSAGES))) {
            // Another event took the last slot meanwhile: this one is taken back.
            await this.ctx.store.unlinkScene("message", `${this.row.chat_id}:${sent.message_id}`);
            await this.ctx.api
              .call("deleteMessage", { chat_id: this.row.chat_id, message_id: sent.message_id })
              .catch(() => undefined);
            return refuse(`a scene has at most ${LIVE_MESSAGES} live messages`);
          }
          return;
        }
        // Sent as written: a member's name in it must not become markup.
        const sent = await this.ctx.api.call<Message>("sendMessage", {
          ...this.where(),
          text: effect.text,
          link_preview_options: { is_disabled: true },
        });
        await this.keep(sent, effect.text ?? "");
        return;
      }
      case "poll": {
        // The slot is taken before the poll is sent: two events cannot both open one.
        const pending = JSON.stringify({ pending: `${Date.now()}-${Math.random()}` });
        if (!(await this.ctx.store.claimScenePoll(this.row.id, pending))) {
          return refuse("a scene has one open poll: close_poll() first");
        }
        let sent: Message & { poll?: { id: string } };
        try {
          if (!(await spend())) {
            await this.ctx.store.setScenePoll(this.row.id, pending, null);
            return refuse(overLimit);
          }
          sent = await this.ctx.api.call<Message & { poll?: { id: string } }>("sendPoll", {
            ...this.where(),
            question: effect.question,
            options: effect.options.map((option) => ({ text: option })),
            is_anonymous: effect.opts.anonymous === true,
            allows_multiple_answers: effect.opts.multiple === true,
          });
        } catch (error) {
          await this.ctx.store.setScenePoll(this.row.id, pending, null);
          throw error;
        }
        await this.keep(sent, `📊 ${effect.question}`);
        const poll = sent.poll?.id ? { message_id: sent.message_id, poll_id: sent.poll.id } : null;
        await this.ctx.store.setScenePoll(this.row.id, pending, poll ? JSON.stringify(poll) : null);
        if (poll) await this.ctx.store.linkScene("poll", poll.poll_id, this.row.id);
        return;
      }
      case "close_poll": {
        const open = (await this.ctx.store.getScene(this.row.id))?.poll ?? null;
        const poll = open ? (JSON.parse(open) as { message_id?: number; poll_id?: string }) : null;
        if (!open || !poll?.message_id || !poll.poll_id) return refuse("there is no open poll");
        // Cleared only once Telegram has stopped it; its votes stop reaching the scene.
        await this.ctx.api.call("stopPoll", {
          chat_id: this.row.chat_id,
          message_id: poll.message_id,
        });
        await this.ctx.store.setScenePoll(this.row.id, open, null);
        await this.ctx.store.unlinkScene("poll", poll.poll_id);
        return;
      }
      case "dice": {
        // A die's own event may not throw another: no chain of throws.
        if (event.on === DICE_EVENT) return refuse("a dice event cannot throw dice");
        if (!(await spend())) return refuse(overLimit);
        const sent = await this.ctx.api.call<Message & { dice?: { emoji: string; value: number } }>(
          "sendDice",
          { ...this.where(), emoji: effect.emoji },
        );
        if (sent.dice) {
          // The die's event stands where the throw did: a session's act stays a session's.
          await applyEvent(
            this.ctx,
            this.row.id,
            {
              on: DICE_EVENT,
              user: event.user,
              event: { value: sent.dice.value, emoji: sent.dice.emoji },
            },
            undefined,
            null,
            source,
          );
        }
        return;
      }
      case "tag":
        await this.ctx.api.call("setChatMemberTag", {
          chat_id: this.row.chat_id,
          user_id: effect.userId,
          tag: effect.text,
        });
        return;
    }
  }
}

/**
 * A failure the session should see in get_scene: an action Telegram refused,
 * a rule that broke. The same failure twice in a row is kept once.
 */
async function recordError(
  ctx: SceneContext,
  row: SceneRow,
  user: Actor | null,
  action: string,
  description: string,
): Promise<void> {
  const data = JSON.stringify({ action, description: description.slice(0, 300) });
  const [last] = await ctx.store.lastSceneEvents(row.id, 1);
  if (last?.name === "error" && last.data === data) return;
  await ctx.store.addSceneEvent(row.id, {
    name: "error",
    user_id: user?.id ?? null,
    user_name: user?.name ?? null,
    data,
  });
}

/** Draw what is owed, if nobody else is drawing it and Telegram allows it now. */
async function drawOwed(ctx: SceneContext, sceneId: number): Promise<boolean> {
  const row = await ctx.store.claimRedraw(sceneId, Date.now());
  if (!row) return false;
  await redraw(ctx, row);
  return true;
}

/**
 * An edit held back: one of those waiting draws, a little later. If Telegram
 * asked for quiet, it waits that out when it is short; a longer quiet is left
 * to the next event (or, for a finished scene, the daily run).
 */
function later(ctx: SceneContext, sceneId: number): void {
  const work = (async () => {
    let wait = sceneTiming.redrawDelayMs;
    for (let tries = 0; tries < 3; tries++) {
      await sleep(wait);
      if (await drawOwed(ctx, sceneId)) return;
      const row = await ctx.store.getScene(sceneId);
      if (!row?.dirty) return;
      const quiet = row.quiet_until - Date.now();
      if (quiet > QUIET_WAIT_MS) return;
      wait = Math.max(0, quiet) + 50;
    }
  })().catch((error: unknown) =>
    console.error(
      JSON.stringify({ event: "scene_redraw_failed", scene: sceneId, error: String(error) }),
    ),
  );
  if (ctx.defer) ctx.defer(work);
}

/** For the daily run: draw a finished scene whose last drawing is still owed. */
export async function drawFinished(ctx: SceneContext, sceneId: number): Promise<void> {
  await drawOwed(ctx, sceneId);
}

/**
 * Bring every live message of the scene up to its state, editing only those
 * whose text or buttons changed since they were last drawn. A finished scene
 * loses its buttons. `drawn`: the screens, when the caller rendered them already.
 */
async function redraw(
  ctx: SceneContext,
  row: SceneRow,
  drawn?: Map<string, Rendered>,
): Promise<void> {
  const owner = await ownerOf(ctx, row);
  const { messages } = loaded(row);
  const finished = row.status !== "active";
  const chat = { account_id: BOT_ACCOUNT, chat_id: row.chat_id };
  let current = drawn;
  if (!current) {
    try {
      current = screens(row, owner);
    } catch {
      return;
    }
  }
  for (const [index, message] of messages.entries()) {
    const rendered = current.get(viewOf(row, messages, index));
    if (!rendered) continue;
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
        // Everything is committed; the scene stays quiet and the edit is owed.
        await ctx.store.markSceneDrawn(row.id, {
          dirty: 1,
          quiet_until: Date.now() + (error.retryAfter ?? 30) * 1000,
        });
        return;
      }
      if (/message to edit not found|message can't be edited/i.test(error.description)) {
        if (index === 0) {
          // The main message is gone: no press can reach the scene any more.
          await ctx.store.finishScene(row.id);
          return;
        }
        // Another live message is gone: it leaves the list, and its slot is free.
        await ctx.store.dropLiveMessage(row.id, message.id);
        await ctx.store.unlinkScene("message", `${row.chat_id}:${message.id}`);
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

/**
 * The owner's session changes the state itself (update_scene): the fields
 * given replace those of the state. Null when it is done; otherwise why
 * the change was refused. It keeps to the edits' pace like any event.
 */
export async function mergeState(
  ctx: SceneContext,
  sceneId: number,
  fields: Record<string, Value>,
): Promise<string | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const row = await ctx.store.getScene(sceneId);
    if (!row || row.status !== "active") return "The scene is over.";
    const { state } = loaded(row);
    const unknown = Object.keys(fields).find((key) => !Object.hasOwn(state, key));
    if (unknown) return `"${unknown}" is not a field of the scene's state.`;
    const next = { ...state, ...fields };
    const size = new TextEncoder().encode(JSON.stringify(next)).byteLength;
    if (size > 8192) return `The state would be ${size} bytes; it holds 8192.`;
    const changed: SceneRow = { ...row, state: JSON.stringify(next) };
    let drawn: Map<string, Rendered>;
    try {
      drawn = screens(changed, await ownerOf(ctx, row));
    } catch (error) {
      if (error instanceof LangError) {
        return `The scene could not draw that state: ${error.message}`;
      }
      throw error;
    }
    const now = Date.now();
    const drawNow = now - row.edited_at >= EDIT_GAP_MS && now >= row.quiet_until;
    const patch: ScenePatch = {
      state: changed.state,
      ...(drawNow ? { edited_at: now } : { dirty: 1 }),
    };
    if (!(await ctx.store.commitScene(row.id, row.version, patch))) continue;
    if (drawNow) await redraw(ctx, { ...changed, ...patch, version: row.version + 1 }, drawn);
    else later(ctx, row.id);
    return null;
  }
  return "The scene kept changing under the update; try again.";
}

/** End the scene: no more events, and its messages lose their buttons (once Telegram allows). */
export async function endScene(ctx: SceneContext, sceneId: number): Promise<boolean> {
  const row = await ctx.store.getScene(sceneId);
  if (!row || row.status !== "active") return false;
  await ctx.store.finishScene(sceneId);
  if (Date.now() < row.quiet_until) {
    await ctx.store.markSceneDrawn(sceneId, { dirty: 1 });
    later(ctx, sceneId);
    return true;
  }
  await redraw(ctx, { ...row, status: "finished" });
  return true;
}

/** The text of a message, as a reply event carries it. */
const REPLY_LENGTH = 256;

/**
 * A message that replies to a scene's message: the scene's `reply` event. A
 * rule that takes it is the whole answer (no session starts); a rule that
 * refuses in its own words gets 👎 on the reply. Anything else — no rule took
 * it, the scene is over, too fast, a failure — is not the scene's: the
 * message goes its usual way, and may well be for Claude.
 */
export async function sceneReply(ctx: BotContext, message: Message): Promise<boolean> {
  const target = message.reply_to_message;
  const text = message.text ?? message.caption;
  if (!target || target.from?.id !== ctx.bot.id || !message.from || message.from.is_bot || !text) {
    return false;
  }
  const link = await ctx.store.sceneByLink("message", `${message.chat.id}:${target.message_id}`);
  if (!link) return false;
  const answer = await applyEvent(
    ctx,
    link.scene_id,
    {
      on: "reply",
      user: actorOf(message.from),
      event: { text: Array.from(text).slice(0, REPLY_LENGTH).join("") },
    },
    undefined,
    message.from.language_code,
  );
  if (!answer.applied && !answer.said) return false;
  if (answer.said) {
    await ctx.api
      .call("setMessageReaction", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reaction: [{ type: "emoji", emoji: "👎" }],
      })
      .catch(() => undefined);
  }
  return true;
}

/** A reaction on a scene's message: its `reaction` event. Nothing to answer. */
export async function sceneReaction(
  ctx: BotContext,
  chatId: number,
  messageId: number,
  user: User,
  emoji: string,
): Promise<void> {
  const link = await ctx.store.sceneByLink("message", `${chatId}:${messageId}`);
  if (!link) return;
  await applyEvent(ctx, link.scene_id, { on: "reaction", user: actorOf(user), event: { emoji } });
}

/** A vote in a scene's poll; anonymous votes name nobody and count for nothing. */
export async function sceneVote(ctx: BotContext, answer: PollAnswer): Promise<void> {
  if (!answer.user) return;
  const link = await ctx.store.sceneByLink("poll", answer.poll_id);
  if (!link) return;
  await applyEvent(ctx, link.scene_id, {
    on: "vote",
    user: actorOf(answer.user),
    event: { options: answer.option_ids },
  });
}

/** New totals of a scene's poll. */
export async function scenePoll(ctx: BotContext, poll: Poll): Promise<void> {
  const link = await ctx.store.sceneByLink("poll", poll.id);
  if (!link) return;
  await applyEvent(ctx, link.scene_id, {
    on: "poll",
    user: TELEGRAM,
    event: {
      total: poll.total_voter_count,
      counts: poll.options.map((option) => option.voter_count),
      closed: poll.is_closed,
    },
  });
}

/** Who stands behind an event no person caused, such as new poll totals. */
const TELEGRAM: Actor = { id: 0, name: "Telegram" };
