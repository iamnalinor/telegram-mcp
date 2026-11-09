/**
 * Tools that post to Telegram: messages, questions with buttons, files,
 * albums, locations, polls and the "typing…" indicator.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { telegramChat, type ChatView } from "../access";
import { uploadLink } from "../files";
import { Fence, formatTime, person } from "../format";
import { markdownToHtml } from "../markdown";
import { GROUP_NOTE, type UserRef } from "../prompts";
import type { PressRow, StoredMessage } from "../store";
import type { Message } from "../telegram/types";
import {
  agentArg,
  asBot,
  buttonsArg,
  chatArg,
  formatArg,
  mayPost,
  messageIdArg,
  notPersonal,
  recordSent,
  richFormatArg,
  sendText,
  sendUpload,
  sentLink,
  sessionArg,
  text,
  ToolError,
  toolError,
  topicArg,
  UPLOAD_KINDS,
  withPlainFallback,
  where,
  type ToolContext,
} from "./common";

const WAIT_MAX_SECONDS = 50;
const WAIT_POLL_MS = 2000;
const INLINE_FILE_BYTES = 1024 * 1024;

export const silentArg = z.boolean().optional().describe("Deliver without a notification sound.");
export const replyToArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Reply to this message id.");

/** File content passed inline, as text or base64; at most 1 MB. */
export function inlineBytes(content: { text?: string; content_base64?: string }): Uint8Array {
  if ((content.text === undefined) === (content.content_base64 === undefined)) {
    throw new ToolError("Pass exactly one of text or content_base64.");
  }
  let bytes: Uint8Array;
  if (content.text !== undefined) {
    bytes = new TextEncoder().encode(content.text);
  } else {
    try {
      const binary = atob(
        content.content_base64!.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/"),
      );
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new ToolError("content_base64 is not valid base64.");
    }
  }
  if (bytes.byteLength > INLINE_FILE_BYTES) {
    throw new ToolError(
      `That is ${bytes.byteLength} bytes; inline files stop at 1 MB. Use an upload link.`,
    );
  }
  if (!bytes.byteLength) throw new ToolError("The file is empty.");
  return bytes;
}

/** What create_upload_url (and its as-user counterpart) hands back. */
export function uploadInstructions(filename: string, chat: ChatView, url: string): string {
  const quoted = `'${url.replaceAll("'", "'\\''")}'`;
  return (
    `Upload link for ${filename} → ${where(chat)}, valid 10 minutes, single use:\n${url}\n\n` +
    `Run:\ncurl -sS --fail-with-body -T <path-to-file> ${quoted}\n\n` +
    "It prints where the file was sent. Do not show this link to the user."
  );
}

