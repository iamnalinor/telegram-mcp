/**
 * The bot's menu in the private chat: one message whose inline buttons swap
 * the screen in place. `callback_data` is `m:<screen>` or `m:<screen>:<chat id>`:
 *
 *   m:main        what this is, and the user's Telegram ID
 *   m:groups      connected groups, a button each
 *   m:g:<id>      one group: what the assistant sees there, revoke
 *   m:rv:<id>     revoke that group, back to the list
 *   m:mem         memory: the chats that have one
 *   m:mv:<id>     one chat's memory (sent as a file when long)
 *   m:md:<id>     delete it: asks first; m:mdy:<id> does it
 *   m:mwipe       erase all memory: asks first; m:mwipey does it
 *   m:si          sign-ins, a sign-out button each
 *   m:sx:<id>     sign that one out
 *   m:out         sign out everywhere: asks first
 *   m:outyes      …and does it
 *   m:add         how to connect a group
 *   m:personal    personal chats through Telegram Business
 *   m:help        how it works, retention, commands
 *   m:as          the assistant: which provider answers, a screen for each;
 *                 m:ap:<kind> makes that one answer
 *   m:oa          OpenAI: the key, the models, a test; m:oaset asks for the key,
 *                 m:oawh shows the webhook's URL and whether its secret is set,
 *                 m:oam:<chat|task> picks a model and m:oan:<chat|task>:<n> sets it,
 *                 m:oatest starts a test session, m:oadm toggles the private chat,
 *                 m:oadel removes the key (asks first; m:oadely does it)
 *   m:cl          Claude on tag: the routine, if set
 *   m:clh         how to set the routine up; m:clp sends its prompt
 *   m:clset       asks for the trigger and token
 *   m:cltest      starts the routine once, as a check
 *   m:cldel       remove the routine: asks first; m:cldely does it
 *   m:cldm        Claude in the private chat: on or off
 *   m:rl          the relay that carries messages to sessions; m:rlnew sends a new
 *                 install command (new token), m:rloff turns it off
 *   m:gc:<id>     Claude in that group: on (taking it over from a holder who left) or off
 *   m:go:<id>     other members too: asks first; m:goy:<id> turns it on
 *   m:gl:<id>     their hourly limit: a picker; m:gn:<id>:<n> sets it, m:gk:<id> asks
 *                 for a number typed as a reply (see `takeLimitAnswer`)
 *   m:gs:<id>     the log of starts there
 *   m:sc:<chat>   the user's running scenes in a chat (a group, or their private chat)
 *   m:sv:<id>     one scene; m:sw / m:swn / m:swk its wakes an hour as for a limit,
 *                 m:ss stops it
 *   m:gq          guest chats: where the bot was called without being a member
 *   m:q:<n>       one of them; m:qo / m:qoy / m:ql / m:qn / m:qk / m:qs as for a group,
 *                 m:qx lets it go
 *
 * Every press is checked again: anyone can send any callback_data.
 */

import { nowSeconds } from "../crypto";
import { formatTime } from "../format";
import { isAllowed } from "../env";
import { loadOpenAI, MODELS, saveOpenAI } from "../agents/openai";
import { relayState, relayToken, tokenHash } from "../relay";
import { routinePrompt, tokenOf } from "../routine";
import { GUEST_BASE, type SceneRow } from "../store";
import { memoryTitle } from "../tools/memory";
import { TelegramError } from "../telegram/api";
import type { CallbackQuery, InlineKeyboardMarkup, Message, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { fallBack } from "./fallback";
import { OPENAI_WEBHOOK_PATH } from "./openaiWebhook";
import { testOpenAI, testRoutine } from "./routine";
import { endScene, revokeAccess, signOutAll } from "./scenes";
import { holderName, stillMember } from "./triggers";
import { escapeHtml, formatDate, sessionRef, texts } from "./texts";

export interface Screen {
  text: string;
  reply_markup: InlineKeyboardMarkup;
}

const button = (text: string, screen: string) => ({ text, callback_data: `m:${screen}` });

/** The link that opens Telegram's own group picker to add the bot. */
export function addToGroupUrl(ctx: BotContext): string {
  return `https://t.me/${ctx.bot.username}?startgroup=connect`;
}

export async function mainScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  if (!(await hasConnected(ctx, user.id))) {
    return {
      text: `${t.menuIntro(user.id)}\n\n${t.menuNotConnected}`,
      reply_markup: { inline_keyboard: [[button(t.buttonHelp, "help")]] },
    };
  }
  return {
    text: t.menuIntro(user.id),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonGroups, "groups"), button(t.buttonAdd, "add")],
        [button(t.buttonMemory, "mem"), button(t.buttonSignIns, "si")],
        [button(t.buttonRoutine, "as"), button(t.buttonPersonal, "personal")],
        [button(t.buttonHelp, "help")],
      ],
    },
  };
}

async function groupsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const back = [button(t.buttonBack, "main")];
  const grants = await ctx.store.listGrants(user.id);
  const claude = grants.length
    ? await ctx.store.claudeChatsOf(user.id)
    : new Map<number, boolean>();
  // 🤖 Claude answers there for this user; ⚠️ for the other members too.
  const mark = (chatId: number) =>
    claude.has(chatId) ? (claude.get(chatId) ? "🤖⚠️ " : "🤖 ") : "";
  if (!grants.length) {
    return {
      text: t.noGroupsMenu,
      reply_markup: { inline_keyboard: [[button(t.buttonAdd, "add")], back] },
    };
  }
  const lines = grants.map((grant) =>
    t.groupLine({
      mark: mark(grant.chat_id),
      title: grant.title ?? String(grant.chat_id),
      full: grant.visible_from === 0,
      since: formatDate(grant.visible_from),
    }),
  );
  return {
    text: [t.groupsHeader, ...lines].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...grants.map((grant) => [
          button(
            mark(grant.chat_id) +
              Array.from(grant.title ?? String(grant.chat_id))
                .slice(0, 60)
                .join(""),
            `g:${grant.chat_id}`,
          ),
        ]),
        back,
      ],
    },
  };
}

