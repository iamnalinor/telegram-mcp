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
 *   m:cl          Claude on tag: the routine, if set
 *   m:clh         how to set the routine up; m:clp sends its prompt
 *   m:clset       asks for the trigger and token
 *   m:cltest      starts the routine once, as a check
 *   m:cldel       remove the routine: asks first; m:cldely does it
 *
 * Every press is checked again: anyone can send any callback_data.
 */

import { isAllowed } from "../env";
import { routinePrompt, tokenOf } from "../routine";
import { memoryTitle } from "../tools/memory";
import { TelegramError } from "../telegram/api";
import type { CallbackQuery, InlineKeyboardMarkup, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { testRoutine } from "./routine";
import { escapeHtml, formatDate, texts } from "./texts";

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
        [button(t.buttonRoutine, "cl"), button(t.buttonPersonal, "personal")],
        [button(t.buttonHelp, "help")],
      ],
    },
  };
}

async function groupsScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const back = [button(t.buttonBack, "main")];
  const grants = await ctx.store.listGrants(user.id);
  if (!grants.length) {
    return {
      text: t.noGroupsMenu,
      reply_markup: { inline_keyboard: [[button(t.buttonAdd, "add")], back] },
    };
  }
  const lines = grants.map((grant) =>
    t.groupLine({
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
          button((grant.title ?? String(grant.chat_id)).slice(0, 60), `g:${grant.chat_id}`),
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

async function routineScreen(ctx: BotContext, user: User): Promise<Screen> {
  const t = texts(user.language_code);
  const row = await ctx.store.getRoutine(user.id);
  const state = !row
    ? "none"
    : (await tokenOf(ctx.config.secretKey, row)) === null
      ? "broken"
      : "set";
  return {
    text: t.routineScreen({
      state,
      trigger: row?.trigger_id,
      since: row ? formatDate(row.updated_at) : undefined,
    }),
    reply_markup: {
      inline_keyboard: [
        [button(t.buttonGuide, "clh"), button(t.buttonSetRoutine, "clset")],
        ...(state === "set" ? [[button(t.buttonTestRoutine, "cltest")]] : []),
        ...(row ? [[button(t.buttonDeleteRoutine, "cldel")]] : []),
        [button(t.buttonBack, "main")],
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
    await ctx.store.bumpTokenVersion(user.id);
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
    await ctx.api.call("sendMessage", {
      chat_id: user.id,
      text: `${t.routinePromptIntro}\n<pre>${escapeHtml(routinePrompt(user.username ?? null))}</pre>`,
      parse_mode: "HTML",
    });
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

  const group = /^(g|rv):(-?\d+)$/.exec(name);
  if (group) {
    const chatId = Number(group[2]);
    const grant = (await ctx.store.listGrants(user.id)).find((g) => g.chat_id === chatId);
    // Gone already (left, or revoked from /groups): the list, not a stale screen.
    if (!grant) return { ...(await groupsScreen(ctx, user)), note: t.menuGone };
    if (group[1] === "rv") {
      await ctx.store.revokeGrant(user.id, chatId);
      return { ...(await groupsScreen(ctx, user)), note: t.revoked };
    }
    return {
      text: t.groupScreen({
        title: grant.title ?? String(grant.chat_id),
        full: grant.visible_from === 0,
        since: formatDate(grant.visible_from),
      }),
      reply_markup: {
        inline_keyboard: [
          [button(t.buttonChatMemory, `mv:${chatId}`)],
          [button(t.buttonRevoke, `rv:${chatId}`)],
          [button(t.buttonBack, "groups")],
        ],
      },
    };
  }
  return mainScreen(ctx, user);
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
