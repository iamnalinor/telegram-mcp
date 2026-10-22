/**
 * Tools that change what is already in a chat: edit, delete, pin, react,
 * forward, mark as read. Edits and deletes are limited to the bot's own
 * messages (plus, for deletes, the user's own messages in their private chat;
 * in personal chats, only what was sent through the assistant), so a model
 * can never rewrite or remove what other people — or the user — said.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { telegramChat, type ChatView } from "../access";
import { markdownToHtml, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from "../markdown";
import type { StoredMessage } from "../store";
import type { Message } from "../telegram/types";
import { sentSummary } from "./send";
import {
  buttonsArg,
  chatArg,
  formatArg,
  keyboard,
  mayPost,
  messageIdArg,
  notPersonal,
  storedButtons,
  text,
  ToolError,
  toolError,
  topicArg,
  withPlainFallback,
  type Buttons,
  type ToolContext,
} from "./common";

async function ownMessage(
  ctx: ToolContext,
  chat: ChatView,
  messageId: number,
): Promise<StoredMessage> {
  const message = await ctx.store.getMessage(chat, messageId);
  if (!message) throw new ToolError(`Message #${messageId} is not stored for that chat.`);
  if (chat.kind === "personal") {
    if (message.sent_by !== ctx.userId) {
      throw new ToolError(
        `Message #${messageId} was not sent through the assistant; in personal chats only those can be changed.`,
      );
    }
    return message;
  }
  if (!message.outgoing) {
    throw new ToolError(
      `Message #${messageId} was not sent by the bot; bots can only change their own messages.`,
    );
  }
  if (message.sent_by !== null && message.sent_by !== ctx.userId) {
    throw new ToolError(
      `Message #${messageId} was sent for another member of this group; only their assistant may change it.`,
    );
  }
  return message;
}

export function registerEditTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "edit_message",
    {
      title: "Edit a message the bot sent",
      description:
        "Change the text (or caption) and/or buttons of a message the bot sent. Good for one progress message " +
        'updated in place ("build 3/5…" → "done ✅") instead of many. buttons: [] removes the buttons.',
      inputSchema: z.object({
        message_id: messageIdArg,
        chat: chatArg,
        text: z
          .string()
          .min(1)
          .max(TELEGRAM_TEXT_LIMIT)
          .optional()
          .describe("New text. Omit to keep it."),
        format: formatArg,
        buttons: buttonsArg.describe("New buttons as rows; [] removes them. Omit to keep them."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        const stored = await ownMessage(ctx, chat, args.message_id);
        if (args.text === undefined && args.buttons === undefined)
          throw new ToolError("Pass text, buttons, or both.");
        await mayPost(ctx, chat, args.buttons);

        const markup =
          args.buttons === undefined
            ? undefined
            : (keyboard(args.buttons) ?? { inline_keyboard: [] });
        const base = { ...telegramChat(chat), message_id: args.message_id };
        const markdown = (args.format ?? "markdown") === "markdown";

        if (args.text !== undefined) {
          const isCaption = stored.file_id !== null;
          if (isCaption && args.text.length > TELEGRAM_CAPTION_LIMIT) {
            throw new ToolError(`Captions stop at ${TELEGRAM_CAPTION_LIMIT} characters.`);
          }
          const newText = args.text;
          await withPlainFallback((plain) =>
            ctx.api.call(isCaption ? "editMessageCaption" : "editMessageText", {
              ...base,
              [isCaption ? "caption" : "text"]:
                markdown && !plain ? markdownToHtml(newText) : newText,
              ...(markdown && !plain ? { parse_mode: "HTML" } : {}),
              ...(isCaption ? {} : { link_preview_options: { is_disabled: true } }),
              // Without reply_markup an edit drops the buttons; keep them unless replaced.
              reply_markup:
                markup ??
                (stored.buttons ? keyboard(JSON.parse(stored.buttons) as Buttons) : undefined),
            }),
          );
        } else {
          await ctx.api.call("editMessageReplyMarkup", { ...base, reply_markup: markup });
        }

        await ctx.store.updateOutgoing(chat, args.message_id, {
          text: args.text,
          buttons: args.buttons === undefined ? undefined : storedButtons(args.buttons),
        });
        return text(`Edited #${args.message_id}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete a message",
      description:
        "Delete a message the bot sent, or one the user sent in their private chat with the bot. In a personal " +
        "chat, only a message sent through you, and only if the user allowed deleting in Telegram. Telegram only " +
        "allows this within 48 hours. Only when the user asks for it.",
      inputSchema: z.object({ message_id: messageIdArg, chat: chatArg }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        if (chat.kind === "personal") {
          await ownMessage(ctx, chat, args.message_id);
          await ctx.access.allow(chat, "delete");
          await ctx.api.call("deleteBusinessMessages", {
            business_connection_id: telegramChat(chat).business_connection_id,
            message_ids: [args.message_id],
          });
          await ctx.store.deleteMessages(chat, [args.message_id]);
          return text(`Deleted #${args.message_id}.`);
        }
        const stored = await ctx.store.getMessage(chat, args.message_id);
        if (!stored)
          throw new ToolError(`Message #${args.message_id} is not stored for that chat.`);
        if (!stored.outgoing && chat.kind !== "dm") {
          throw new ToolError("In groups the bot only deletes its own messages.");
        }
        if (stored.outgoing && stored.sent_by !== null && stored.sent_by !== ctx.userId) {
          throw new ToolError(
            "That message was sent for another member of this group; only their assistant may delete it.",
          );
        }
        await ctx.api.call("deleteMessage", { chat_id: chat.chat_id, message_id: args.message_id });
        await ctx.store.deleteMessages(chat, [args.message_id]);
        return text(`Deleted #${args.message_id}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "pin_message",
    {
      title: "Pin or unpin a message",
      description:
        "Pin a message to the top of the chat (silently by default), or unpin it. Works in the private chat; in " +
        "groups the bot must be an admin allowed to pin.",
      inputSchema: z.object({
        message_id: messageIdArg,
        chat: chatArg,
        unpin: z.boolean().optional().describe("true to unpin instead."),
        notify: z.boolean().optional().describe("Notify members about the pin. Default: false."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "pinning there is not something the user allowed the assistant to do.");
        if (args.unpin) {
          await ctx.api.call("unpinChatMessage", {
            chat_id: chat.chat_id,
            message_id: args.message_id,
          });
          return text(`Unpinned #${args.message_id}.`);
        }
        await ctx.api.call("pinChatMessage", {
          chat_id: chat.chat_id,
          message_id: args.message_id,
          disable_notification: !args.notify,
        });
        return text(`Pinned #${args.message_id}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "react",
    {
      title: "React to a message",
      description:
        "Put an emoji reaction on a message — a quiet acknowledgement (👀 seen it, 👍 done) instead of a text " +
        "reply. Telegram allows a fixed set: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🎉 🤩 🙏 👌 🕊 🤡 🥱 😍 🐳 💯 🤣 ⚡ 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 😡. Omit emoji to remove the bot's reaction.",
      inputSchema: z.object({
        message_id: messageIdArg,
        chat: chatArg,
        emoji: z.string().max(16).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "Telegram does not let bots react on the user's behalf.");
        await ctx.api.call("setMessageReaction", {
          chat_id: chat.chat_id,
          message_id: args.message_id,
          reaction: args.emoji ? [{ type: "emoji", emoji: args.emoji }] : [],
        });
        return text(
          args.emoji ? `Reacted ${args.emoji} to #${args.message_id}.` : "Reaction removed.",
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "forward_message",
    {
      title: "Copy a message to another chat",
      description:
        "Copy a stored message — text, file and all — into another chat the user has access to, e.g. a file " +
        'posted in a group into "me". Sent as the bot\'s own message (no "forwarded from" header).',
      inputSchema: z.object({
        message_id: messageIdArg,
        from_chat: chatArg.describe('Where the message is. Default: "me".'),
        to_chat: chatArg.describe('Where to put the copy. Default: "me".'),
        topic: topicArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const from = await ctx.access.resolve(args.from_chat);
        const to = await ctx.access.resolve(args.to_chat);
        // The bot is not a member of a personal chat, so Telegram has nothing for it to copy from.
        notPersonal(from, "quote the message instead, or fetch its attachment with get_file.");
        notPersonal(to, "use send_message or the file tools to write there.");
        const stored = await ctx.store.getMessage(from, args.message_id);
        if (!stored || stored.date < from.visible_from) {
          throw new ToolError(`Message #${args.message_id} is not stored for that chat.`);
        }
        const copy = await ctx.api.call<{ message_id: number }>("copyMessage", {
          chat_id: to.chat_id,
          from_chat_id: from.chat_id,
          message_id: args.message_id,
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        // copyMessage answers with an id only; the copy is the original, re-homed.
        await ctx.store.insertMessage(
          {
            ...stored,
            account_id: to.account_id,
            chat_id: to.chat_id,
            message_id: copy.message_id,
            date: Math.floor(Date.now() / 1000),
            edited_at: null,
            thread_id: args.topic ?? null,
            from_id: ctx.bot.id,
            from_name: "bot",
            from_username: ctx.bot.username,
            reply_to_id: null,
            quote: null,
            mentions_bot: false,
            outgoing: true,
            buttons: null,
            mark_choice: false,
            sent_by: ctx.userId,
          },
          "always",
        );
        const sent = { message_id: copy.message_id, message_thread_id: args.topic } as Message;
        return text(sentSummary(ctx, to, [sent]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark a personal chat as read",
      description:
        "Mark a message in one of the user's personal chats as read (default: the other person's latest). They " +
        'will see it as read by the user, so do it only when the user asks. Needs the "Mark messages as read" ' +
        "permission the user gives in Telegram.",
      inputSchema: z.object({
        chat: chatArg.describe("A personal chat, by name, @username or id from list_chats."),
        message_id: messageIdArg.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        if (chat.kind !== "personal") {
          throw new ToolError("mark_read is for personal chats only; list_chats shows them.");
        }
        await ctx.access.allow(chat, "read");
        const messageId = args.message_id ?? (await ctx.store.lastIncoming(chat))?.message_id;
        if (!messageId)
          throw new ToolError("No stored messages from the other person in that chat.");
        await ctx.api.call("readBusinessMessage", { ...telegramChat(chat), message_id: messageId });
        return text(`Marked as read up to #${messageId}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}