/** The title of a chat whose memory the user may see, or null when it is not theirs. */
async function memoryChatTitle(
  ctx: BotContext,
  user: User,
  chatId: number,
): Promise<string | null> {
  const t = texts(user.language_code);
  if (chatId === user.id) return t.memoryOfMe;
  const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === chatId);
  return grant ? memoryTitle({ kind: "group", title: grant.title }, t.memoryOfMe) : null;
}

async function memoryListScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const docs = await ctx.store.listMemory(user.id);
  const titled = await Promise.all(
    docs.map(async (doc) => ({ ...doc, title: await memoryChatTitle(ctx, user, doc.chat_id) })),
  );
  const shown = titled.filter((doc) => doc.title !== null);
  return {
    text: t.memoryListScreen(
      shown.map((doc) =>
        t.memoryLine({ chat: doc.title!, size: doc.length, date: formatDate(doc.updated_at) }),
      ),
    ),
    reply_markup: {
      inline_keyboard: [
        ...shown.map((doc) => [
          button(Array.from(doc.title!).slice(0, 60).join(""), `mv:${doc.chat_id}`),
        ]),
        ...(shown.length ? [[button(t.buttonWipe, "mwipe")]] : []),
        [button(t.buttonBack, "main")],
      ],
    },
  };
}

/** Memory whose screen would be longer than this goes as a file: a message holds 4096. */
const MEMORY_INLINE = 3900;

async function memoryScreen(
  ctx: BotContext,
  user: User,
  chatId: number,
  title: string,
): Promise<Screen> {
  const t = texts(user.language_code);
  const doc = await ctx.store.getMemory(user.id, chatId);
  const back = [button(t.buttonBack, "mem")];
  if (!doc) return { text: t.memoryNone(title), reply_markup: { inline_keyboard: [back] } };
  let shown = t.memoryDoc({ chat: title, content: doc.content });
  if (shown.length > MEMORY_INLINE) {
    await ctx.api.upload(
      "sendDocument",
      { chat_id: user.id, disable_notification: true },
      "document",
      new Blob([doc.content], { type: "text/markdown" }),
      `memory-${chatId}.md`,
    );
    shown = t.memoryAsFile(title);
  }
  return {
    text: shown,
    reply_markup: { inline_keyboard: [[button(t.buttonDelete, `md:${chatId}`)], back] },
  };
}

async function signInsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const signIns = await ctx.store.listSignIns(user.id);
  const name = (client: string | null) => client ?? t.unknownClient;
  const lines = signIns.map((row) =>
    t.signInLine({
      client: name(row.client_name),
      since: row.created_at ? formatDate(row.created_at) : null,
      seen: formatDate(row.rotated_at),
    }),
  );
  return {
    text: t.signInsScreen(lines),
    reply_markup: {
      inline_keyboard: [
        ...signIns.map((row) => [
          button(
            Array.from(t.signOutButton(name(row.client_name)))
              .slice(0, 60)
              .join(""),
            `sx:${row.id}`,
          ),
        ]),
        ...(signIns.length ? [[button(t.buttonSignOutAll, "out")]] : []),
        [button(t.buttonBack, "main")],
      ],
    },
  };
}

/** The routine's prompt, in one block to tap and copy: it is kept short enough for one message. */
async function sendPrompt(ctx: BotContext, user: User, intro: string): Promise<void> {
  await ctx.api.call("sendMessage", {
    chat_id: user.id,
    text: `${intro}\n<pre>${escapeHtml(routinePrompt(user.username ?? null))}</pre>`,
    parse_mode: "HTML",
  });
}

/** Whether the routine is set, and whether its token still opens. */
async function routineState(ctx: BotContext, userId: number) {
  const row = await ctx.store.getRoutine(userId);
  const state: "none" | "set" | "broken" = !row
    ? "none"
    : (await tokenOf(ctx.config.secretKey, row)) === null
      ? "broken"
      : "set";
  return { row, state };
}

const PROVIDER_NAMES = { claude: "Claude", openai: "OpenAI" } as const;

/** Which provider answers, and a way into each one's own screen. */
async function assistantScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const active =
    (await ctx.store.getUser(user.id))?.active_provider === "openai" ? "openai" : "claude";
  const openai = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
  const row = (kind: "claude" | "openai") => [
    button(t.buttonUse(PROVIDER_NAMES[kind], kind === active), `ap:${kind}`),
    button(t.buttonSettings(PROVIDER_NAMES[kind]), kind === "claude" ? "cl" : "oa"),
  ];
  return {
    text: t.assistantScreen({
      active,
      claude: (await routineState(ctx, user.id)).state,
      openai: typeof openai === "string" ? openai : "set",
    }),
    reply_markup: {
      inline_keyboard: [row("claude"), row("openai"), [button(t.buttonBack, "main")]],
    },
  };
}

