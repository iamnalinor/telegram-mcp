/**
 * The bot's menu in the private chat: one message whose inline buttons swap
 * the screen in place. `callback_data` is `m:<screen>` or `m:<screen>:<chat id>`:
 *
 *   m:main        what this is, and the user's Telegram ID
 *   m:groups      connected groups, a button each
 *   m:g:<id>      one group: what the assistant sees there, revoke
 *   m:rv:<id>     revoke that group, back to the list
 *   m:si          sign-ins, a sign-out button each
 *   m:sx:<id>     sign that one out
 *   m:out         sign out everywhere: asks first
 *   m:outyes      …and does it
 *   m:add         how to connect a group
 *   m:personal    personal chats through Telegram Business
 *   m:help        how it works, retention, commands
 *
 * Every press is checked again: anyone can send any callback_data.
 */

import { isAllowed } from "../env";
import { TelegramError } from "../telegram/api";
import type { CallbackQuery, InlineKeyboardMarkup, User } from "../telegram/types";
import { hasConnected, type BotContext, type WebhookReply } from "./context";
import { formatDate, texts } from "./texts";

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
        [button(t.buttonSignIns, "si"), button(t.buttonPersonal, "personal")],
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
          [button(t.buttonRevoke, `rv:${chatId}`)],
          [button(t.buttonBack, "groups")],
        ],
      },
    };
  }
  return mainScreen(ctx, user);
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
