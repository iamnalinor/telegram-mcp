/**
 * Every SQL statement the connector runs.
 *
 * Kept in one place so the cost of each path is visible: D1 bills rows read
 * and written per account, and the free plan stops all queries for the rest
 * of the day once either cap is hit. See src/schema.ts for why `messages`
 * carries no secondary index.
 */

import { nowSeconds } from "./crypto";

export interface StoredMessage {
  chat_id: number;
  message_id: number;
  date: number;
  edited_at: number | null;
  thread_id: number | null;
  from_id: number | null;
  from_name: string | null;
  from_username: string | null;
  forwarded_from: string | null;
  text: string;
  reply_to_id: number | null;
  /** Highlighted part of the replied-to message, or a note about a cross-chat reply. */
  quote: string | null;
  mentions_bot: boolean;
  outgoing: boolean;
  file_kind: string | null;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  /** JSON of `StoredButton[][]`, for messages the MCP sent with buttons. */
  buttons: string | null;
  mark_choice: boolean;
  /** For the bot's own messages: whose assistant sent it. Only they may edit or delete it. */
  sent_by: number | null;
}

export interface StoredButton {
  text: string;
  data?: string;
  url?: string;
}

interface MessageRow extends Omit<StoredMessage, "mentions_bot" | "outgoing" | "mark_choice"> {
  mentions_bot: number;
  outgoing: number;
  mark_choice: number;
}

export interface RefreshSessionRow {
  id: string;
  user_id: number;
  generation: number;
  rotated_at: number;
  expires_at: number;
  revoked: number;
}

export interface UserRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  language: string | null;
  token_version: number;
  created_at: number;
  connected_at: number | null;
}

export interface ChatRow {
  chat_id: number;
  type: string;
  title: string | null;
  username: string | null;
  is_forum: number;
  bot_is_admin: number;
  visible_history: number | null;
  updated_at: number;
}

export interface GrantRow {
  user_id: number;
  chat_id: number;
  source: "added_bot" | "connect";
  visible_from: number;
  granted_at: number;
  verified_at: number;
}

export type GrantWithChat = GrantRow & Pick<ChatRow, "type" | "title" | "username" | "is_forum">;

export interface PressRow {
  chat_id: number;
  message_id: number;
  callback_id: string;
  user_id: number;
  user_name: string | null;
  label: string;
  data: string;
  date: number;
}

export interface ReactionRow {
  chat_id: number;
  message_id: number;
  user_id: number;
  user_name: string | null;
  emoji: string;
  date: number;
}

export interface TopicRow {
  chat_id: number;
  thread_id: number;
  name: string;
}

/** One chat a search may look in, from the moment its reader is allowed to see. */
export interface Scope {
  chat_id: number;
  visible_from: number;
}

export interface SearchQuery {
  scopes: Scope[];
  keywords: string[];
  from?: string;
  mentionsOnly?: boolean;
  hasFile?: boolean;
  fileKind?: string;
  /** Forum topic (message_thread_id). */
  threadId?: number;
  direction?: "incoming" | "outgoing" | "any";
  since?: number;
  until?: number;
  limit: number;
}

/** D1 refuses more than 100 bound parameters in one statement; a scope takes three. */
export const MAX_SCOPES = 25;

function toMessage(row: MessageRow): StoredMessage {
  return {
    ...row,
    mentions_bot: row.mentions_bot === 1,
    outgoing: row.outgoing === 1,
    mark_choice: row.mark_choice === 1,
  };
}

/** Lower-cased in JS: SQLite's lower() only folds ASCII, which breaks Cyrillic search. */
function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").replaceAll("ё", "е");
}