async function openaiScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
  const set = typeof config !== "string";
  const since = set ? await ctx.store.agentConfigSince(user.id, "openai") : null;
  const here = (await ctx.store.getClaudeChat(user.id))?.user_id === user.id;
  return {
    text: t.openaiScreen({
      state: set ? "set" : config,
      chatModel: set ? config.chatModel : MODELS[0],
      taskModel: set ? config.taskModel : MODELS[1],
      since: since === null ? undefined : formatDate(since),
      hooked: set && !!config.webhookSecret,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonOpenAIKey, "oaset")],
        ...(set
          ? [
              [button(t.buttonChatModel(config.chatModel), "oam:chat")],
              [button(t.buttonTaskModel(config.taskModel), "oam:task")],
              [button(t.buttonWebhook, "oawh")],
              [button(t.claudeHere(here), "oadm"), button(t.buttonTestRoutine, "oatest")],
              [button(t.buttonGuestChats, "gq")],
            ]
          : []),
        ...(config !== "none" ? [[button(t.buttonDeleteRoutine, "oadel")]] : []),
        [button(t.buttonBack, "as")],
      ],
    },
  };
}

/** Pick the model for chat or for tasks; the current one ticked. */
function modelPicker(user: User, kind: "chat" | "task", current: string): Screen {
  const t = texts(user.language_code);
  return {
    text: t.modelPicker(kind),
    reply_markup: {
      inline_keyboard: [
        ...MODELS.map((model, n) => [
          button(model === current ? `✓ ${model}` : model, `oan:${kind}:${n}`),
        ]),
        [button(t.buttonBack, "oa")],
      ],
    },
  };
}

/** Nothing left to start for the user: the chats they hold go, as when the routine went. */
async function dropIfNoAssistant(ctx: BotContext, userId: number): Promise<void> {
  if (!(await ctx.store.hasAssistant(userId))) await ctx.store.dropClaudeChats(userId);
}

async function routineScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const { row, state } = await routineState(ctx, user.id);
  const here = (await ctx.store.getClaudeChat(user.id))?.user_id === user.id;
  const scenes = (await ctx.store.scenesOf(user.id, user.id)).length;
  let test = "";
  // A day on, the test says nothing new — and its answer may be purged with the messages.
  if (state === "set" && row?.test_session && row.test_at && nowSeconds() - row.test_at < 86_400) {
    const answered = await ctx.store.sessionSpokeIn(user.id, row.test_session, row.test_at);
    const at = formatDate(row.test_at);
    test = `\n\n${answered ? t.testPassed(at) : t.testWaiting(at)}`;
  }
  return {
    text:
      t.routineScreen({
        state,
        trigger: row?.trigger_id,
        since: row ? formatDate(row.updated_at) : undefined,
      }) +
      test +
      (state === "set" ? `\n\n${t.claudeHereHint}` : ""),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonGuide, "clh"), button(t.buttonSetRoutine, "clset")],
        ...(state === "set"
          ? [[button(t.claudeHere(here), "cldm"), button(t.buttonTestRoutine, "cltest")]]
          : []),
        ...(state === "set"
          ? [[button(t.buttonRelay(relayState(await ctx.store.getRelay(user.id))), "rl")]]
          : []),
        ...(state === "set" ? [[button(t.buttonGuestChats, "gq")]] : []),
        ...(scenes ? [[button(t.buttonScenes(scenes), `sc:${user.id}`)]] : []),
        ...(row ? [[button(t.buttonDeleteRoutine, "cldel")]] : []),
        [button(t.buttonBack, "as")],
      ],
    },
  };
}

async function relayScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const row = await ctx.store.getRelay(user.id);
  return {
    text: t.relayScreen({
      state: relayState(row),
      seen: row?.last_seen ? formatDate(row.last_seen) : null,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonRelayInstall, "rlnew")],
        ...(row ? [[button(t.buttonRelayOff, "rloff")]] : []),
        [button(t.buttonBack, "cl")],
      ],
    },
  };
}

function guideScreen(user: User): Screen {
  const t = texts(user.language_code);
  return {
    text: t.routineGuide,
    reply_markup: {
      inline_keyboard: [
        [{ text: t.buttonOpenRoutines, url: "https://claude.ai/code/routines" }],
        [button(t.buttonSendPrompt, "clp"), button(t.buttonSetRoutine, "clset")],
        [button(t.buttonBack, "cl")],
      ],
    },
  };
}

/** Hourly limits offered by a press; any other number from LIMIT_MIN to LIMIT_MAX is typed. */
const LIMIT_PRESETS = [5, 20, 50, 100];
const LIMIT_MIN = 1;
const LIMIT_MAX = 500;

/**
 * Pick an hourly limit: the presets (the current one ticked), a number of
 * one's own, or back. `set(n)` and `custom` are the screens those go to.
 */
function limitPicker(
  t: ReturnType<typeof texts>,
  subject: string,
  current: number,
  back: string,
  set: (n: number) => string,
  custom: string,
): Screen {
  return {
    text: t.limitPickerTitle(subject, current),
    reply_markup: {
      inline_keyboard: [
        LIMIT_PRESETS.map((n) => button(n === current ? `✓ ${n}` : String(n), set(n))),
        [button(t.limitPickerCustom, custom)],
        [button(t.buttonBack, back)],
      ],
    },
  };
}

/** A limit typed or pressed, if it is one the menu takes. */
function limitOf(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= LIMIT_MIN && n <= LIMIT_MAX ? n : null;
}

/** Ask for a number as a reply; the answer comes back through `takeLimitAnswer`. */
async function askLimit(ctx: BotContext, user: User, target: string, subject: string) {
  const t = texts(user.language_code);
  const sent = await ctx.api.call<Message>("sendMessage", {
    chat_id: user.id,
    text: t.limitPrompt(subject),
    parse_mode: "HTML",
    reply_markup: { force_reply: true, input_field_placeholder: `${LIMIT_MIN}–${LIMIT_MAX}` },
  });
  await ctx.store.setLimitPrompt(user.id, target, sent.message_id);
}