export function sentSummary(ctx: ToolContext, chat: ChatView, messages: Message[]): string {
  const ids = messages.map((message) => `#${message.message_id}`).join(", ");
  const link = messages.length ? sentLink(ctx, chat, messages.at(-1)!) : null;
  return `Sent to ${where(chat)} as ${ids}.${link ? ` Link for the user: ${link}` : ""}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Answer =
  { kind: "press"; press: PressRow; number: number } | { kind: "message"; message: StoredMessage };

/**
 * Wait for an answer to one of the bot's messages: a press on its buttons, a
 * reply to it, or — in the private chat — anything the user writes after it.
 * Polls D1: a couple of row reads per round, no writes per round.
 */
async function waitForAnswer(
  ctx: ToolContext,
  chat: ChatView,
  messageId: number,
  seconds: number,
  afterPress = 0,
): Promise<Answer | null> {
  const deadline = Date.now() + seconds * 1000;
  // Waiting for the next press takes no typed answer: the user's messages must go their usual way.
  const typed = afterPress === 0;
  if (typed) await ctx.store.markAwaited(chat, messageId, Math.ceil(deadline / 1000), "start");
  for (;;) {
    const answer = await findAnswer(ctx, chat, messageId, afterPress);
    if (answer) {
      // The session stops listening now, not at the deadline.
      if (typed) await ctx.store.markAwaited(chat, messageId, Math.floor(Date.now() / 1000), "end");
      return answer;
    }
    if (Date.now() + WAIT_POLL_MS > deadline) return null;
    await sleep(WAIT_POLL_MS);
  }
}

async function findAnswer(
  ctx: ToolContext,
  chat: ChatView,
  messageId: number,
  afterPress: number,
): Promise<Answer | null> {
  const presses = await ctx.store.pressesFor(chat.chat_id, messageId);
  if (presses.length > afterPress) {
    return { kind: "press", press: presses[afterPress], number: afterPress + 1 };
  }
  // Past the first press, only the next press is awaited: the message's replies were seen.
  if (afterPress > 0) return null;
  const answer = await ctx.store.answerTo(chat, messageId, chat.kind === "dm" ? ctx.userId : null);
  return answer ? { kind: "message", message: answer } : null;
}

function describeAnswer(
  answer: Answer | null,
  messageId: number,
  seconds: number,
  user: UserRef,
): string {
  if (!answer) {
    return (
      `No answer to #${messageId} within ${seconds} s. The user may be away: call wait_for_reply again ` +
      "to keep waiting, or carry on with work that does not depend on the answer. Do not assume one."
    );
  }
  if (answer.kind === "press") {
    const { press } = answer;
    const value = press.data !== press.label ? ` (value: ${press.data})` : "";
    const who = person(press.user_name, null, press.user_id, user.id);
    const body = `${who} pressed "${press.label}"${value} at ${formatTime(press.date)} UTC.`;
    const fence = new Fence(user, [body]);
    return (
      `Press ${answer.number}. ${fence.note()}\n${fence.wrap(body)}\n` +
      `For the next press on this message (a widget, buttons that stay), wait with after_press: ${answer.number}.`
    );
  }
  const message = answer.message;
  const who = person(message.from_name, message.from_username, message.from_id, user.id);
  const file = message.file_id
    ? `\n[attachment: ${message.file_name ?? message.file_kind} — get_file chat ${message.chat_id} message ${message.message_id}]`
    : "";
  const body = `${who}: ${message.text}${file}`;
  const fence = new Fence(user, [body]);
  return (
    `Answer #${message.message_id}, ${formatTime(message.date)} UTC. ${fence.note()}\n` +
    fence.wrap(body)
  );
}

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a Telegram message",
      description:
        'Message the user in Telegram — chat "me" by default — or a connected group. Use for "message me / ' +
        'ping me when done / tell me in Telegram". Markdown is converted; long text is split. format "rich" ' +
        "sends a rich message — use it unasked for anything compared, listed with attributes, or longer than " +
        "about ten lines: tables, headings, collapsible <details>. Optional buttons " +
        "(presses are recorded) and reply_to. Returns the message id and a t.me link to give the user. For a " +
        `question that needs an answer, use ask_user instead. ${GROUP_NOTE}`,
      inputSchema: z.object({
        text: z.string().min(1).max(32_000),
        chat: chatArg,
        format: richFormatArg,
        buttons: buttonsArg,
        reply_to: replyToArg,
        topic: topicArg,
        silent: silentArg,
        session: sessionArg,
        agent: agentArg,
        only_for: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "In a group: show the message to this member only (their id, from a message header). Nobody " +
              "else sees it; it is not stored and cannot be edited later. Needs the bot to be an admin there. " +
              "For an answer that concerns one person: a refusal, something private to them.",
          ),
        link_preview: z
          .boolean()
          .optional()
          .describe("Show a preview for the first link. Default: off."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user");
        const sent = await sendText(ctx, chat, {
          text: args.text,
          format: args.format,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          linkPreview: args.link_preview,
          session: args.session,
          agent: args.agent,
          onlyFor: args.only_for,
        });
        if (args.only_for !== undefined) {
          return text(
            `Shown in ${where(chat)} to member ${args.only_for} only. Telegram does not promise delivery ` +
              "(they may be offline), and it cannot be edited or read back.",
          );
        }
        return text(sentSummary(ctx, chat, sent));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "ask_user",
    {
      title: "Ask the user in Telegram and wait",
      description:
        "Ask a question in Telegram with answer buttons, then wait for the press or a typed reply. Prefer it " +
        "to a question in prose whenever the answer is one of a few options. Use when " +
        'you need a decision and the user may not be watching this conversation ("ask me in Telegram before ' +
        `deploying"). Waits up to ${WAIT_MAX_SECONDS} s; if nothing comes, call wait_for_reply with the returned ` +
        "message id. Never act as if an answer came when it did not.",
      inputSchema: z.object({
        question: z.string().min(1).max(4000),
        options: z
          .array(z.string().min(1).max(64))
          .max(10)
          .optional()
          .describe(
            'Short answer labels, one button each, e.g. ["Deploy", "Wait"]. Omit for a free-text answer.',
          ),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
        agent: agentArg,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(WAIT_MAX_SECONDS)
          .optional()
          .describe(`How long to wait now. Default: ${WAIT_MAX_SECONDS}. 0 sends without waiting.`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "ask_user asks the user, in their chat with the bot or a group.");
        const options = args.options ?? [];
        // Short labels share rows; long ones get a row each.
        const perRow = options.every((option) => option.length <= 12) ? 3 : 1;
        const buttons = [];
        for (let i = 0; i < options.length; i += perRow) {
          buttons.push(options.slice(i, i + perRow).map((option) => ({ text: option })));
        }
        const [message] = await sendText(ctx, chat, {
          text: args.question,
          buttons: buttons.length ? buttons : undefined,
          topic: args.topic,
          markChoice: true,
          session: args.session,
          agent: args.agent,
        }).then((sent) => sent.slice(-1));

        const seconds = args.wait_seconds ?? WAIT_MAX_SECONDS;
        const sentNote = sentSummary(ctx, chat, [message]);
        if (seconds === 0)
          return text(
            `${sentNote} Not waiting; use wait_for_reply with message_id ${message.message_id}.`,
          );
        const answer = await waitForAnswer(ctx, chat, message.message_id, seconds);
        return text(
          `${sentNote}\n${describeAnswer(answer, message.message_id, seconds, ctx.user)}`,
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "wait_for_reply",
    {
      title: "Wait for the user's answer",
      description:
        "Wait for an answer to a message the bot sent: a button press, a reply to it, or (in the private chat) " +
        `anything the user writes after it. Returns as soon as one arrives, or after up to ${WAIT_MAX_SECONDS} s ` +
        'with "no answer yet". Without message_id, waits on the bot\'s latest message in that chat.',
      inputSchema: z.object({
        chat: chatArg,
        message_id: messageIdArg.optional(),
        wait_seconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
        after_press: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "Skip this many presses already seen and wait for the next one: for a widget, or buttons that stay.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        notPersonal(chat, "to see whether someone answered there, use get_recent_messages.");
        const messageId = args.message_id ?? (await ctx.store.lastOutgoing(chat))?.message_id;
        if (!messageId)
          throw new ToolError(
            "The bot has sent nothing in that chat yet, so there is nothing to wait on.",
          );
        const seconds = args.wait_seconds ?? WAIT_MAX_SECONDS;
        return text(
          describeAnswer(
            await waitForAnswer(ctx, chat, messageId, seconds, args.after_press),
            messageId,
            seconds,
            ctx.user,
          ),
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  const fileOptions = {
    chat: chatArg,
    caption: z.string().max(1024).optional().describe("Text under the file (Markdown)."),
    as: z
      .enum(UPLOAD_KINDS)
      .optional()
      .describe(
        "document (default, any file, keeps the name), photo (compressed, ≤10 MB), video, audio, voice, animation.",
      ),
    buttons: buttonsArg,
    reply_to: replyToArg,
    topic: topicArg,
    silent: silentArg,
    session: sessionArg,
    agent: agentArg,
  };

  server.registerTool(
    "create_upload_url",
    {
      title: "Get a link to upload a file to Telegram",
      description:
        "The way to send a file you built when you have a shell: returns a one-time URL (valid 10 min) and the " +
        "curl command to run. The file is sent to the chat the moment the upload finishes, up to 50 MB, and curl " +
        `prints the message link. Prefer this over send_file for anything but small text. ${GROUP_NOTE}`,
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe("Name the user sees, with extension."),
        ...fileOptions,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with file.upload");
        await mayPost(ctx, chat, args.buttons);
        const url = await uploadLink(ctx, chat, args.filename, {
          as: args.as,
          caption: args.caption,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          session: args.session,
          agent: args.agent,
        });
        return text(uploadInstructions(args.filename, chat, url));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_file",
    {
      title: "Send a small file inline",
      description:
        "Send a file whose content you pass directly: `text` for text files (code, logs, CSV, Markdown), or " +
        "`content_base64` for small binaries (≤1 MB). Use when you have no shell; otherwise create_upload_url " +
        `is cheaper and handles big files. ${GROUP_NOTE}`,
      inputSchema: z.object({
        filename: z.string().min(1).max(200),
        text: z.string().optional().describe("File content as text (UTF-8)."),
        content_base64: z.string().optional().describe("File content as base64, ≤1 MB decoded."),
        ...fileOptions,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with file");
        const bytes = inlineBytes(args);
        const message = await sendUpload(ctx, chat, { blob: new Blob([bytes]) }, args.filename, {
          as: args.as,
          caption: args.caption,
          buttons: args.buttons,
          replyTo: args.reply_to,
          topic: args.topic,
          silent: args.silent,
          session: args.session,
          agent: args.agent,
        });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_album",
    {
      title: "Send several photos or files as one album",
      description:
        "Group 2–10 photos/videos (or 2–10 documents) into one album. Items are files already in Telegram — " +
        "attachments of stored messages, by message id — or public URLs Telegram can fetch. To upload new files, " +
        `send them one by one with create_upload_url. ${GROUP_NOTE}`,
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              message_id: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("A stored message with a photo/video/document."),
              from_chat: chatArg.describe('Chat of that message. Default: "me".'),
              url: z.string().url().optional().describe("Or a public https URL."),
              kind: z
                .enum(["photo", "video", "document"])
                .optional()
                .describe("For URLs. Default: photo."),
              caption: z.string().max(1024).optional(),
            }),
          )
          .min(2)
          .max(10),
        chat: chatArg,
        topic: topicArg,
        silent: silentArg,
        session: sessionArg,
        agent: agentArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user, one file at a time");
        await mayPost(ctx, chat);
        const media = [];
        for (const item of args.items) {
          if (item.message_id) {
            const from = await ctx.access.resolve(item.from_chat);
            notPersonal(from, "the bot cannot carry a personal chat's files elsewhere.");
            const stored = await ctx.store.getMessage(from, item.message_id);
            if (!stored?.file_id || stored.date < from.visible_from) {
              throw new ToolError(`Message #${item.message_id} has no stored attachment.`);
            }
            const kind = stored.file_kind ?? "";
            if (!["photo", "video", "document", "audio"].includes(kind)) {
              throw new ToolError(
                `Message #${item.message_id} holds a ${kind}; albums take photos, videos, documents or audio only.`,
              );
            }
            media.push({ type: kind, media: stored.file_id, caption: item.caption });
          } else if (item.url) {
            media.push({ type: item.kind ?? "photo", media: item.url, caption: item.caption });
          } else {
            throw new ToolError("Each item needs message_id or url.");
          }
        }
        const sent = await ctx.api.call<Message[]>("sendMediaGroup", {
          ...telegramChat(chat),
          media,
          ...(args.topic ? { message_thread_id: args.topic } : {}),
          ...(args.silent ? { disable_notification: true } : {}),
        });
        for (const message of sent) {
          await recordSent(ctx, chat, message, { session: args.session, agent: args.agent });
        }
        return text(sentSummary(ctx, chat, sent));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_location",
    {
      title: "Send a map pin",
      description: `Send a location pin, optionally as a named venue. ${GROUP_NOTE}`,
      inputSchema: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        title: z
          .string()
          .max(100)
          .optional()
          .describe("Venue name; with address, sends a venue card."),
        address: z.string().max(200).optional(),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
        agent: agentArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with the address as text");
        await mayPost(ctx, chat);
        const venue = args.title && args.address;
        const message = await ctx.api.call<Message>(venue ? "sendVenue" : "sendLocation", {
          ...telegramChat(chat),
          latitude: args.latitude,
          longitude: args.longitude,
          ...(venue ? { title: args.title, address: args.address } : {}),
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        await recordSent(ctx, chat, message, {
          text: venue ? `[venue] ${args.title}, ${args.address}` : undefined,
          session: args.session,
          agent: args.agent,
        });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_poll",
    {
      title: "Start a poll",
      description:
        'Post a native Telegram poll, typically in a group ("poll the team on Friday vs Monday") — the way ' +
        "to settle something several people decide. With " +
        "correct_options it is a quiz. Votes are not reported back to you; for one person's decision, use " +
        `ask_user. ${GROUP_NOTE}`,
      inputSchema: z.object({
        question: z.string().min(1).max(300),
        options: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(12)
          .describe("Two or more; one is enough only with adding_options."),
        description: z.string().max(1024).optional().describe("Text shown under the question."),
        anonymous: z.boolean().optional().describe("Default: false — voters are visible."),
        multiple_answers: z.boolean().optional(),
        correct_options: z
          .array(z.number().int().min(0).max(11))
          .min(1)
          .max(12)
          .optional()
          .describe("Makes it a quiz: the 0-based numbers of the right options, one or several."),
        explanation: z
          .string()
          .max(200)
          .optional()
          .describe("For a quiz: shown after a wrong answer."),
        revoting: z.boolean().optional().describe("Whether a vote can be changed."),
        adding_options: z
          .boolean()
          .optional()
          .describe("Let members add options of their own. Not for anonymous polls or quizzes."),
        hide_results: z.boolean().optional().describe("Show results only once the poll closes."),
        close_in_seconds: z
          .number()
          .int()
          .min(5)
          .max(2_628_000)
          .optional()
          .describe("Close the poll by itself after this long."),
        chat: chatArg,
        topic: topicArg,
        session: sessionArg,
        agent: agentArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = await ctx.access.resolve(args.chat);
        asBot(chat, "send_as_user with the question as text");
        await mayPost(ctx, chat);
        const correct = args.correct_options
          ? [...new Set(args.correct_options)].sort((a, b) => a - b)
          : null;
        if (args.options.length < 2 && !args.adding_options) {
          throw new ToolError(
            "A poll needs two options, or adding_options so that members add more.",
          );
        }
        if (correct?.some((index) => index >= args.options.length)) {
          throw new ToolError(
            "correct_options names an option that is not there (they count from 0).",
          );
        }
        const message = await ctx.api.call<Message>("sendPoll", {
          ...telegramChat(chat),
          question: args.question,
          options: args.options.map((option) => ({ text: option })),
          is_anonymous: args.anonymous ?? false,
          allows_multiple_answers: args.multiple_answers ?? (correct ? correct.length > 1 : false),
          ...(correct ? { type: "quiz", correct_option_ids: correct } : {}),
          ...(correct && args.explanation ? { explanation: args.explanation } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.revoting === undefined ? {} : { allows_revoting: args.revoting }),
          ...(args.adding_options ? { allow_adding_options: true } : {}),
          ...(args.hide_results ? { hide_results_until_closes: true } : {}),
          ...(args.close_in_seconds ? { open_period: args.close_in_seconds } : {}),
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        await recordSent(ctx, chat, message, { session: args.session, agent: args.agent });
        return text(sentSummary(ctx, chat, [message]));
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_draft",
    {
      title: "Show a live preview of an answer",
      description:
        "In the private chat only: show text as a streaming preview — it appears as if being typed, and " +
        "vanishes after about 30 s or when the bot sends a message. Call it again with the same draft and " +
        "more text to make it grow; empty text shows «Thinking…». It is not a message: nothing is stored, " +
        "so finish with send_message. Use it unasked whenever the user waits more than a few seconds for " +
        "you in the private chat: empty at once, then with the text of a long answer as it grows.",
      inputSchema: z.object({
        text: z.string().max(4000).optional().describe("The text so far. Omit for «Thinking…»."),
        draft: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .optional()
          .describe("Which preview this continues; a new number starts a new one. Default: 1."),
        format: formatArg,
        topic: topicArg,
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
        const body = args.text ?? "";
        const markdown = (args.format ?? "markdown") === "markdown" && body !== "";
        await withPlainFallback((plain) =>
          ctx.api.call("sendMessageDraft", {
            chat_id: ctx.userId,
            draft_id: args.draft ?? 1,
            text: markdown && !plain ? markdownToHtml(body) : body,
            ...(markdown && !plain ? { parse_mode: "HTML" } : {}),
            ...(args.topic ? { message_thread_id: args.topic } : {}),
          }),
        );
        return text("Shown as a preview for about 30 s. It is not stored: send the final text.");
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_widget",
    {
      title: "Send an interactive widget",
      description:
        "Send a small interactive block drawn inside a message: a checklist to tick off, a counter, a " +
        "tracker, a board, a chart, a picker, a small game. Offer it unasked when tapping or a live view " +
        "beats text. For now Telegram shows widgets only in the private chat with the bot. A widget is one " +
        "self-contained HTML document with inline <style> and <script>: at most 32768 bytes and 4096 after " +
        "zlib compression, no network, no external files, no keyboard input; images only as inline SVG or " +
        "data: URLs; design for 320 px wide and at most 600 px tall; use the --tg-theme-* CSS variables " +
        "for colours. Its code never changes after sending — only its state does: the script reads " +
        "TelegramWidget.chatData (a string, or null) and redraws on " +
        "TelegramWidget.onEvent('chatDataChanged', render). With taps: true, a tap handler may call " +
        "TelegramWidget.request(data) with up to 64 bytes: the bot records it like a button press (read " +
        'it with wait_for_reply and after_press, or get_message) and answers the widget "ok" at once; ' +
        "you then change what it shows with set_widget_state. The full rules: " +
        "https://core.telegram.org/bots/widgets.md — read them before writing a non-trivial widget.",
      inputSchema: z.object({
        html: z.string().min(1).max(32_768).describe("The widget's HTML, CSS and script."),
        state: z
          .string()
          .max(1024)
          .optional()
          .describe("Its first state (chatData), usually JSON, at most 1024 bytes."),
        caption: z.string().max(1024).optional().describe("Text under the widget (Markdown)."),
        height: z
          .number()
          .int()
          .min(50)
          .max(600)
          .optional()
          .describe("Fixed height in px. Omit to fit the content."),
        taps: z
          .boolean()
          .optional()
          .describe("Let the widget report taps (TelegramWidget.request). Default: false."),
        reply_to: replyToArg,
        topic: topicArg,
        silent: silentArg,
        session: sessionArg,
        agent: agentArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const chat = ctx.access.dm();
        const caption = args.caption;
        const message = await withPlainFallback((plain) =>
          ctx.api.call<Message>("sendWidget", {
            chat_id: chat.chat_id,
            html: args.html,
            ...(args.state === undefined ? {} : { chat_data: args.state }),
            ...(args.height ? { height: args.height } : {}),
            ...(args.taps ? { allow_queries: true } : {}),
            ...(caption ? { caption: plain ? caption : markdownToHtml(caption) } : {}),
            ...(caption && !plain ? { parse_mode: "HTML" } : {}),
            ...(args.topic ? { message_thread_id: args.topic } : {}),
            ...(args.reply_to
              ? {
                  reply_parameters: {
                    message_id: args.reply_to,
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            ...(args.silent ? { disable_notification: true } : {}),
          }),
        );
        await recordSent(ctx, chat, message, {
          text: `[widget]${caption ? ` ${caption}` : ""}`,
          session: args.session,
          agent: args.agent,
        });
        return text(
          `${sentSummary(ctx, chat, [message])} Change what it shows with set_widget_state` +
            (args.taps ? "; taps come as presses on this message (wait_for_reply)." : "."),
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "set_widget_state",
    {
      title: "Change what a widget shows",
      description:
        "Replace the state (chatData) of a widget the bot sent: the widget redraws at once, wherever it is " +
        "open. Its HTML cannot be changed — for a new layout, send a new widget.",
      inputSchema: z.object({
        message_id: messageIdArg,
        state: z.string().max(1024).describe("The new state, at most 1024 bytes. Empty clears it."),
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
        const chat = ctx.access.dm();
        const stored = await ctx.store.getMessage(chat, args.message_id);
        if (!stored?.outgoing || stored.file_kind !== "widget") {
          throw new ToolError(`Message #${args.message_id} is not a widget the bot sent.`);
        }
        await ctx.api.call("editMessageWidgetData", {
          chat_id: chat.chat_id,
          message_id: args.message_id,
          chat_data: args.state,
        });
        return text("The widget has its new state.");
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "send_chat_action",
    {
      title: 'Show "typing…"',
      description:
        'Show "typing…" (or "sending a document…") in the chat for ~5 s, before a send that takes a while. Optional nicety.',
      inputSchema: z.object({
        action: z
          .enum([
            "typing",
            "upload_document",
            "upload_photo",
            "upload_video",
            "record_voice",
            "find_location",
          ])
          .optional(),
        chat: chatArg,
        topic: topicArg,
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
        notPersonal(chat, "the other person would see the user typing.");
        await ctx.api.call("sendChatAction", {
          ...telegramChat(chat),
          action: args.action ?? "typing",
          ...(args.topic ? { message_thread_id: args.topic } : {}),
        });
        return text("Shown.");
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}