function likePattern(keyword: string): string {
  return `%${normalize(keyword).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const MESSAGE_COLUMNS = [
  "chat_id",
  "message_id",
  "date",
  "edited_at",
  "thread_id",
  "from_id",
  "from_name",
  "from_username",
  "forwarded_from",
  "text",
  "text_lc",
  "reply_to_id",
  "quote",
  "mentions_bot",
  "outgoing",
  "file_kind",
  "file_id",
  "file_name",
  "file_mime",
  "file_size",
  "buttons",
  "mark_choice",
  "sent_by",
] as const;

function messageValues(message: StoredMessage): unknown[] {
  return [
    message.chat_id,
    message.message_id,
    message.date,
    message.edited_at,
    message.thread_id,
    message.from_id,
    message.from_name,
    message.from_username,
    message.forwarded_from,
    message.text,
    normalize(message.text),
    message.reply_to_id,
    message.quote,
    message.mentions_bot ? 1 : 0,
    message.outgoing ? 1 : 0,
    message.file_kind,
    message.file_id,
    message.file_name,
    message.file_mime,
    message.file_size,
    message.buttons,
    message.mark_choice ? 1 : 0,
    message.sent_by,
  ];
}

/**
 * When a message may be written: always (the bot's own, sent through the
 * MCP), while a private chat's owner is registered, or while a group has at
 * least one grant.
 */
export type Guard = "always" | "dm" | "group";

function guardSql(guard: Guard, chatId: number): [string, ...unknown[]] {
  switch (guard) {
    case "always":
      return ["1"];
    case "dm":
      return ["EXISTS (SELECT 1 FROM users WHERE user_id = ?)", chatId];
    case "group":
      return ["EXISTS (SELECT 1 FROM grants WHERE chat_id = ?)", chatId];
  }
}

const CHAT_TABLES = [
  "grants",
  "messages",
  "button_presses",
  "reactions",
  "topics",
  "day_marks",
  "chats",
];
const HISTORY_TABLES = ["messages", "button_presses", "reactions", "topics", "day_marks", "chats"];

const DAY = 86_400;

export class Store {
  constructor(readonly db: D1Database) {}

  // --- meta ----------------------------------------------------------------

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value",
      )
      .bind(key, value)
      .run();
  }

  // --- users ---------------------------------------------------------------

  async upsertUser(user: {
    user_id: number;
    username?: string | null;
    first_name?: string | null;
    language?: string | null;
  }): Promise<void> {
    // The WHERE keeps an unchanged profile from costing a row write.
    await this.db
      .prepare(
        `INSERT INTO users (user_id, username, first_name, language, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id) DO UPDATE SET
           username = excluded.username,
           first_name = COALESCE(excluded.first_name, first_name),
           language = COALESCE(excluded.language, language)
         WHERE username IS NOT excluded.username
            OR (excluded.first_name IS NOT NULL AND first_name IS NOT excluded.first_name)
            OR (excluded.language IS NOT NULL AND language IS NOT excluded.language)`,
      )
      .bind(
        user.user_id,
        user.username ?? null,
        user.first_name ?? null,
        user.language ?? null,
        nowSeconds(),
      )
      .run();
  }

  getUser(userId: number): Promise<UserRow | null> {
    return this.db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first<UserRow>();
  }

  /** Record that the user has signed an assistant in; written once. */
  async markConnected(userId: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET connected_at = ? WHERE user_id = ? AND connected_at IS NULL")
      .bind(nowSeconds(), userId)
      .run();
  }

  async bumpTokenVersion(userId: number): Promise<void> {
    await this.db
      .prepare("UPDATE users SET token_version = token_version + 1 WHERE user_id = ?")
      .bind(userId)
      .run();
  }

  // --- chats ---------------------------------------------------------------

  async upsertChat(chat: {
    chat_id: number;
    type: string;
    title?: string | null;
    username?: string | null;
    is_forum?: boolean;
    bot_is_admin?: boolean;
    visible_history?: boolean | null;
  }): Promise<void> {
    const flag = (value: boolean | null | undefined) =>
      value === undefined || value === null ? null : value ? 1 : 0;
    await this.db
      .prepare(
        `INSERT INTO chats (chat_id, type, title, username, is_forum, bot_is_admin, visible_history, updated_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0), COALESCE(?6, 0), ?7, ?8)
         ON CONFLICT (chat_id) DO UPDATE SET
           type = excluded.type,
           title = COALESCE(excluded.title, title),
           username = excluded.username,
           is_forum = COALESCE(?5, is_forum),
           bot_is_admin = COALESCE(?6, bot_is_admin),
           visible_history = COALESCE(?7, visible_history),
           updated_at = excluded.updated_at`,
      )
      .bind(
        chat.chat_id,
        chat.type,
        chat.title ?? null,
        chat.username ?? null,
        flag(chat.is_forum),
        flag(chat.bot_is_admin),
        flag(chat.visible_history),
        nowSeconds(),
      )
      .run();
  }

  /** A rename seen in the chat; no row is created for a chat we do not track. */
  async renameChat(chatId: number, title: string): Promise<void> {
    await this.db
      .prepare("UPDATE chats SET title = ?, updated_at = ? WHERE chat_id = ? AND title IS NOT ?")
      .bind(title, nowSeconds(), chatId, title)
      .run();
  }

  getChat(chatId: number): Promise<ChatRow | null> {
    return this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(chatId).first<ChatRow>();
  }

  /** Forget a chat entirely: the bot left, or nobody has access any more. */
  async deleteChat(chatId: number): Promise<void> {
    await this.db.batch(
      CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId),
      ),
    );
  }

  /** A group became a supergroup and got a new id; carry everything over. */
  async migrateChat(from: number, to: number): Promise<void> {
    await this.db.batch([
      ...["grants", "messages", "button_presses", "reactions", "topics", "day_marks"].map((table) =>
        this.db
          .prepare(`UPDATE OR IGNORE ${table} SET chat_id = ?2 WHERE chat_id = ?1`)
          .bind(from, to),
      ),
      this.db
        .prepare(
          `INSERT INTO chats (chat_id, type, title, username, is_forum, bot_is_admin, visible_history, updated_at)
           SELECT ?2, 'supergroup', title, username, is_forum, bot_is_admin, visible_history, updated_at
           FROM chats WHERE chat_id = ?1
           ON CONFLICT (chat_id) DO NOTHING`,
        )
        .bind(from, to),
      ...CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(from),
      ),
    ]);
  }

  // --- grants --------------------------------------------------------------

  /**
   * Give a user access to a group. An existing grant keeps the wider of the
   * two history windows, so reconnecting never narrows what someone sees.
   */
  async upsertGrant(
    userId: number,
    chatId: number,
    source: GrantRow["source"],
    visibleFrom: number,
  ): Promise<GrantRow> {
    const now = nowSeconds();
    const row = await this.db
      .prepare(
        `INSERT INTO grants (user_id, chat_id, source, visible_from, granted_at, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (user_id, chat_id) DO UPDATE SET
           visible_from = MIN(visible_from, excluded.visible_from),
           verified_at = excluded.verified_at
         RETURNING *`,
      )
      .bind(userId, chatId, source, visibleFrom, now)
      .first<GrantRow>();
    return row!;
  }

  getGrant(userId: number, chatId: number): Promise<GrantRow | null> {
    return this.db
      .prepare("SELECT * FROM grants WHERE user_id = ? AND chat_id = ?")
      .bind(userId, chatId)
      .first<GrantRow>();
  }

  async listGrants(userId: number): Promise<GrantWithChat[]> {
    const { results } = await this.db
      .prepare(
        `SELECT g.*, c.type, c.title, c.username, c.is_forum
         FROM grants g JOIN chats c ON c.chat_id = g.chat_id
         WHERE g.user_id = ?
         ORDER BY g.granted_at`,
      )
      .bind(userId)
      .all<GrantWithChat>();
    return results;
  }

  /**
   * Remove a grant, and with the last one the chat's whole history — in one
   * transaction, and only if no grant is left at commit. A /connect racing
   * with a revoke therefore either lands first and keeps the history, or
   * lands after and starts afresh; it never loses its own grant.
   * Returns whether the history went.
   */
  async revokeGrant(userId: number, chatId: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM grants WHERE user_id = ? AND chat_id = ?").bind(userId, chatId),
      ...this.purgeOrphanStatements(chatId),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  }

  private purgeOrphanStatements(chatId: number): D1PreparedStatement[] {
    return HISTORY_TABLES.map((table) =>
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE chat_id = ?1
           AND NOT EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)`,
        )
        .bind(chatId),
    );
  }

  async touchGrant(userId: number, chatId: number): Promise<void> {
    await this.db
      .prepare("UPDATE grants SET verified_at = ? WHERE user_id = ? AND chat_id = ?")
      .bind(nowSeconds(), userId, chatId)
      .run();
  }

  // --- messages ------------------------------------------------------------

  /**
   * Store a message — but only while its chat is tracked, decided in the same
   * statement. Telegram delivers updates in parallel, so a separate "is this
   * chat tracked?" read could be stale by the time of the write (a revoke in
   * between would leave orphaned history behind). Inside one statement it
   * cannot be.
   *
   * Idempotent: Telegram retries a webhook it thinks failed. An edit that
   * overtook its original has already inserted the row; the original then
   * changes nothing.
   */
  async insertMessage(message: StoredMessage, guard: Guard): Promise<boolean> {
    const [condition, ...guardValues] = guardSql(guard, message.chat_id);
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
           SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
           ON CONFLICT (chat_id, message_id) DO NOTHING`,
        )
        .bind(...messageValues(message), ...guardValues),
      this.markDayStatement(message, condition, guardValues),
    ]);
    return (inserted.meta.changes ?? 0) > 0;
  }

  /** Costs a write only for a chat's first message of a day (or an earlier one). */
  private markDayStatement(
    message: Pick<StoredMessage, "chat_id" | "message_id" | "date">,
    condition: string,
    guardValues: unknown[],
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO day_marks (chat_id, day, first_id)
         SELECT ?, ?, ? WHERE ${condition}
         ON CONFLICT (chat_id, day) DO UPDATE SET first_id = excluded.first_id
         WHERE excluded.first_id < first_id`,
      )
      .bind(message.chat_id, Math.floor(message.date / DAY), message.message_id, ...guardValues);
  }

  /**
   * The lowest message id that can be dated at or after `since` in each chat.
   * Ids grow within a chat, so a scan can start there. Chats with nothing
   * since then get +Infinity (MAX_SAFE_INTEGER): nothing to scan.
   */
  async idFloors(chatIds: number[], since: number[]): Promise<number[]> {
    if (!chatIds.length) return [];
    const results = await this.db.batch<{ first_id: number }>(
      chatIds.map((chatId, index) =>
        this.db
          .prepare(
            "SELECT first_id FROM day_marks WHERE chat_id = ? AND day >= ? ORDER BY day LIMIT 1",
          )
          .bind(chatId, Math.floor(since[index] / DAY)),
      ),
    );
    return results.map((result) => result.results[0]?.first_id ?? Number.MAX_SAFE_INTEGER);
  }

  /** An edit replaces the content; a message we never stored is stored now. */
  async upsertEditedMessage(message: StoredMessage, guard: Guard): Promise<void> {
    const [condition, ...guardValues] = guardSql(guard, message.chat_id);
    await this.db
      .prepare(
        `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
         SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
         ON CONFLICT (chat_id, message_id) DO UPDATE SET
           text = excluded.text,
           text_lc = excluded.text_lc,
           edited_at = excluded.edited_at,
           quote = COALESCE(excluded.quote, quote),
           mentions_bot = MAX(mentions_bot, excluded.mentions_bot),
           file_kind = COALESCE(excluded.file_kind, file_kind),
           file_id = COALESCE(excluded.file_id, file_id),
           file_name = COALESCE(excluded.file_name, file_name),
           file_mime = COALESCE(excluded.file_mime, file_mime),
           file_size = COALESCE(excluded.file_size, file_size)`,
      )
      .bind(...messageValues(message), ...guardValues)
      .run();
  }

  /** The bot changed one of its own messages through the MCP. */
  async updateOutgoing(
    chatId: number,
    messageId: number,
    change: { text?: string; buttons?: string | null; markChoice?: boolean },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (change.text !== undefined) {
      sets.push("text = ?", "text_lc = ?");
      values.push(change.text, normalize(change.text));
    }
    if (change.buttons !== undefined) {
      sets.push("buttons = ?");
      values.push(change.buttons);
    }
    if (change.markChoice !== undefined) {
      sets.push("mark_choice = ?");
      values.push(change.markChoice ? 1 : 0);
    }
    if (!sets.length) return;
    sets.push("edited_at = ?");
    values.push(nowSeconds());
    await this.db
      .prepare(`UPDATE messages SET ${sets.join(", ")} WHERE chat_id = ? AND message_id = ?`)
      .bind(...values, chatId, messageId)
      .run();
  }

  async getMessage(chatId: number, messageId: number): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
      .bind(chatId, messageId)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** Several messages of one chat by id, in one primary-key query. */
  async getMessages(chatId: number, messageIds: number[]): Promise<StoredMessage[]> {
    const ids = [...new Set(messageIds)].slice(0, 90);
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND message_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(chatId, ...ids)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.db.batch(
      ["messages", "button_presses", "reactions"].map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE chat_id = ? AND message_id = ?`)
          .bind(chatId, messageId),
      ),
    );
  }

  /** idFloors, skipping the lookup for windows that start at the beginning. */
  private async windowFloors(chatIds: number[], starts: number[]): Promise<number[]> {
    const needed = chatIds.map((_, index) => index).filter((index) => starts[index] > 0);
    const floors = chatIds.map(() => 0);
    const found = await this.idFloors(
      needed.map((index) => chatIds[index]),
      needed.map((index) => starts[index]),
    );
    needed.forEach((index, position) => (floors[index] = found[position]));
    return floors;
  }

  async search(query: SearchQuery): Promise<StoredMessage[]> {
    const scopes = query.scopes.slice(0, MAX_SCOPES);
    if (!scopes.length) return [];

    const where: string[] = [];
    const values: unknown[] = [];

    // Each chat is scanned from the first message of the window's first day.
    const starts = scopes.map((scope) => Math.max(scope.visible_from, query.since ?? 0));
    const floors = await this.windowFloors(
      scopes.map((scope) => scope.chat_id),
      starts,
    );
    where.push(
      `(${scopes.map(() => "(chat_id = ? AND message_id >= ? AND date >= ?)").join(" OR ")})`,
    );
    scopes.forEach((scope, index) => values.push(scope.chat_id, floors[index], starts[index]));

    for (const keyword of query.keywords.slice(0, 10)) {
      where.push("text_lc LIKE ? ESCAPE '\\'");
      values.push(likePattern(keyword));
    }

    if (query.from) {
      const from = query.from.trim().replace(/^@/, "");
      if (/^-?\d+$/.test(from)) {
        where.push("from_id = ?");
        values.push(Number(from));
      } else {
        where.push("(lower(from_username) = lower(?) OR instr(from_name, ?) > 0)");
        values.push(from, from);
      }
    }
    if (query.mentionsOnly) where.push("mentions_bot = 1");
    if (query.hasFile) where.push("file_id IS NOT NULL");
    if (query.fileKind) {
      where.push("file_kind = ?");
      values.push(query.fileKind);
    }
    if (query.threadId !== undefined) {
      where.push("thread_id = ?");
      values.push(query.threadId);
    }
    if (query.direction === "incoming") where.push("outgoing = 0");
    if (query.direction === "outgoing") where.push("outgoing = 1");
    if (query.since !== undefined) {
      where.push("date >= ?");
      values.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("date <= ?");
      values.push(query.until);
    }

    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where.join(" AND ")}
         ORDER BY date DESC, message_id DESC LIMIT ?`,
      )
      .bind(...values, query.limit)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** Newest first, walking the primary key backwards from `beforeId`. */
  async recent(
    scope: Scope,
    options: { limit: number; beforeId?: number; since?: number; threadId?: number },
  ): Promise<StoredMessage[]> {
    const start = Math.max(scope.visible_from, options.since ?? 0);
    const [floor] = await this.windowFloors([scope.chat_id], [start]);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ?1 AND message_id < ?2 AND message_id >= ?6 AND date >= ?3
           AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id DESC LIMIT ?4`,
      )
      .bind(
        scope.chat_id,
        options.beforeId ?? Number.MAX_SAFE_INTEGER,
        start,
        options.limit,
        options.threadId ?? null,
        floor,
      )
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** Oldest first, forward from `afterId`. */
  async after(
    scope: Scope,
    afterId: number,
    limit: number,
    threadId?: number,
  ): Promise<StoredMessage[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ?1 AND message_id > ?2 AND date >= ?3 AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id ASC LIMIT ?4`,
      )
      .bind(scope.chat_id, afterId, scope.visible_from, limit, threadId ?? null)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /**
   * The first answer to `messageId`: a reply to it, or — when `fromId` is
   * given, in a private chat — anything that person wrote after it.
   */
  async answerTo(
    scope: Scope,
    messageId: number,
    fromId: number | null,
  ): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ?1 AND message_id > ?2 AND date >= ?3 AND outgoing = 0
           AND (reply_to_id = ?2 OR from_id = ?4)
         ORDER BY message_id ASC LIMIT 1`,
      )
      .bind(scope.chat_id, messageId, scope.visible_from, fromId ?? 0)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** The bot's latest message in a chat, looking back over the last few days only. */
  async lastOutgoing(chatId: number): Promise<StoredMessage | null> {
    const [floor] = await this.idFloors([chatId], [nowSeconds() - 3 * DAY]);
    const row = await this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND message_id >= ? AND outgoing = 1
         ORDER BY message_id DESC LIMIT 1`,
      )
      .bind(chatId, floor)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  async lastMessageDates(chatIds: number[]): Promise<Map<number, number>> {
    const dates = new Map<number, number>();
    if (!chatIds.length) return dates;
    // One query per chat: each is a single primary-key probe from the end.
    const rows = await this.db.batch<{ chat_id: number; date: number }>(
      chatIds.map((chatId) =>
        this.db
          .prepare(
            "SELECT chat_id, date FROM messages WHERE chat_id = ? ORDER BY message_id DESC LIMIT 1",
          )
          .bind(chatId),
      ),
    );
    for (const result of rows) {
      const row = result.results[0];
      if (row) dates.set(row.chat_id, row.date);
    }
    return dates;
  }

  // --- buttons and reactions -----------------------------------------------

  async insertPress(press: PressRow): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO button_presses (chat_id, message_id, callback_id, user_id, user_name, label, data, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        press.chat_id,
        press.message_id,
        press.callback_id,
        press.user_id,
        press.user_name,
        press.label,
        press.data,
        press.date,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async pressesFor(chatId: number, messageId: number): Promise<PressRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM button_presses WHERE chat_id = ? AND message_id = ? ORDER BY date, callback_id",
      )
      .bind(chatId, messageId)
      .all<PressRow>();
    return results;
  }

  async setReaction(reaction: ReactionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reactions (chat_id, message_id, user_id, user_name, emoji, date)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, message_id, user_id) DO UPDATE SET
           emoji = excluded.emoji, user_name = excluded.user_name, date = excluded.date`,
      )
      .bind(
        reaction.chat_id,
        reaction.message_id,
        reaction.user_id,
        reaction.user_name,
        reaction.emoji,
        reaction.date,
      )
      .run();
  }

  async deleteReaction(chatId: number, messageId: number, userId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM reactions WHERE chat_id = ? AND message_id = ? AND user_id = ?")
      .bind(chatId, messageId, userId)
      .run();
  }

  async reactionsFor(chatId: number, messageId: number): Promise<ReactionRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM reactions WHERE chat_id = ? AND message_id = ? ORDER BY date")
      .bind(chatId, messageId)
      .all<ReactionRow>();
    return results;
  }

  // --- forum topics --------------------------------------------------------

  /** Costs a write only when the name is new or changed. */
  async upsertTopic(chatId: number, threadId: number, name: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO topics (chat_id, thread_id, name, updated_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)
         ON CONFLICT (chat_id, thread_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
         WHERE name <> excluded.name`,
      )
      .bind(chatId, threadId, name, nowSeconds())
      .run();
  }

  async topics(chatIds: number[]): Promise<TopicRow[]> {
    if (!chatIds.length) return [];
    const ids = chatIds.slice(0, 90);
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, thread_id, name FROM topics WHERE chat_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY chat_id, name`,
      )
      .bind(...ids)
      .all<TopicRow>();
    return results;
  }

  // --- upload nonces -------------------------------------------------------

  /** True the first time a nonce is seen; false on any replay. */
  async useNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT INTO upload_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .bind(nonce, expiresAt)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // --- refresh sessions ----------------------------------------------------

  /**
   * Move a session from `generation` to the next, if that is still current
   * and it is not revoked. A session with no row yet is at generation 0.
   * False when another refresh got there first, or the token is stale.
   */
  async advanceRefresh(
    id: string,
    userId: number,
    generation: number,
    expiresAt: number,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at)
         VALUES (?1, ?2, ?3 + 1, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET
           generation = excluded.generation,
           rotated_at = excluded.rotated_at,
           expires_at = excluded.expires_at
         WHERE refresh_sessions.generation = ?3
           AND refresh_sessions.user_id = ?2
           AND refresh_sessions.revoked = 0
         RETURNING generation`,
      )
      .bind(id, userId, generation, nowSeconds(), expiresAt)
      .first<{ generation: number }>();
    return row !== null;
  }

  getRefreshSession(id: string): Promise<RefreshSessionRow | null> {
    return this.db
      .prepare("SELECT * FROM refresh_sessions WHERE id = ?")
      .bind(id)
      .first<RefreshSessionRow>();
  }

  /** Every refresh token of the session stops working. */
  async revokeRefreshSession(id: string, userId: number, expiresAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at, revoked)
         VALUES (?1, ?2, 0, ?3, ?4, 1)
         ON CONFLICT (id) DO UPDATE SET revoked = 1`,
      )
      .bind(id, userId, nowSeconds(), expiresAt)
      .run();
  }

  // --- retention -----------------------------------------------------------

  async purge(cutoff: number): Promise<number> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM messages WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM button_presses WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM reactions WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM upload_nonces WHERE expires_at < ?").bind(nowSeconds()),
      // A day past expiry: tokens can outlive their row by a few minutes, and
      // a session with no row would start afresh.
      this.db.prepare("DELETE FROM refresh_sessions WHERE expires_at < ?").bind(nowSeconds() - DAY),
      this.db.prepare("DELETE FROM day_marks WHERE day < ?").bind(Math.floor(cutoff / DAY)),
    ]);
    return results[0].meta.changes ?? 0;
  }
}