async function groupScreen(
  ctx: BotContext,
  user: User,
  grant: { chat_id: number; title: string | null; visible_from: number },
): Promise<Screen> {
  const t = texts(user.language_code);
  const chatId = grant.chat_id;
  const claim = await ctx.store.getClaudeChat(chatId);
  const on = claim?.user_id === user.id;
  const heldBy = claim && !on ? await holderName(ctx, claim.user_id) : null;
  // With privacy mode on, a group where the bot is no admin shows it only mentions and replies.
  const blind = on && !ctx.bot.canReadAll && !(await ctx.store.getChat(chatId))?.bot_is_admin;
  const scenes = (await ctx.store.scenesOf(user.id, chatId)).length;
  return {
    text:
      t.groupScreen({
        title: grant.title ?? String(chatId),
        full: grant.visible_from === 0,
        since: formatDate(grant.visible_from),
      }) +
      t.groupClaude({
        on,
        others: on && claim.others === 1,
        limit: claim?.others_limit ?? 0,
        heldBy,
      }) +
      (blind ? `\n${t.privacyHint}` : ""),
    reply_markup: {
      inline_keyboard: [
        [button(t.claudeToggle(on), `gc:${chatId}`)],
        ...(on ? [[button(t.othersToggle(claim.others === 1), `go:${chatId}`)]] : []),
        ...(on && claim.others === 1
          ? [[button(t.othersLimitButton(claim.others_limit), `gl:${chatId}`)]]
          : []),
        ...(on ? [[button(t.startsButton, `gs:${chatId}`)]] : []),
        ...(scenes ? [[button(t.buttonScenes(scenes), `sc:${chatId}`)]] : []),
        [button(t.buttonChatMemory, `mv:${chatId}`)],
        [button(t.buttonRevoke, `rv:${chatId}`)],
        [button(t.buttonBack, "groups")],
      ],
    },
  };
}

const STARTS_SHOWN = 15;
const STARTS_MARK = {
  pending: "⏳",
  started: "▶️",
  relayed: "↪️",
  joined: "➕",
  failed: "⚠️",
} as const;

/** The holder's latest starts in a group: who, when, the first words, the session. */
async function startsScreen(
  ctx: BotContext,
  user: User,
  chatId: number,
  title: string,
  back = `g:${chatId}`,
): Promise<Screen> {
  const t = texts(user.language_code);
  const { fires, limited } = await ctx.store.firesIn(
    user.id,
    chatId,
    STARTS_SHOWN,
    nowSeconds() - 86_400,
  );
  const lines = fires.map(
    (fire) =>
      `${STARTS_MARK[fire.status]} ${formatTime(fire.at).slice(5)} ${escapeHtml(fire.from_name ?? "?")}` +
      (fire.excerpt ? `: «${escapeHtml(fire.excerpt)}»` : "") +
      (fire.session_id ? ` — ${sessionRef(fire.session_id, t.startsSession)}` : ""),
  );
  return {
    text:
      (lines.length ? t.startsScreen(title, lines) : t.startsEmpty(title)) +
      (limited ? `\n\n${t.startsLimited(limited)}` : ""),
    reply_markup: { inline_keyboard: [[button(t.buttonBack, back)]] },
  };
}

/** Where a chat's scenes are listed from: the group's screen, or Claude's for the private chat. */
const chatBack = (user: User, chatId: number) => (chatId === user.id ? "cl" : `g:${chatId}`);

async function chatTitle(ctx: BotContext, user: User, chatId: number): Promise<string> {
  if (chatId === user.id) return texts(user.language_code).memoryOfMe;
  return (await ctx.store.getChat(chatId))?.title ?? String(chatId);
}

async function scenesScreen(ctx: BotContext, user: User, chatId: number): Promise<Screen> {
  const t = texts(user.language_code);
  const scenes = await ctx.store.scenesOf(user.id, chatId);
  return {
    text: t.scenesScreen(
      await chatTitle(ctx, user, chatId),
      scenes.map((scene) => `▶ ${escapeHtml(scene.title)}`),
    ),
    reply_markup: {
      inline_keyboard: [
        ...scenes.map((scene) => [
          button(`▶ ${Array.from(scene.title).slice(0, 50).join("")}`, `sv:${scene.id}`),
        ]),
        [button(t.buttonBack, chatBack(user, chatId))],
      ],
    },
  };
}

async function sceneScreen(ctx: BotContext, user: User, scene: SceneRow): Promise<Screen> {
  const t = texts(user.language_code);
  const wakes = await ctx.store.sceneWakes(scene.owner, scene.id, nowSeconds() - 3600);
  return {
    text: t.sceneScreen({
      title: scene.title,
      session: scene.session_id,
      events: await ctx.store.sceneEventCount(scene.id),
      wakes: wakes.n,
      limit: scene.wake_limit,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonSceneWakes(scene.wake_limit), `sw:${scene.id}`)],
        [button(t.buttonStopScene, `ss:${scene.id}`)],
        [button(t.buttonBack, `sc:${scene.chat_id}`)],
      ],
    },
  };
}

/** The chats this user holds as a guest: called there by a tag, never a member. */
async function guestChatsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const chats = await ctx.store.guestChatsOf(user.id);
  const name = (chat: { title: string | null; id: number }) => chat.title ?? `#${chat.id}`;
  return {
    text: t.guestChatsScreen(
      chats.map((chat) => `${chat.others ? "🤖⚠️" : "🤖"} ${escapeHtml(name(chat))}`),
    ),
    reply_markup: {
      inline_keyboard: [
        ...chats.map((chat) => [button(name(chat), `q:${chat.id}`)]),
        [button(t.buttonBack, "cl")],
      ],
    },
  };
}

