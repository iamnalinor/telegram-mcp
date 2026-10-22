/**
 * How messages read to the model: one compact line each, carrying what the
 * next call needs (ids), what a person would want relayed (who, when, where,
 * a t.me link), and the context that changes meaning — what it replies to,
 * which forum topic, whether the bot was tagged.
 *
 * All of it is written by whoever posted it, so each message is fenced in a
 * tag picked fresh for every result: a message cannot guess it, so it cannot
 * close the fence early and pose as tool output. Sender ids, with the user
 * marked, tell the user's words from everyone else's.
 *
 *   <tg-Xy7k>
 *   #4512 · 2026-10-22 14:03 · Team chat › Design · Alice (@alice, id 111, the user) 🔔
 *     ↩ #4510 Bob (id 222): "can someone check the deploy?"
 *     Looks good, @bot please summarise
 *     📎 report.pdf (2.1 MB, document)
 *     https://t.me/c/123/7/4512
 *   </tg-Xy7k>
 */

import type { ChatView } from "./access";
import { randomId } from "./crypto";
import { messageLink } from "./links";
import { untrustedNote } from "./prompts";
import type { PressRow, ReactionRow, StoredMessage, TopicRow } from "./store";

const SNIPPET_LENGTH = 500;
const REPLY_PREVIEW_LENGTH = 120;

export function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export function humanSize(bytes: number | null | undefined): string {
  if (!bytes) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** `Alice (@alice, id 111, the user)`: who, and whether it is the user. */
export function person(
  name: string | null,
  username: string | null,
  id: number | null,
  userId: number,
): string {
  const details = [
    username ? `@${username}` : null,
    id === null ? null : `id ${id}`,
    id === userId ? "the user" : null,
  ].filter(Boolean);
  return details.length ? `${name ?? "unknown"} (${details.join(", ")})` : (name ?? "unknown");
}

function sender(message: StoredMessage, botUsername: string, userId: number): string {
  if (message.outgoing) return `bot (@${botUsername}, you)`;
  return person(message.from_name, message.from_username, message.from_id, userId);
}

/** A tag unique to one result, around content written by others. */
export class Fence {
  readonly tag = `tg-${randomId(3)}`;

  constructor(private readonly userId: number) {}

  wrap(body: string): string {
    return `<${this.tag}>\n${body.replaceAll(this.tag, "tg")}\n</${this.tag}>`;
  }

  /** The line that heads a result, saying what the fence means. */
  note(): string {
    return untrustedNote(this.tag, this.userId);
  }
}

export class Renderer {
  private readonly chats: Map<number, ChatView>;
  private readonly topics = new Map<string, string>();
  readonly fence: Fence;

  constructor(
    private readonly botUsername: string,
    private readonly userId: number,
    chats: ChatView[],
    topics: TopicRow[] = [],
    /** Messages that others reply to, keyed `chat:message`, for reply previews. */
    private readonly replyTargets = new Map<string, StoredMessage>(),
  ) {
    this.chats = new Map(chats.map((chat) => [chat.chat_id, chat]));
    for (const topic of topics) this.topics.set(`${topic.chat_id}:${topic.thread_id}`, topic.name);
    this.fence = new Fence(userId);
  }

  topicName(chatId: number, threadId: number | null): string | null {
    if (!threadId) return null;
    return this.topics.get(`${chatId}:${threadId}`) ?? `topic ${threadId}`;
  }

  link(message: Pick<StoredMessage, "chat_id" | "message_id" | "thread_id">): string | null {
    const chat = this.chats.get(message.chat_id);
    if (!chat) return null;
    return messageLink(chat, message.message_id, message.thread_id, this.botUsername);
  }

  where(chatId: number, threadId: number | null): string {
    const chat = this.chats.get(chatId);
    const title = chat?.kind === "dm" ? "DM" : (chat?.title ?? String(chatId));
    const topic = this.topicName(chatId, threadId);
    return topic ? `${title} › ${topic}` : title;
  }

  /**
   * @param showChat include the chat in the header — for results spanning chats
   * @param full the whole text instead of a snippet
   */
  message(message: StoredMessage, options: { showChat?: boolean; full?: boolean } = {}): string {
    const header = [
      `#${message.message_id}`,
      formatTime(message.date) + (message.edited_at ? " (edited)" : ""),
      ...(options.showChat || message.thread_id
        ? [this.where(message.chat_id, message.thread_id)]
        : []),
      sender(message, this.botUsername, this.userId) +
        (message.mentions_bot && !message.outgoing && this.isGroup(message.chat_id) ? " 🔔" : ""),
    ].join(" · ");

    const lines = [header];
    if (message.forwarded_from) lines.push(`  ↪ forwarded from ${message.forwarded_from}`);
    if (message.reply_to_id) {
      const target = this.replyTargets.get(`${message.chat_id}:${message.reply_to_id}`);
      lines.push(
        target
          ? `  ↩ #${target.message_id} ${sender(target, this.botUsername, this.userId)}: "${clip(target.text, REPLY_PREVIEW_LENGTH)}"`
          : `  ↩ #${message.reply_to_id} (not stored)`,
      );
    }
    if (message.quote) lines.push(`  ❝${clip(message.quote, REPLY_PREVIEW_LENGTH)}❞`);

    const text = options.full ? message.text : clip(message.text, SNIPPET_LENGTH);
    if (text) {
      lines.push(...text.split("\n").map((line) => `  ${line}`));
      if (!options.full && message.text.replace(/\s+/g, " ").trim().length > SNIPPET_LENGTH) {
        lines.push("  (cut — get_message for the rest)");
      }
    }
    if (message.file_id) {
      lines.push(
        `  📎 ${message.file_name ?? message.file_kind} (${humanSize(message.file_size)}, ${message.file_kind}${message.file_mime ? `, ${message.file_mime}` : ""})`,
      );
    }
    if (message.buttons) {
      const labels = (JSON.parse(message.buttons) as { text: string }[][])
        .flat()
        .map((b) => b.text);
      lines.push(`  [buttons: ${labels.join(" | ")}]`);
    }
    const link = this.link(message);
    if (link && this.isGroup(message.chat_id)) lines.push(`  ${link}`);
    return this.fence.wrap(lines.join("\n"));
  }

  private isGroup(chatId: number): boolean {
    return this.chats.get(chatId)?.kind === "group";
  }
}

export function formatPresses(presses: PressRow[], userId: number): string {
  return presses
    .map(
      (press) =>
        `${formatTime(press.date)} ${person(press.user_name, null, press.user_id, userId)} pressed "${press.label}"` +
        (press.data !== press.label ? ` (data: ${press.data})` : ""),
    )
    .join("\n");
}

export function formatReactions(reactions: ReactionRow[], userId: number): string {
  return reactions
    .map(
      (reaction) =>
        `${reaction.emoji} ${person(reaction.user_name, null, reaction.user_id, userId)}`,
    )
    .join(", ");
}
