/**
 * The bot's menu in the private chat: one message whose inline buttons swap
 * the screen in place. `callback_data` is `m:<screen>` or `m:<screen>:<chat id>`:
 *
 *   m:main        what this is, and the user's Telegram ID
 *   m:groups      connected groups, a button each
 *   m:g:<id>      one group: what the assistant sees there, revoke
 *   m:rv:<id>     revoke that group, back to the list
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
        [button(t.buttonPersonal, "personal"), button(t.buttonHelp, "help")],
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

function staticScreen(text: string, back: string, user: User): Screen {
  return {
    text,
    reply_markup: { inline_keyboard: [[button(texts(user.language_code).buttonBack, back)]] },
  };
}

/** The screen for `name`, or a short answer to show instead when it is not this user's. */
async function render(ctx: BotContext, user: User, name: string): Promise<Screen | string> {
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
  if (name === "personal") return staticScreen(t.personalScreen, "main", user);
  if (name === "add") {
    return {
      text: t.addScreen,
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
    if (!grant) return t.menuGone;
    if (group[1] === "rv") {
      await ctx.store.revokeGrant(user.id, chatId);
      return groupsScreen(ctx, user);
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
  if (typeof screen === "string") return answer(screen);

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
      await ctx.api.call("sendMessage", { chat_id: message.chat.id, ...body });
    }
  }
  return answer();
}