function guestChatScreen(
  user: User,
  chat: { id: number; title: string | null },
  claim: { others: number; others_limit: number },
): Screen {
  const t = texts(user.language_code);
  return {
    text: t.guestChatScreen({
      title: chat.title ?? `#${chat.id}`,
      others: claim.others === 1,
      limit: claim.others_limit,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.othersToggle(claim.others === 1), `qo:${chat.id}`)],
        ...(claim.others === 1
          ? [[button(t.othersLimitButton(claim.others_limit), `ql:${chat.id}`)]]
          : []),
        [button(t.startsButton, `qs:${chat.id}`)],
        [button(t.buttonGuestRelease, `qx:${chat.id}`)],
        [button(t.buttonBack, "gq")],
      ],
    },
  };
}

/**
 * Turn Claude on or off in a group. Whoever turned it on first holds the
 * chat; a holder Telegram says has left loses it to whoever asks next.
 */
async function toggleClaude(
  ctx: BotContext,
  user: User,
  chatId: number,
  claim: { user_id: number } | null,
): Promise<string | undefined> {
  const t = texts(user.language_code);
  if (claim?.user_id === user.id) {
    await ctx.store.releaseClaudeChat(user.id, chatId);
    return undefined;
  }
  if (!(await ctx.store.hasAssistant(user.id))) return t.routineFirst;
  if (claim) {
    if ((await stillMember(ctx, chatId, claim.user_id)) !== false) return t.chatHeld;
    await revokeAccess(ctx, claim.user_id, chatId);
  }
  return (await ctx.store.claimClaudeChat(user.id, chatId)) ? undefined : t.chatHeld;
}

function staticScreen(text: string, back: string, user: User): Screen {
  return {
    text,
    reply_markup: { inline_keyboard: [[button(texts(user.language_code).buttonBack, back)]] },
  };
}

/** The screen for `name`, and a short note to show with it. */
async function render(
  ctx: BotContext,
  user: User,
  name: string,
): Promise<Screen & { note?: string }> {
  const t = texts(user.language_code);
  const connected = await hasConnected(ctx, user.id);
  if (name === "help") {
    return staticScreen(
      t.helpScreen({ retention: ctx.config.retentionDays, privacyOn: !ctx.bot.canReadAll }),
      "main",
      user,
    );
  }
  if (!connected) return mainScreen(ctx, user);

  if (name === "groups") return groupsScreen(ctx, user);
  if (name === "si") return signInsScreen(ctx, user);
  if (name === "mem") return memoryListScreen(ctx, user);
  if (name === "mwipe") {
    return {
      text: t.confirmWipe,
      reply_markup: {
        inline_keyboard: [[button(t.buttonConfirmWipe, "mwipey")], [button(t.buttonCancel, "mem")]],
      },
    };
  }
  if (name === "mwipey") {
    await ctx.store.wipeMemory(user.id);
    return { ...(await memoryListScreen(ctx, user)), note: t.memoryWiped };
  }
  const memory = /^(mv|md|mdy):(-?\d+)$/.exec(name);
  if (memory) {
    const chatId = Number(memory[2]);
    const title = await memoryChatTitle(ctx, user, chatId);
    if (title === null) return { ...(await memoryListScreen(ctx, user)), note: t.menuGone };
    if (memory[1] === "md") {
      return {
        text: t.confirmDeleteMemory(title),
        reply_markup: {
          inline_keyboard: [
            [button(t.buttonConfirmDelete, `mdy:${chatId}`)],
            [button(t.buttonCancel, `mv:${chatId}`)],
          ],
        },
      };
    }
    if (memory[1] === "mdy") {
      await ctx.store.deleteMemory(user.id, chatId);
      return { ...(await memoryListScreen(ctx, user)), note: t.memoryDeleted };
    }
    return memoryScreen(ctx, user, chatId, title);
  }
  if (name === "out") {
    return {
      text: t.confirmSignOutAll,
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonConfirmSignOut, "outyes")],
          [button(t.buttonCancel, "si")],
        ],
      },
    };
  }
  if (name === "outyes") {
    await signOutAll(ctx, user.id);
    return { ...(await signInsScreen(ctx, user)), note: t.disconnected };
  }
  // Ids are 16 characters, or 43 for sign-ins from before rotation (a token hash).
  const signOut = /^sx:([\w-]{1,43})$/.exec(name);
  if (signOut) {
    const done = await ctx.store.revokeSignIn(user.id, signOut[1]);
    return {
      ...(await signInsScreen(ctx, user)),
      note: done ? t.signedOut : t.alreadySignedOut,
    };
  }
  if (name === "personal") return staticScreen(t.personalScreen, "main", user);
  if (name === "cl") return routineScreen(ctx, user);
  if (name === "clh") return guideScreen(user);
  if (name === "clp") {
    await sendPrompt(ctx, user, t.routinePromptIntro);
    return { ...guideScreen(user), note: t.promptSent };
  }
  if (name === "clset") {
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: t.setRoutineAsk,
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "trig_… sk-ant-oat01-…" },
    });
    return { ...(await routineScreen(ctx, user)), note: t.setRoutineNote };
  }
  if (name === "cldm" || name === "oadm") {
    const claim = await ctx.store.getClaudeChat(user.id);
    if (claim) await ctx.store.releaseClaudeChat(user.id, user.id);
    else if (await ctx.store.hasAssistant(user.id)) {
      await ctx.store.claimClaudeChat(user.id, user.id);
    }
    return name === "cldm" ? routineScreen(ctx, user) : openaiScreen(ctx, user);
  }
  if (name === "as") return assistantScreen(ctx, user);
  const choose = /^ap:(claude|openai)$/.exec(name);
  if (choose) {
    const kind = choose[1] as "claude" | "openai";
    const ready =
      kind === "claude"
        ? (await routineState(ctx, user.id)).state === "set"
        : typeof (await loadOpenAI(ctx.store, ctx.config.secretKey, user.id)) !== "string";
    if (!ready) {
      return { ...(await assistantScreen(ctx, user)), note: t.providerFirst(PROVIDER_NAMES[kind]) };
    }
    // The other one's settings stay: switching back needs nothing sent again.
    await ctx.store.setActiveProvider(user.id, kind === "claude" ? null : kind);
    return {
      ...(await assistantScreen(ctx, user)),
      note: t.providerChosen(PROVIDER_NAMES[kind]),
    };
  }
  if (name === "oa") return openaiScreen(ctx, user);
  if (name === "oawh") {
    let config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
    if (typeof config === "string") return openaiScreen(ctx, user);
    // Settings saved before webhooks existed get their address now.
    if (!config.webhookPath)
      config = await saveOpenAI(ctx.store, ctx.config.secretKey, user.id, config);
    return {
      text: t.webhookScreen(
        `${ctx.origin}${OPENAI_WEBHOOK_PATH}${config.webhookPath}`,
        !!config.webhookSecret,
      ),
      reply_markup: { inline_keyboard: [[button(t.buttonBack, "oa")]] },
    };
  }
  if (name === "oaset") {
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: t.openaiKeyAsk,
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "sk-proj-…" },
    });
    return { ...(await openaiScreen(ctx, user)), note: t.openaiKeyNote };
  }
  const model = /^(oam|oan):(chat|task)(?::(\d))?$/.exec(name);
  if (model) {
    const kind = model[2] as "chat" | "task";
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, user.id);
    if (typeof config === "string") return openaiScreen(ctx, user);
    const field = kind === "chat" ? "chatModel" : "taskModel";
    if (model[1] === "oam") return modelPicker(user, kind, config[field]);
    const picked = MODELS[Number(model[3])];
    if (!picked) return openaiScreen(ctx, user);
    await saveOpenAI(ctx.store, ctx.config.secretKey, user.id, { ...config, [field]: picked });
    return { ...(await openaiScreen(ctx, user)), note: t.modelSet };
  }
  if (name === "oatest") {
    await testOpenAI(ctx, user, 0);
    return openaiScreen(ctx, user);
  }
  if (name === "oadel") {
    return {
      text: t.confirmDeleteOpenAI,
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonConfirmRemove, "oadely")],
          [button(t.buttonCancel, "oa")],
        ],
      },
    };
  }
  if (name === "oadely") {
    await ctx.store.deleteAgentConfig(user.id, "openai");
    // Claude answers again, if it is set up; if nothing is, the chats held go.
    await ctx.store.setActiveProvider(user.id, null);
    await dropIfNoAssistant(ctx, user.id);
    return { ...(await openaiScreen(ctx, user)), note: t.routineDeleted };
  }
  if (name === "rl") return relayScreen(ctx, user);
  if (name === "rlnew") {
    const token = relayToken();
    await ctx.store.setRelay(user.id, await tokenHash(token));
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: t.relayInstall(`curl -fsSL ${ctx.origin}/relay/install.sh | RELAY_TOKEN=${token} bash`),
      parse_mode: "HTML",
    });
    return relayScreen(ctx, user);
  }
  if (name === "rloff") {
    // Replies it had not passed on yet start sessions instead of getting lost.
    for (const job of await ctx.store.deleteRelay(user.id)) await fallBack(ctx, job, "failed");
    return { ...(await relayScreen(ctx, user)), note: t.relayOff };
  }
  if (name === "cltest") {
    await testRoutine(ctx, user, 0);
    return routineScreen(ctx, user);
  }
  if (name === "cldel") {
    return {
      text: t.confirmDeleteRoutine,
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonConfirmRemove, "cldely")],
          [button(t.buttonCancel, "cl")],
        ],
      },
    };
  }
  if (name === "cldely") {
    await ctx.store.deleteRoutine(user.id);
    // With OpenAI set up, it answers from now on.
    if (typeof (await loadOpenAI(ctx.store, ctx.config.secretKey, user.id)) !== "string") {
      await ctx.store.setActiveProvider(user.id, "openai");
    }
    // Otherwise nothing would start in them any more, and others could not turn Claude on there.
    await dropIfNoAssistant(ctx, user.id);
    return { ...(await routineScreen(ctx, user)), note: t.routineDeleted };
  }
  if (name === "add") {
    return {
      text: t.addScreen(ctx.bot.username),
      reply_markup: {
        inline_keyboard: [
          [{ text: t.buttonAddToGroup, url: addToGroupUrl(ctx) }],
          [button(t.buttonBack, "main")],
        ],
      },
    };
  }

  const list = /^sc:(-?\d+)$/.exec(name);
  if (list) {
    const chatId = Number(list[1]);
    if (chatId !== user.id && !(await ctx.store.getGrant(user.id, chatId)))
      return mainScreen(ctx, user);
    return scenesScreen(ctx, user, chatId);
  }
  const sceneMenu = /^(sv|sw|swn|swk|ss):(\d{1,15})(?::(\d{1,4}))?$/.exec(name);
  if (sceneMenu) {
    const scene = await ctx.store.getScene(Number(sceneMenu[2]));
    // Only one's own running scenes; anything else is gone as far as this menu goes.
    if (!scene || scene.owner !== user.id || scene.status !== "active") {
      return { ...(await mainScreen(ctx, user)), note: t.menuGone };
    }
    if (sceneMenu[1] === "ss") {
      await endScene(ctx, scene.id);
      return { ...(await scenesScreen(ctx, user, scene.chat_id)), note: t.sceneStopped };
    }
    if (sceneMenu[1] === "sw") {
      return limitPicker(
        t,
        scene.title,
        scene.wake_limit,
        `sv:${scene.id}`,
        (n) => `swn:${scene.id}:${n}`,
        `swk:${scene.id}`,
      );
    }
    if (sceneMenu[1] === "swk") await askLimit(ctx, user, `s:${scene.id}`, scene.title);
    const preset = sceneMenu[1] === "swn" ? limitOf(sceneMenu[3] ?? "") : null;
    if (preset !== null && LIMIT_PRESETS.includes(preset)) {
      await ctx.store.setSceneWakeLimit(user.id, scene.id, preset);
      return sceneScreen(ctx, user, { ...scene, wake_limit: preset });
    }
    return sceneScreen(ctx, user, scene);
  }

  if (name === "gq") return guestChatsScreen(ctx, user);
  const guest = /^(q|qo|qoy|ql|qn|qk|qs|qx):(\d{1,12})(?::(\d{1,4}))?$/.exec(name);
  if (guest) {
    const key = GUEST_BASE + Number(guest[2]);
    const chat = await ctx.store.guestChatByKey(key);
    let claim = await ctx.store.getClaudeChat(key);
    // Not theirs (any more): the list, not someone else's chat.
    if (!chat || claim?.user_id !== user.id) {
      return { ...(await guestChatsScreen(ctx, user)), note: t.menuGone };
    }
    const title = chat.title ?? `#${chat.id}`;
    if (guest[1] === "qx") {
      await ctx.store.releaseClaudeChat(user.id, key);
      return { ...(await guestChatsScreen(ctx, user)), note: t.guestReleased };
    }
    if (guest[1] === "qs") return startsScreen(ctx, user, key, title, `q:${chat.id}`);
    if (guest[1] === "qo") {
      if (!claim.others) {
        return {
          text: t.othersWarning(title),
          reply_markup: {
            inline_keyboard: [
              [button(t.buttonTurnOn, `qoy:${chat.id}`)],
              [button(t.buttonCancel, `q:${chat.id}`)],
            ],
          },
        };
      }
      await ctx.store.setClaudeOthers(user.id, key, false);
    }
    if (guest[1] === "qoy") await ctx.store.setClaudeOthers(user.id, key, true);
    if (guest[1] === "ql") {
      return limitPicker(
        t,
        title,
        claim.others_limit,
        `q:${chat.id}`,
        (n) => `qn:${chat.id}:${n}`,
        `qk:${chat.id}`,
      );
    }
    if (guest[1] === "qk") {
      await askLimit(ctx, user, `q:${key}`, title);
      return guestChatScreen(user, chat, claim);
    }
    const preset = guest[1] === "qn" ? limitOf(guest[3] ?? "") : null;
    if (preset !== null && LIMIT_PRESETS.includes(preset)) {
      await ctx.store.setClaudeOthersLimit(user.id, key, preset);
    }
    claim = (await ctx.store.getClaudeChat(key)) ?? claim;
    return guestChatScreen(user, chat, claim);
  }

  const group = /^(g|rv|gc|go|goy|gl|gn|gk|gs):(-?\d+)(?::(\d{1,4}))?$/.exec(name);
  if (group) {
    const chatId = Number(group[2]);
    const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === chatId);
    // Gone already (left, or revoked from /groups): the list, not a stale screen.
    if (!grant) return { ...(await groupsScreen(ctx, user)), note: t.menuGone };
    const title = grant.title ?? String(grant.chat_id);
    if (group[1] === "rv") {
      await revokeAccess(ctx, user.id, chatId);
      return { ...(await groupsScreen(ctx, user)), note: t.revoked };
    }
    let note: string | undefined;
    const claim = await ctx.store.getClaudeChat(chatId);
    const mine = claim?.user_id === user.id;
    if (group[1] === "gs" && mine) return startsScreen(ctx, user, chatId, title);
    if (group[1] === "gc") note = await toggleClaude(ctx, user, chatId, claim);
    if (group[1] === "go" && mine) {
      if (!claim.others) {
        return {
          text: t.othersWarning(title),
          reply_markup: {
            inline_keyboard: [
              [button(t.buttonTurnOn, `goy:${chatId}`)],
              [button(t.buttonCancel, `g:${chatId}`)],
            ],
          },
        };
      }
      await ctx.store.setClaudeOthers(user.id, chatId, false);
    }
    if (group[1] === "goy" && mine) await ctx.store.setClaudeOthers(user.id, chatId, true);
    if (group[1] === "gl" && mine) {
      return limitPicker(
        t,
        title,
        claim.others_limit,
        `g:${chatId}`,
        (n) => `gn:${chatId}:${n}`,
        `gk:${chatId}`,
      );
    }
    if (group[1] === "gk" && mine) await askLimit(ctx, user, `g:${chatId}`, title);
    const preset = group[1] === "gn" ? limitOf(group[3] ?? "") : null;
    if (preset !== null && mine && LIMIT_PRESETS.includes(preset)) {
      await ctx.store.setClaudeOthersLimit(user.id, chatId, preset);
    }
    return { ...(await groupScreen(ctx, user, grant)), note };
  }
  return mainScreen(ctx, user);
}

/**
 * A reply to the menu's prompt for a number (`askLimit`). A number in range
 * sets the limit and shows the chat's screen anew; anything else asks again,
 * and that question becomes the pending prompt. Null when the message answers
 * no pending prompt: it goes its usual way.
 */
export async function takeLimitAnswer(
  ctx: BotContext,
  message: Message & { from: User },
): Promise<WebhookReply | "asked" | null> {
  const target = message.reply_to_message;
  if (!target || target.from?.id !== ctx.bot.id) return null;
  // A command sent as the reply is still a command.
  if (message.text?.startsWith("/")) return null;
  const user = message.from;
  const pending = await ctx.store.takeLimitPrompt(user.id, target.message_id);
  if (!pending) return null;
  const t = texts(user.language_code);
  const limit = limitOf(message.text ?? "");
  if (limit === null) {
    const sent = await ctx.api
      .call<Message>("sendMessage", {
        chat_id: user.id,
        text: t.limitInvalid,
        reply_markup: { force_reply: true, input_field_placeholder: `${LIMIT_MIN}–${LIMIT_MAX}` },
      })
      .catch(() => null);
    if (sent) await ctx.store.setLimitPrompt(user.id, pending, sent.message_id);
    return "asked";
  }
  await ctx.store.dropLimitPrompt(user.id);
  const screen = await limitTarget(ctx, user, pending, limit);
  // The scene ended, or the chat is no longer theirs: say so rather than nothing.
  if (!screen) return { method: "sendMessage", chat_id: user.id, text: t.limitGone };
  return {
    method: "sendMessage",
    chat_id: user.id,
    text: screen.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: screen.reply_markup,
  };
}

/** Set a typed limit on what the prompt was for, if it is still the user's; its screen. */
async function limitTarget(
  ctx: BotContext,
  user: User,
  target: string,
  limit: number,
): Promise<Screen | null> {
  const match = /^([gqs]):(-?\d+)$/.exec(target);
  if (!match) return null;
  const key = Number(match[2]);
  if (match[1] === "s") {
    const scene = await ctx.store.getScene(key);
    if (!scene || scene.owner !== user.id || scene.status !== "active") return null;
    await ctx.store.setSceneWakeLimit(user.id, key, limit);
    return sceneScreen(ctx, user, { ...scene, wake_limit: limit });
  }
  const claim = await ctx.store.getClaudeChat(key);
  if (claim?.user_id !== user.id) return null;
  await ctx.store.setClaudeOthersLimit(user.id, key, limit);
  const updated = { ...claim, others_limit: limit };
  if (match[1] === "q") {
    const chat = await ctx.store.guestChatByKey(key);
    return chat ? guestChatScreen(user, chat, updated) : null;
  }
  const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === key);
  return grant ? groupScreen(ctx, user, grant) : null;
}

/**
 * Undo from a memory notice: `mu:<first>:<last>` covers the changes from
 * history entry `first` to `last`; `mu!:<first>` confirms dropping what came
 * after. Undoing is a change of its own, kept in history like any other, but
 * it sends no notice: the user made it.
 */
export async function handleMemoryUndo(
  ctx: BotContext,
  query: CallbackQuery,
  first: number,
  last: number | null,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    text,
  });
  const message = query.message;
  if (!message || message.chat.id !== query.from.id || !isAllowed(ctx.config, query.from.id)) {
    return answer(t.alreadyAnswered);
  }
  const change = await ctx.store.getMemoryChange(query.from.id, first);
  if (!change) return answer(t.undoGone);

  const edit = (text: string, reply_markup: object) =>
    ctx.api
      .call("editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup,
      })
      .catch(() => undefined);

  if (last !== null) {
    const later = await ctx.store.memoryChangesAfter(query.from.id, change.chat_id, last);
    if (later > 0) {
      await edit(`${message.text ? escapeHtml(message.text) : ""}\n\n${t.undoConfirm(later)}`, {
        inline_keyboard: [[{ text: t.buttonUndoAnyway, callback_data: `mu!:${first}` }]],
      });
      return answer(t.undoConfirm(later));
    }
  }
  await ctx.store.writeMemory(query.from.id, change.chat_id, change.content_before, null);
  await ctx.store.dropMemoryNotice(query.from.id, message.message_id);
  await edit(`${message.text ? escapeHtml(message.text) : ""}\n\n↩ ${t.undone}`, {
    inline_keyboard: [],
  });
  return answer(t.undone);
}

/** A press on a menu button: swap the screen in place, or send it anew if that fails. */
export async function handleMenu(
  ctx: BotContext,
  query: CallbackQuery,
  name: string,
): Promise<WebhookReply> {
  const t = texts(query.from.language_code);
  const answer = (text?: string): WebhookReply => ({
    method: "answerCallbackQuery",
    callback_query_id: query.id,
    ...(text ? { text } : {}),
  });
  const message = query.message;
  if (!message || message.chat.type !== "private" || message.chat.id !== query.from.id) {
    return answer(t.alreadyAnswered);
  }
  if (!isAllowed(ctx.config, query.from.id)) {
    return answer(t.notAllowed(query.from.id).replace(/<[^>]+>/g, ""));
  }

  const screen = await render(ctx, query.from, name);

  const body = {
    text: screen.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: screen.reply_markup,
  };
  try {
    await ctx.api.call("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      ...body,
    });
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
    // Pressing the same button twice changes nothing; Telegram calls that an error.
    if (!/message is not modified/i.test(error.description)) {
      await ctx.api
        .call("sendMessage", { chat_id: message.chat.id, ...body })
        .catch(() => undefined);
    }
  }
  return answer(screen.note);
}
