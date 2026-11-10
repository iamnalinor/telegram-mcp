/**
 * Every SQL statement the connector runs.
 *
 * Kept in one place so the cost of each path is visible: D1 bills rows read
 * and written per account, and the free plan stops all queries for the rest
 * of the day once either cap is hit. See src/schema.ts for why `messages`
 * carries no secondary index.
 */

import { nowSeconds } from "./crypto";
import { redactSecrets } from "./secrets";

export interface StoredMessage {
  /** 0 for the bot's own chats; the user's id for their personal chats (see schema). */
  account_id: number;
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
  /** The inline bot the text came from ("via @gif"): the sender picked it, did not write it. */
  via_bot: string | null;
  /** Posted as the chat (an anonymous admin, a linked channel): no person is known. */
  as_chat: boolean;
  /** For the bot's own messages: the Claude Code cloud session that sent it (session_…). */
  session_id: string | null;
  /** For the bot's own messages: the session's subagent that sent it, by the name the session gave it. */
  agent?: string | null;
  /** Read only (markAwaited sets it): until when that session waits for an answer. */
  awaited_until?: number | null;
  /** Telegram's media_group_id: the photos and files sent together, shown as one message. */
  album?: string | null;
}

export interface StoredButton {
  text: string;
  data?: string;
  url?: string;
  /** A button that copies this text (guest answers): no press reaches the bot. */
  copy?: string;
  style?: "primary" | "success" | "danger";
}

interface MessageRow extends Omit<
  StoredMessage,
  "mentions_bot" | "outgoing" | "mark_choice" | "as_chat"
> {
  mentions_bot: number;
  outgoing: number;
  mark_choice: number;
  as_chat: number;
}

export interface Routine {
  user_id: number;
  trigger_id: string;
  token_enc: string;
  updated_at: number;
  /** The last test start: its session, and when. */
  test_session: string | null;
  test_at: number | null;
}

/** A session under an id the Worker gave it (src/agents/openai.ts, src/agents/codex.ts). */
export interface AgentSession {
  id: string;
  user_id: number;
  provider: string;
  external_id: string | null;
  kind: "chat" | "task";
  token_exp: number | null;
  created_at: number;
  /** What the user last heard of it from the provider's webhooks. */
  told: "failed" | "action" | null;
  /** The sign-in its MCP token hangs on, and the user's token version then. */
  signin: string | null;
  token_version: number | null;
  /** A task's: whom the chat session that started it acted for. */
  origin: RelayOrigin | null;
  /** A Codex thread's: 1 when it lives in the relay's sandbox, where only sandboxed runs reach it. */
  sandboxed: number | null;
}

/** The sign-ins the Worker's own sessions' MCP tokens hang on (src/oauth.ts `mintSessionToken`). */
export const AGENTS_SIGN_IN = "OpenAI agents";
export const CODEX_SIGN_IN = "Codex runs";

export interface ClaudeChat {
  chat_id: number;
  user_id: number;
  others: number;
  /** Other members' starts allowed per hour. */
  others_limit: number;
  since: number;
}

/** A start being claimed: whose routine, and what the log shows of it. */
export interface FireEntry {
  chatId: number;
  messageId: number;
  userId: number;
  byOther: boolean;
  fromName: string | null;
  /** The first words of the message, keys removed. */
  excerpt: string;
  /** An album starts once, whichever of its items comes first. */
  album: string | null;
  /** A scene's wake: its id, counted against the scene's own hourly limit. */
  sceneId?: number;
}

export interface RelayRow {
  user_id: number;
  token_hash: string;
  created_at: number;
  last_seen: number | null;
  login_failed_at: number | null;
  offline_noticed_at: number | null;
  /** What it said it can run, comma separated; null: a relay too old to say, Claude only. */
  runners: string | null;
}

/**
 * What the relay does with a job: pass it into a Claude cloud session, start
 * a Codex thread on the machine, or carry one on.
 */
export type Runner = "claude-continue" | "codex-start" | "codex-resume";

/** Who stands behind a message to a session, by the bot's records. */
export type RelayOrigin = "user" | "other" | "unknown";

export interface RelayJob {
  id: string;
  user_id: number;
  target_session: string;
  body: string;
  origin: RelayOrigin;
  from_session: string | null;
  /** For a Telegram reply passed on: where it was, so a failure can start a session instead. */
  chat_id: number | null;
  message_id: number | null;
  thread_id: number | null;
  status: "queued" | "taken" | "done" | "failed";
  error: string | null;
  /**
   * reply: a Telegram reply to the session's message; day: a message for the
   * chat's session of the day; guest: a call from a chat the bot is not in
   * (`message_id` is the call's id, `chat_id` 0); ask: from another session;
   * scene: a scene's wake (`chat_id` is the scene's id, `message_id` the event's number).
   */
  kind: "reply" | "day" | "guest" | "ask" | "scene";
  /** 1 when the sender waits for answer_session; a notice expects none. */
  wants_answer: number;
  runner: Runner;
  /** The runner's settings, JSON: model, sandbox, working directory. */
  params: string | null;
  answer: string | null;
  answered_at: number | null;
  created_at: number;
  taken_at: number | null;
}

/** A session the bot knows of: started by a tag, wrote through the bot, or was written to. */
export interface KnownSession {
  session_id: string;
  started?: {
    chat_id: number;
    at: number;
    from_name: string | null;
    excerpt: string | null;
    by_other: boolean;
  };
  wrote?: { chat_id: number; at: number; text: string };
  asked_at?: number;
}

/**
 * Chats the bot is called in as a guest are filed under keys of their own,
 * above any id Telegram gives out: such a chat's id may coincide with one of
 * the bot's chats. `GUEST_BASE + guest_chats.id`.
 */
export const GUEST_BASE = 8_000_000_000_000_000;

export const isGuestKey = (chatId: number): boolean => chatId >= GUEST_BASE;

export interface GuestChat {
  id: number;
  chat_id: number;
  chat_type: string;
  title: string | null;
}

/** A call on the bot from a chat it is not in (guest mode). */
export interface GuestCall {
  id: number;
  /** The chat's holder: whose routine answers there. */
  user_id: number;
  chat_key: number;
  query_id: string;
  /** The bot's one message for this call; null until Telegram accepted the placeholder. */
  inline_message_id: string | null;
  from_id: number;
  from_name: string | null;
  from_username: string | null;
  /** 1 when someone other than the holder called. */
  by_other: number;
  text: string;
  /** The attachment, as "kind name": guest chats' files are not fetched. */
  file: string | null;
  /** JSON of `GuestReply`: the message the call replied to. */
  reply: string | null;
  /** What the bot's message there says now. */
  answer: string | null;
  /** JSON of `StoredButton[][]`: the buttons on that message now, whose presses are recorded. */
  buttons: string | null;
  /** JSON of `GuestMedia`: the photo, video or file that message became, if it did. */
  media: string | null;
  /** The scene that runs on that message (create_scene guest_call); answers wait for its end. */
  scene_id: number | null;
  at: number;
}

/** What the bot's message for a guest call shows besides its text (answer_guest media). */
export interface GuestMedia {
  type: "photo" | "video" | "animation" | "audio" | "document";
  url: string;
}

export interface GuestReply {
  from_id: number | null;
  from_name: string | null;
  from_username: string | null;
  text: string;
  /** The bot's own earlier message there. */
  own: boolean;
}

export interface FireRow {
  message_id: number;
  /**
   * relayed: passed on to an existing session instead of a new one. joined:
   * came right after a start in the private chat, which reads it along.
   */
  status: "pending" | "started" | "relayed" | "joined" | "failed";
  session_id: string | null;
  at: number;
  from_name: string | null;
  excerpt: string | null;
}

export interface MemoryDoc {
  user_id: number;
  chat_id: number;
  content: string;
  updated_at: number;
  /** The assistant that last wrote it, by its sign-in name. */
  updated_by: string | null;
}

export interface MemoryChange {
  id: number;
  user_id: number;
  chat_id: number;
  /** Null when the document did not exist before the change. */
  content_before: string | null;
  changed_at: number;
  changed_by: string | null;
}

export interface MemoryNotice {
  user_id: number;
  chat_id: number;
  client: string;
  message_id: number;
  first_history_id: number;
  sent_at: number;
}

export interface RefreshSessionRow {
  id: string;
  user_id: number;
  generation: number;
  rotated_at: number;
  expires_at: number;
  revoked: number;
  /** Who the sign-in went to: "Claude", "ChatGPT", an app on this computer. Null before it was kept. */
  client_name: string | null;
  created_at: number | null;
}

/** What checking a token needs, in one read: the user, and the sign-in it belongs to. */
export interface TokenState {
  token_version: number;
  connected_at: number | null;
  username: string | null;
  first_name: string | null;
  /** Null when the token names no sign-in, or that sign-in has no row. */
  session_revoked: number | null;
  /** Who that sign-in went to, when known. */
  client_name: string | null;
}

export interface UserRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  language: string | null;
  token_version: number;
  created_at: number;
  connected_at: number | null;
  /** Whose sessions new starts go to; null: none chosen, and nothing starts. */
  active_provider: string | null;
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

/** A chat as seen from one account: the bot's (0), or a user's own via Telegram Business. */
export interface ChatRef {
  account_id: number;
  chat_id: number;
}

/** The bot's own account, which holds its private chats and every group. */
export const BOT_ACCOUNT = 0;

/** A Map key for a chat. */
export function refKey(ref: ChatRef): string {
  return `${ref.account_id}:${ref.chat_id}`;
}

/** One chat a search may look in, from the moment its reader is allowed to see. */
export interface Scope extends ChatRef {
  visible_from: number;
}

export interface BusinessRow {
  user_id: number;
  connection_id: string;
  /** JSON of BusinessBotRights. */
  rights: string;
  enabled: number;
  connected_at: number;
  updated_at: number;
}

export interface PersonalChatRow {
  account_id: number;
  chat_id: number;
  title: string | null;
  username: string | null;
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

/** How far apart an album's message ids can be: ten items, and others' messages between them. */
const ALBUM_SPAN = 30;

/** D1 refuses more than 100 bound parameters in one statement; a scope takes four. */
/** A scene (src/bot/scenes.ts): its compiled definition, state and live messages. */
export interface SceneRow {
  id: number;
  chat_id: number;
  thread_id: number | null;
  owner: number;
  /** The owner's name as presses show it ("This button is only for …"), kept so no read is needed. */
  owner_name: string | null;
  /** The session that set the scene up, or the latest one the owner's wakes started. */
  session_id: string | null;
  /** The session third parties' wakes go to: never the owner's own. */
  others_session_id: string | null;
  agent: string | null;
  title: string;
  brief: string | null;
  /** JSON of the compiled definition. */
  def: string;
  /** JSON of the state. */
  state: string;
  version: number;
  status: "active" | "finished";
  /** The view the main message shows. */
  view: string;
  /** JSON of `SceneMessage[]`: the live messages, the main one first. */
  messages: string;
  wake_limit: number;
  /** Milliseconds: Telegram asked the bot to wait; no edits until then. */
  quiet_until: number;
  /** 1 when an edit is owed: it was held back to keep to one a second. */
  dirty: number;
  /** Milliseconds: the last edit. */
  edited_at: number;
  /** JSON of the times (seconds) of recent posts, for the per-minute limit. */
  posts: string | null;
  /** JSON of the scene's open poll: `{ message_id, poll_id }`. */
  poll: string | null;
  /** The last press committed: a redelivered update is not applied twice. */
  last_query: string | null;
  /** The saved scene it was started from, or saved as, and that scene's version then. */
  template_id: number | null;
  template_version: number | null;
  /**
   * In a chat the bot is not in: the bot's one message there (a guest call's),
   * which the scene has for its only live message; `chat_id` is the guest key.
   */
  inline_id: string | null;
  created: number;
  updated: number;
}

/** A saved scene: a definition as written, to start again or change. */
export interface SceneTemplateRow {
  id: number;
  owner: number;
  name: string;
  title: string;
  brief: string | null;
  /** JSON of the definition as written. */
  definition: string;
  version: number;
  uses: number;
  /** 1 when saved on purpose (save_scene): a full library never drops it. */
  kept: number;
  /** A hash of the definition but for its title and state. */
  shape: string | null;
  created: number;
  updated: number;
  /** When it last started a scene. */
  used: number;
}

export type SceneTemplateEntry = Omit<SceneTemplateRow, "definition" | "shape">;

export interface SceneMessage {
  id: number;
  view: string;
}

export interface SceneEventRow {
  scene_id: number;
  seq: number;
  name: string;
  user_id: number | null;
  user_name: string | null;
  data: string | null;
  date: number;
  woke: number;
}

export interface ScenePatch {
  state?: string;
  view?: string;
  status?: "active" | "finished";
  messages?: string;
  dirty?: number;
  edited_at?: number;
  quiet_until?: number;
  posts?: string;
  last_query?: string;
}

export const MAX_SCOPES = 20;

function toMessage(row: MessageRow): StoredMessage {
  return {
    ...row,
    mentions_bot: row.mentions_bot === 1,
    outgoing: row.outgoing === 1,
    mark_choice: row.mark_choice === 1,
    as_chat: row.as_chat === 1,
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
  "account_id",
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
  "via_bot",
  "as_chat",
  "session_id",
  "album",
  "agent",
] as const;

function messageValues(message: StoredMessage): unknown[] {
  const text = redactSecrets(message.text);
  return [
    message.account_id,
    message.chat_id,
    message.message_id,
    message.date,
    message.edited_at,
    message.thread_id,
    message.from_id,
    message.from_name,
    message.from_username,
    message.forwarded_from,
    text,
    normalize(text),
    message.reply_to_id,
    redactSecrets(message.quote),
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
    message.via_bot,
    message.as_chat ? 1 : 0,
    message.session_id,
    message.album ?? null,
    message.agent ?? null,
  ];
}

/**
 * When a message may be written: always (the bot's own, sent through the
 * MCP), while a private chat's owner is registered, while a group has at
 * least one grant, or while a user's business connection is on.
 */
export type Guard = "always" | "dm" | "group" | "personal";

function guardSql(guard: Guard, message: ChatRef): [string, ...unknown[]] {
  switch (guard) {
    case "always":
      return ["1"];
    case "dm":
      return ["EXISTS (SELECT 1 FROM users WHERE user_id = ?)", message.chat_id];
    case "group":
      return ["EXISTS (SELECT 1 FROM grants WHERE chat_id = ?)", message.chat_id];
    case "personal":
      return [personalOn("?"), message.account_id];
  }
}

/**
 * A user's personal chats are stored while their business connection is on
 * and they have signed an assistant in; before that, nobody could read them.
 */
function personalOn(userParam: string): string {
  return `EXISTS (
    SELECT 1 FROM business_connections b JOIN users u ON u.user_id = b.user_id
    WHERE b.user_id = ${userParam} AND b.enabled = 1 AND u.connected_at IS NOT NULL
  )`;
}

/** Events a scene keeps; older ones go as new ones come. */
const SCENE_EVENTS_KEPT = 200;

/** Tables of a group's own, keyed by chat id alone. */
const GROUP_TABLES = [
  "grants",
  "button_presses",
  "reactions",
  "topics",
  "chats",
  "claude_chats",
  "fires",
];
/** Tables keyed by account too; a group's rows sit under the bot's account. */
const ACCOUNT_TABLES = ["messages", "day_marks"];
const HISTORY_TABLES = ["button_presses", "reactions", "topics", "chats"];
/** Tables keyed by user and chat: what one user keeps about one chat. */
const USER_CHAT_TABLES = ["memory_docs", "memory_history", "memory_notices"];
/** How many earlier versions of a memory document are kept for undo. */
const MEMORY_VERSIONS = 20;
/** How many earlier versions of a saved scene are kept. */
const TEMPLATE_VERSIONS = 20;

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

  /**
   * The menu asked the user to type a number (a limit) for `target`: `g:<chat>`,
   * `q:<guest key>` or `s:<scene>`; or a directory, `cw`: Codex's working one.
   * One pending prompt per user; a newer one replaces it.
   */
  async setLimitPrompt(userId: number, target: string, promptMessageId: number): Promise<void> {
    await this.setMeta(`limit_prompt:${userId}`, `${target}:${promptMessageId}`);
  }

  /** What the prompt the user replied to was for, or null when it is not the pending one. */
  async takeLimitPrompt(userId: number, promptMessageId: number): Promise<string | null> {
    const value = await this.getMeta(`limit_prompt:${userId}`);
    const match = value ? /^(.+):(\d+)$/.exec(value) : null;
    return match && Number(match[2]) === promptMessageId ? match[1] : null;
  }

  async dropLimitPrompt(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM meta WHERE key = ?").bind(`limit_prompt:${userId}`).run();
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

  /**
   * Every token of the user stops working, and their sign-ins leave the list.
   * Their scenes go on: a scene is the user's and runs without an assistant.
   */
  async bumpTokenVersion(userId: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE users SET token_version = token_version + 1 WHERE user_id = ?")
        .bind(userId),
      this.db
        .prepare("UPDATE refresh_sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0")
        .bind(userId),
    ]);
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

  /** Forget a group entirely: the bot left, or nobody has access any more. */
  async deleteChat(chatId: number): Promise<void> {
    await this.db.batch([
      ...this.dropScenesStatements("chat_id = ?", [chatId]),
      ...USER_CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId),
      ),
      ...GROUP_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(chatId),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE account_id = ? AND chat_id = ?`)
          .bind(BOT_ACCOUNT, chatId),
      ),
    ]);
  }

  /** A group became a supergroup and got a new id; carry everything over. */
  async migrateChat(from: number, to: number): Promise<void> {
    await this.db.batch([
      // Scenes move along; a reply or reaction finds them by "<chat>:<message>".
      this.db.prepare("UPDATE scenes SET chat_id = ?2 WHERE chat_id = ?1").bind(from, to),
      this.db
        .prepare(
          `UPDATE OR IGNORE scene_links SET key = ?2 || ':' || substr(key, length(?1) + 2)
           WHERE kind = 'message' AND substr(key, 1, length(?1) + 1) = ?1 || ':'`,
        )
        .bind(String(from), String(to)),
      ...[
        "grants",
        "button_presses",
        "reactions",
        "topics",
        "claude_chats",
        ...USER_CHAT_TABLES,
      ].map((table) =>
        this.db
          .prepare(`UPDATE OR IGNORE ${table} SET chat_id = ?2 WHERE chat_id = ?1`)
          .bind(from, to),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(
            `UPDATE OR IGNORE ${table} SET chat_id = ?2 WHERE account_id = ?3 AND chat_id = ?1`,
          )
          .bind(from, to, BOT_ACCOUNT),
      ),
      this.db
        .prepare(
          `INSERT INTO chats (chat_id, type, title, username, is_forum, bot_is_admin, visible_history, updated_at)
           SELECT ?2, 'supergroup', title, username, is_forum, bot_is_admin, visible_history, updated_at
           FROM chats WHERE chat_id = ?1
           ON CONFLICT (chat_id) DO NOTHING`,
        )
        .bind(from, to),
      ...[...GROUP_TABLES, ...USER_CHAT_TABLES].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).bind(from),
      ),
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE account_id = ? AND chat_id = ?`)
          .bind(BOT_ACCOUNT, from),
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
      // What the user kept about the group goes with their access to it.
      ...USER_CHAT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE user_id = ? AND chat_id = ?`)
          .bind(userId, chatId),
      ),
      this.db
        .prepare("DELETE FROM claude_chats WHERE user_id = ? AND chat_id = ?")
        .bind(userId, chatId),
      // Their scenes there end with their access.
      this.finishScenesStatement("owner = ? AND chat_id = ?", [userId, chatId]),
      this.db.prepare("DELETE FROM grants WHERE user_id = ? AND chat_id = ?").bind(userId, chatId),
      ...this.purgeOrphanStatements(chatId),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  }

  private purgeOrphanStatements(chatId: number): D1PreparedStatement[] {
    return [
      ...ACCOUNT_TABLES.map((table) =>
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE account_id = ?2 AND chat_id = ?1
             AND NOT EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)`,
          )
          .bind(chatId, BOT_ACCOUNT),
      ),
      // `chats` goes last: revokeGrant reads the last statement's changes.
      ...HISTORY_TABLES.map((table) =>
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE chat_id = ?1
             AND NOT EXISTS (SELECT 1 FROM grants WHERE chat_id = ?1)`,
          )
          .bind(chatId),
      ),
    ];
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
    const [condition, ...guardValues] = guardSql(guard, message);
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
           SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
           ON CONFLICT (account_id, chat_id, message_id) DO NOTHING`,
        )
        .bind(...messageValues(message), ...guardValues),
      this.markDayStatement(message, condition, guardValues),
    ]);
    return (inserted.meta.changes ?? 0) > 0;
  }

  /** Costs a write only for a chat's first message of a day (or an earlier one). */
  private markDayStatement(
    message: Pick<StoredMessage, "account_id" | "chat_id" | "message_id" | "date">,
    condition: string,
    guardValues: unknown[],
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO day_marks (account_id, chat_id, day, first_id)
         SELECT ?, ?, ?, ? WHERE ${condition}
         ON CONFLICT (account_id, chat_id, day) DO UPDATE SET first_id = excluded.first_id
         WHERE excluded.first_id < first_id`,
      )
      .bind(
        message.account_id,
        message.chat_id,
        Math.floor(message.date / DAY),
        message.message_id,
        ...guardValues,
      );
  }

  /**
   * The lowest message id that can be dated at or after `since` in each chat:
   * the lowest first id of the days from then on. Not the first of those days'
   * alone — ids mostly grow with time, but not always: a group that became a
   * supergroup counts from 1 again, and a replied-to message is stored late.
   * Chats with nothing since then get +Infinity (MAX_SAFE_INTEGER): nothing to
   * scan.
   */
  async idFloors(chats: ChatRef[], since: number[]): Promise<number[]> {
    if (!chats.length) return [];
    const results = await this.db.batch<{ first_id: number | null }>(
      chats.map((chat, index) =>
        this.db
          .prepare(
            `SELECT MIN(first_id) AS first_id FROM day_marks
             WHERE account_id = ? AND chat_id = ? AND day >= ?`,
          )
          .bind(chat.account_id, chat.chat_id, Math.floor(since[index] / DAY)),
      ),
    );
    return results.map((result) => result.results[0]?.first_id ?? Number.MAX_SAFE_INTEGER);
  }

  /** An edit replaces the content; a message we never stored is stored now. */
  async upsertEditedMessage(message: StoredMessage, guard: Guard): Promise<void> {
    const [condition, ...guardValues] = guardSql(guard, message);
    await this.db
      .prepare(
        `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")})
         SELECT ${MESSAGE_COLUMNS.map(() => "?").join(", ")} WHERE ${condition}
         ON CONFLICT (account_id, chat_id, message_id) DO UPDATE SET
           text = excluded.text,
           text_lc = excluded.text_lc,
           edited_at = excluded.edited_at,
           quote = COALESCE(excluded.quote, quote),
           mentions_bot = MAX(mentions_bot, excluded.mentions_bot),
           file_kind = COALESCE(excluded.file_kind, file_kind),
           file_id = COALESCE(excluded.file_id, file_id),
           file_name = COALESCE(excluded.file_name, file_name),
           file_mime = COALESCE(excluded.file_mime, file_mime),
           file_size = COALESCE(excluded.file_size, file_size),
           album = COALESCE(excluded.album, album)`,
      )
      .bind(...messageValues(message), ...guardValues)
      .run();
  }

  /** The bot changed one of its own messages through the MCP. */
  async updateOutgoing(
    chat: ChatRef,
    messageId: number,
    change: { text?: string; buttons?: string | null; markChoice?: boolean },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (change.text !== undefined) {
      const text = redactSecrets(change.text);
      sets.push("text = ?", "text_lc = ?");
      values.push(text, normalize(text));
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
      .prepare(
        `UPDATE messages SET ${sets.join(", ")} WHERE account_id = ? AND chat_id = ? AND message_id = ?`,
      )
      .bind(...values, chat.account_id, chat.chat_id, messageId)
      .run();
  }

  /**
   * A session is waiting for an answer to its message until `until`: a reply
   * in the meantime is the waiter's to take, not a new task. Written when a
   * wait starts and, if an answer comes early, when it ends — never per poll.
   * Messages no session sent carry nothing to route, so they cost no write.
   */
  async markAwaited(
    chat: ChatRef,
    messageId: number,
    until: number,
    change: "start" | "end",
  ): Promise<void> {
    const value =
      change === "start"
        ? "MAX(COALESCE(awaited_until, 0), ?)"
        : "MIN(COALESCE(awaited_until, ?), ?)";
    await this.db
      .prepare(
        `UPDATE messages SET awaited_until = ${value}
         WHERE account_id = ? AND chat_id = ? AND message_id = ? AND outgoing = 1
           AND session_id IS NOT NULL`,
      )
      .bind(
        ...(change === "start" ? [until] : [until, until]),
        chat.account_id,
        chat.chat_id,
        messageId,
      )
      .run();
  }

  async getMessage(chat: ChatRef, messageId: number): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare("SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND message_id = ?")
      .bind(chat.account_id, chat.chat_id, messageId)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** Several messages of one chat by id, in one primary-key query. */
  async getMessages(chat: ChatRef, messageIds: number[]): Promise<StoredMessage[]> {
    const ids = [...new Set(messageIds)].slice(0, 90);
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ?
         AND message_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(chat.account_id, chat.chat_id, ...ids)
      .all<MessageRow>();
    return results.map(toMessage);
  }

  /** The rest of an album, oldest first: Telegram sends its items one after another, at most ten. */
  async albumOf(message: StoredMessage): Promise<StoredMessage[]> {
    if (!message.album) return [message];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND album = ?
         AND message_id BETWEEN ? AND ? ORDER BY message_id`,
      )
      .bind(
        message.account_id,
        message.chat_id,
        message.album,
        message.message_id - ALBUM_SPAN,
        message.message_id + ALBUM_SPAN,
      )
      .all<MessageRow>();
    return results.length ? results.map(toMessage) : [message];
  }

  /** Forget messages, with their presses and reactions (which only the bot's account has). */
  async deleteMessages(chat: ChatRef, messageIds: number[]): Promise<void> {
    const ids = [...new Set(messageIds)].slice(0, 90);
    if (!ids.length) return;
    const list = ids.map(() => "?").join(", ");
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM messages WHERE account_id = ? AND chat_id = ? AND message_id IN (${list})`,
        )
        .bind(chat.account_id, chat.chat_id, ...ids),
      ...(chat.account_id === BOT_ACCOUNT
        ? ["button_presses", "reactions"].map((table) =>
            this.db
              .prepare(`DELETE FROM ${table} WHERE chat_id = ? AND message_id IN (${list})`)
              .bind(chat.chat_id, ...ids),
          )
        : []),
    ]);
  }

  /** idFloors, skipping the lookup for windows that start at the beginning. */
  private async windowFloors(chats: ChatRef[], starts: number[]): Promise<number[]> {
    const needed = chats.map((_, index) => index).filter((index) => starts[index] > 0);
    const floors = chats.map(() => 0);
    const found = await this.idFloors(
      needed.map((index) => chats[index]),
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
    const floors = await this.windowFloors(scopes, starts);
    where.push(
      `(${scopes
        .map(() => "(account_id = ? AND chat_id = ? AND message_id >= ? AND date >= ?)")
        .join(" OR ")})`,
    );
    scopes.forEach((scope, index) =>
      values.push(scope.account_id, scope.chat_id, floors[index], starts[index]),
    );

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
    const [floor] = await this.windowFloors([scope], [start]);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ?7 AND chat_id = ?1 AND message_id < ?2 AND message_id >= ?6
           AND date >= ?3 AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id DESC LIMIT ?4`,
      )
      .bind(
        scope.chat_id,
        options.beforeId ?? Number.MAX_SAFE_INTEGER,
        start,
        options.limit,
        options.threadId ?? null,
        floor,
        scope.account_id,
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
         WHERE account_id = ?6 AND chat_id = ?1 AND message_id > ?2 AND date >= ?3
           AND (?5 IS NULL OR thread_id = ?5)
         ORDER BY message_id ASC LIMIT ?4`,
      )
      .bind(scope.chat_id, afterId, scope.visible_from, limit, threadId ?? null, scope.account_id)
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
         WHERE account_id = ?5 AND chat_id = ?1 AND message_id > ?2 AND date >= ?3 AND outgoing = 0
           AND (reply_to_id = ?2 OR from_id = ?4)
         ORDER BY message_id ASC LIMIT 1`,
      )
      .bind(scope.chat_id, messageId, scope.visible_from, fromId ?? 0, scope.account_id)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** The bot's latest message in a chat, looking back over the last few days only. */
  /** Whether a session is waiting for an answer in this private chat, or was since `since`. */
  async awaitedIn(chatId: number, since: number): Promise<boolean> {
    const chat = { account_id: BOT_ACCOUNT, chat_id: chatId };
    const [floor] = await this.idFloors([chat], [nowSeconds() - DAY]);
    const row = await this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1 AND awaited_until >= ?
         LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor, since)
      .first();
    return row !== null;
  }

  async lastOutgoing(chat: ChatRef): Promise<StoredMessage | null> {
    const [floor] = await this.idFloors([chat], [nowSeconds() - 3 * DAY]);
    const row = await this.db
      .prepare(
        `SELECT * FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1
         ORDER BY message_id DESC LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /**
   * When the other side last wrote in a personal chat. Telegram lets a
   * business bot reply only within 24 hours of that, so this is read before
   * sending; it walks back from the newest message, so it costs little.
   */
  async lastIncoming(chat: ChatRef): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND outgoing = 0
         ORDER BY message_id DESC LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id)
      .first<MessageRow>();
    return row ? toMessage(row) : null;
  }

  /** Keyed by refKey. */
  async lastMessageDates(chats: ChatRef[]): Promise<Map<string, number>> {
    const dates = new Map<string, number>();
    if (!chats.length) return dates;
    // One query per chat: each is a single primary-key probe from the end.
    const rows = await this.db.batch<ChatRef & { date: number }>(
      chats.map((chat) =>
        this.db
          .prepare(
            `SELECT account_id, chat_id, date FROM messages WHERE account_id = ? AND chat_id = ?
             ORDER BY message_id DESC LIMIT 1`,
          )
          .bind(chat.account_id, chat.chat_id),
      ),
    );
    for (const result of rows) {
      const row = result.results[0];
      if (row) dates.set(refKey(row), row.date);
    }
    return dates;
  }

  // --- buttons and reactions -----------------------------------------------

  /** Record a press; with `cap`, only while the message has fewer presses than that. */
  async insertPress(press: PressRow, cap?: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO button_presses (chat_id, message_id, callback_id, user_id, user_name, label, data, date)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ?9 IS NULL
           OR (SELECT COUNT(*) FROM button_presses WHERE chat_id = ?1 AND message_id = ?2) < ?9
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
        cap ?? null,
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

  // --- business connections and personal chats -----------------------------

  getBusinessConnection(userId: number): Promise<BusinessRow | null> {
    return this.db
      .prepare("SELECT * FROM business_connections WHERE user_id = ?")
      .bind(userId)
      .first<BusinessRow>();
  }

  businessConnectionById(connectionId: string): Promise<BusinessRow | null> {
    return this.db
      .prepare("SELECT * FROM business_connections WHERE connection_id = ?")
      .bind(connectionId)
      .first<BusinessRow>();
  }

  /**
   * Record a connection as Telegram reports it. A user has one connection
   * with the bot at a time; a new id (they reconnected) replaces the old one.
   */
  async upsertBusinessConnection(row: {
    user_id: number;
    connection_id: string;
    rights: string;
    enabled: boolean;
  }): Promise<void> {
    const now = nowSeconds();
    await this.db.batch([
      // A stale row of another user can hold this id only if Telegram reused it; it must go.
      this.db
        .prepare("DELETE FROM business_connections WHERE connection_id = ? AND user_id <> ?")
        .bind(row.connection_id, row.user_id),
      this.db
        .prepare(
          `INSERT INTO business_connections (user_id, connection_id, rights, enabled, connected_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT (user_id) DO UPDATE SET
             connection_id = excluded.connection_id,
             rights = excluded.rights,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .bind(row.user_id, row.connection_id, row.rights, row.enabled ? 1 : 0, now),
    ]);
  }

  /** The connection is gone: forget it and every personal message it brought, in one go. */
  async dropPersonal(accountId: number): Promise<void> {
    if (accountId === BOT_ACCOUNT) return;
    await this.db.batch([
      this.db.prepare("DELETE FROM business_connections WHERE user_id = ?").bind(accountId),
      ...[...ACCOUNT_TABLES, "personal_chats"].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(accountId),
      ),
    ]);
  }

  /** Users with a stored business connection, for dropping those no longer allowed. */
  async businessUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT user_id FROM business_connections")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  /** Who a personal chat is with. Costs a write only when the name changed. */
  async upsertPersonalChat(chat: PersonalChatRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO personal_chats (account_id, chat_id, title, username, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${personalOn("?1")}
         ON CONFLICT (account_id, chat_id) DO UPDATE SET
           title = excluded.title, username = excluded.username, updated_at = excluded.updated_at
         WHERE title IS NOT excluded.title OR username IS NOT excluded.username`,
      )
      .bind(chat.account_id, chat.chat_id, chat.title, chat.username, nowSeconds())
      .run();
  }

  async listPersonalChats(accountId: number): Promise<PersonalChatRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT account_id, chat_id, title, username FROM personal_chats WHERE account_id = ?",
      )
      .bind(accountId)
      .all<PersonalChatRow>();
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

  // --- memory ---------------------------------------------------------------

  getMemory(userId: number, chatId: number): Promise<MemoryDoc | null> {
    return this.db
      .prepare("SELECT * FROM memory_docs WHERE user_id = ? AND chat_id = ?")
      .bind(userId, chatId)
      .first<MemoryDoc>();
  }

  async listMemory(
    userId: number,
  ): Promise<{ chat_id: number; length: number; updated_at: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT chat_id, length(content) AS length, updated_at FROM memory_docs
         WHERE user_id = ? ORDER BY updated_at DESC`,
      )
      .bind(userId)
      .all<{ chat_id: number; length: number; updated_at: number }>();
    return results;
  }

  /**
   * Replace a document (null deletes it), keeping what it read before for
   * undo. Returns the id of that history entry.
   */
  async writeMemory(
    userId: number,
    chatId: number,
    content: string | null,
    by: string | null,
  ): Promise<number> {
    const now = nowSeconds();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO memory_history (user_id, chat_id, content_before, changed_at, changed_by)
           VALUES (?1, ?2, (SELECT content FROM memory_docs WHERE user_id = ?1 AND chat_id = ?2), ?3, ?4)
           RETURNING id`,
        )
        .bind(userId, chatId, now, by),
      content === null
        ? this.db
            .prepare("DELETE FROM memory_docs WHERE user_id = ? AND chat_id = ?")
            .bind(userId, chatId)
        : this.db
            .prepare(
              `INSERT INTO memory_docs (user_id, chat_id, content, updated_at, updated_by)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (user_id, chat_id) DO UPDATE SET
                 content = excluded.content,
                 updated_at = excluded.updated_at,
                 updated_by = excluded.updated_by`,
            )
            .bind(userId, chatId, content, now, by),
      this.db
        .prepare(
          `DELETE FROM memory_history WHERE user_id = ?1 AND chat_id = ?2 AND id NOT IN (
             SELECT id FROM memory_history WHERE user_id = ?1 AND chat_id = ?2
             ORDER BY id DESC LIMIT ?3)`,
        )
        .bind(userId, chatId, MEMORY_VERSIONS),
    ]);
    return (results[0].results[0] as { id: number }).id;
  }

  getMemoryChange(userId: number, id: number): Promise<MemoryChange | null> {
    return this.db
      .prepare("SELECT * FROM memory_history WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<MemoryChange>();
  }

  /** How many changes the document had after history entry `id`. */
  async memoryChangesAfter(userId: number, chatId: number, id: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_history WHERE user_id = ? AND chat_id = ? AND id > ?",
      )
      .bind(userId, chatId, id)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** One chat's memory, with its history and notices: nothing left to undo. */
  async deleteMemory(userId: number, chatId: number): Promise<void> {
    await this.db.batch(
      USER_CHAT_TABLES.map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE user_id = ? AND chat_id = ?`)
          .bind(userId, chatId),
      ),
    );
  }

  /** The user's whole memory, with its history and notices. */
  async wipeMemory(userId: number): Promise<void> {
    await this.db.batch(
      USER_CHAT_TABLES.map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
      ),
    );
  }

  getMemoryNotice(userId: number, chatId: number, client: string): Promise<MemoryNotice | null> {
    return this.db
      .prepare("SELECT * FROM memory_notices WHERE user_id = ? AND chat_id = ? AND client = ?")
      .bind(userId, chatId, client)
      .first<MemoryNotice>();
  }

  async setMemoryNotice(notice: MemoryNotice): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO memory_notices (user_id, chat_id, client, message_id, first_history_id, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id, chat_id, client) DO UPDATE SET
           message_id = excluded.message_id,
           first_history_id = excluded.first_history_id,
           sent_at = excluded.sent_at`,
      )
      .bind(
        notice.user_id,
        notice.chat_id,
        notice.client,
        notice.message_id,
        notice.first_history_id,
        notice.sent_at,
      )
      .run();
  }

  /** A notice was acted on: the next change gets a notice of its own. */
  async dropMemoryNotice(userId: number, messageId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM memory_notices WHERE user_id = ? AND message_id = ?")
      .bind(userId, messageId)
      .run();
  }

  // --- routines ------------------------------------------------------------

  getRoutine(userId: number): Promise<Routine | null> {
    return this.db
      .prepare("SELECT * FROM routines WHERE user_id = ?")
      .bind(userId)
      .first<Routine>();
  }

  async setRoutine(userId: number, triggerId: string, tokenEnc: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO routines (user_id, trigger_id, token_enc, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (user_id) DO UPDATE SET
           trigger_id = excluded.trigger_id, token_enc = excluded.token_enc,
           updated_at = excluded.updated_at, test_session = NULL, test_at = NULL`,
      )
      .bind(userId, triggerId, tokenEnc, nowSeconds())
      .run();
  }

  async setRoutineTest(userId: number, sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE routines SET test_session = ?, test_at = ? WHERE user_id = ?")
      .bind(sessionId, nowSeconds(), userId)
      .run();
  }

  /** Whether this session has sent anything to the chat since `since` — a test start answering. */
  async sessionSpokeIn(chatId: number, sessionId: string, since: number): Promise<boolean> {
    const chat = { account_id: BOT_ACCOUNT, chat_id: chatId };
    const [floor] = await this.idFloors([chat], [since]);
    const row = await this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE account_id = ? AND chat_id = ? AND message_id >= ? AND outgoing = 1 AND session_id = ?
         LIMIT 1`,
      )
      .bind(chat.account_id, chat.chat_id, floor, sessionId)
      .first();
    return row !== null;
  }

  async deleteRoutine(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM routines WHERE user_id = ?").bind(userId).run();
  }

  // --- other providers -----------------------------------------------------

  async getAgentConfig(userId: number, provider: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT config_enc FROM agent_configs WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .first<{ config_enc: string }>();
    return row?.config_enc ?? null;
  }

  /** When the user last changed that provider's settings; null when there are none. */
  async agentConfigSince(userId: number, provider: string): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT updated_at FROM agent_configs WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .first<{ updated_at: number }>();
    return row?.updated_at ?? null;
  }

  /** `hook`: a hash of the path the provider's webhooks come to, if it sends any. */
  async setAgentConfig(
    userId: number,
    provider: string,
    configEnc: string,
    hook: string | null = null,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_configs (user_id, provider, config_enc, updated_at, hook)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           config_enc = excluded.config_enc, updated_at = excluded.updated_at, hook = excluded.hook`,
      )
      .bind(userId, provider, configEnc, nowSeconds(), hook)
      .run();
  }

  /** Whose settings a webhook path belongs to, by its hash. */
  async agentByHook(hook: string): Promise<{ user_id: number; provider: string } | null> {
    return this.db
      .prepare("SELECT user_id, provider FROM agent_configs WHERE hook = ?")
      .bind(hook)
      .first<{ user_id: number; provider: string }>();
  }

  /** One provider's settings go, and the user's sessions with it end. */
  async deleteAgentConfig(userId: number, provider: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM agent_configs WHERE user_id = ? AND provider = ?")
        .bind(userId, provider),
      ...this.endAgentSessions(userId, provider),
    ]);
  }

  /** Every provider's settings and sessions of the user, and the choice between them. */
  async dropAgents(userId: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM agent_configs WHERE user_id = ?").bind(userId),
      ...this.endAgentSessions(userId, null),
      this.db.prepare("UPDATE users SET active_provider = NULL WHERE user_id = ?").bind(userId),
    ]);
  }

  /**
   * The user's sessions with a provider (any, when null) end: no message is
   * passed into them any more, and the sign-in their MCP tokens hang on is
   * revoked, so a session still running loses the tools at once. The next
   * session started gets a new sign-in.
   */
  private endAgentSessions(userId: number, provider: string | null): D1PreparedStatement[] {
    // Each provider's sessions hold tokens of a sign-in of its own (src/oauth.ts `mintSessionToken`).
    const signIns =
      provider === null
        ? [AGENTS_SIGN_IN, CODEX_SIGN_IN]
        : [provider === "codex" ? CODEX_SIGN_IN : AGENTS_SIGN_IN];
    return [
      ...signIns.map((name) =>
        this.db
          .prepare(
            "UPDATE refresh_sessions SET revoked = 1 WHERE user_id = ? AND client_name = ? AND revoked = 0",
          )
          .bind(userId, name),
      ),
      // What the relay was still to run for them is not run.
      this.db
        .prepare(
          `UPDATE relay_jobs SET status = 'failed', error = 'its provider was removed'
           WHERE user_id = ?1 AND status = 'queued' AND target_session IN (
             SELECT id FROM agent_sessions WHERE user_id = ?1 AND (?2 IS NULL OR provider = ?2))`,
        )
        .bind(userId, provider),
      this.db
        .prepare("DELETE FROM agent_sessions WHERE user_id = ?1 AND (?2 IS NULL OR provider = ?2)")
        .bind(userId, provider),
    ];
  }

  async agentUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT user_id FROM agent_configs")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  /** Null: none chosen. */
  async setActiveProvider(userId: number, provider: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE users SET active_provider = ? WHERE user_id = ?")
      .bind(provider, userId)
      .run();
  }

  /** Whether any assistant is set up to start for the user: a routine or another provider. */
  async hasAssistant(userId: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM routines WHERE user_id = ?1)
             OR EXISTS (SELECT 1 FROM agent_configs WHERE user_id = ?1) AS any`,
      )
      .bind(userId)
      .first<{ any: number }>();
    return row?.any === 1;
  }

  /**
   * A session about to be started, before the provider knows it
   * (`external_id` null). With `cap`, only while fewer than `cap` sessions of
   * its kind were started in the last hour: the count and the insert are one
   * statement, so two starts at once cannot both slip under it. The same id
   * again (a start retried) takes the row over. False when the cap is reached.
   */
  async reserveAgentSession(
    session: Omit<AgentSession, "created_at" | "told" | "external_id" | "sandboxed"> & {
      sandboxed?: boolean;
    },
    cap: number | null = null,
  ): Promise<boolean> {
    const now = nowSeconds();
    const result = await this.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, user_id, provider, kind, token_exp, signin, token_version, origin, created_at, sandboxed)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11
         WHERE ?10 IS NULL OR (SELECT COUNT(*) FROM agent_sessions
                                WHERE user_id = ?2 AND kind = ?4 AND created_at >= ?9 - 3600) < ?10
         ON CONFLICT (id) DO UPDATE SET token_exp = excluded.token_exp,
           signin = excluded.signin, token_version = excluded.token_version
         WHERE agent_sessions.user_id = excluded.user_id`,
      )
      .bind(
        session.id,
        session.user_id,
        session.provider,
        session.kind,
        session.token_exp,
        session.signin,
        session.token_version,
        session.origin,
        now,
        cap,
        session.sandboxed === undefined ? null : Number(session.sandboxed),
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** The provider took the start: its own id for the session. */
  async setAgentExternal(id: string, externalId: string): Promise<void> {
    await this.db
      .prepare("UPDATE agent_sessions SET external_id = ? WHERE id = ?")
      .bind(externalId, id)
      .run();
  }

  /** A reserved start the provider refused: it never was. */
  async dropReservedAgentSession(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM agent_sessions WHERE id = ? AND external_id IS NULL")
      .bind(id)
      .run();
  }

  /** The user's session by the Worker's id; null when it is not theirs or gone. */
  getAgentSession(userId: number, id: string): Promise<AgentSession | null> {
    return this.db
      .prepare("SELECT * FROM agent_sessions WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<AgentSession>();
  }

  /** The user's session by the provider's own id: a failure or a stuck session asks. */
  agentSessionByExternal(
    userId: number,
    provider: string,
    externalId: string,
  ): Promise<AgentSession | null> {
    return this.db
      .prepare(
        "SELECT * FROM agent_sessions WHERE user_id = ? AND provider = ? AND external_id = ?",
      )
      .bind(userId, provider, externalId)
      .first<AgentSession>();
  }

  /**
   * Note that the user was told this of the session; false when they were
   * already, or heard it failed (nothing comes after that).
   */
  async tellOnce(id: string, what: "failed" | "action"): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE agent_sessions SET told = ?2 WHERE id = ?1 AND told IS NOT ?2 AND told IS NOT 'failed'",
      )
      .bind(id, what)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * A message went into the session after all: a later action it waits for is
   * worth telling again. A failure stands.
   */
  async clearTold(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE agent_sessions SET told = NULL WHERE id = ? AND told = 'action'")
      .bind(id)
      .run();
  }

  /**
   * A session that never came to be (its start failed): what is queued for it
   * fails, and so do the starts in the log that went to it.
   */
  async failAgentSession(userId: number, session: string, error: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE relay_jobs SET status = 'failed', error = ?
           WHERE user_id = ? AND target_session = ? AND status = 'queued'`,
        )
        .bind(error, userId, session),
      this.db
        .prepare(
          `UPDATE fires SET status = 'failed'
           WHERE user_id = ? AND session_id = ? AND status IN ('started', 'relayed')`,
        )
        .bind(userId, session),
    ]);
  }

  /** The message whose start made the session, if a start in the log did. */
  firstFireOf(
    userId: number,
    sessionId: string,
  ): Promise<{ chat_id: number; message_id: number } | null> {
    return this.db
      .prepare(
        `SELECT chat_id, message_id FROM fires WHERE user_id = ? AND session_id = ?
         ORDER BY at LIMIT 1`,
      )
      .bind(userId, sessionId)
      .first<{ chat_id: number; message_id: number }>();
  }

  /** The session was handed a new MCP token: when it runs out, and what it hangs on. */
  async setAgentToken(
    id: string,
    token: { exp: number; signin: string; version: number },
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE agent_sessions SET token_exp = ?, signin = ?, token_version = ? WHERE id = ?",
      )
      .bind(token.exp, token.signin, token.version, id)
      .run();
  }

  // --- where Claude answers -------------------------------------------------

  getClaudeChat(chatId: number): Promise<ClaudeChat | null> {
    return this.db
      .prepare("SELECT * FROM claude_chats WHERE chat_id = ?")
      .bind(chatId)
      .first<ClaudeChat>();
  }

  /** Claude answers in the chat for this user, if nobody holds it yet. True when it is theirs. */
  async claimClaudeChat(userId: number, chatId: number): Promise<boolean> {
    await this.db
      .prepare(
        `INSERT INTO claude_chats (chat_id, user_id, since) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO NOTHING`,
      )
      .bind(chatId, userId, nowSeconds())
      .run();
    return (await this.getClaudeChat(chatId))?.user_id === userId;
  }

  async releaseClaudeChat(userId: number, chatId: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM claude_chats WHERE chat_id = ? AND user_id = ?")
        .bind(chatId, userId),
      // A chat the bot is not in is the holder's only by this claim: their scenes there end with it.
      ...(isGuestKey(chatId)
        ? [this.finishScenesStatement("owner = ? AND chat_id = ?", [userId, chatId])]
        : []),
    ]);
  }

  async setClaudeOthersLimit(userId: number, chatId: number, limit: number): Promise<void> {
    await this.db
      .prepare("UPDATE claude_chats SET others_limit = ? WHERE chat_id = ? AND user_id = ?")
      .bind(limit, chatId, userId)
      .run();
  }

  async setClaudeOthers(userId: number, chatId: number, others: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE claude_chats SET others = ? WHERE chat_id = ? AND user_id = ?")
      .bind(others ? 1 : 0, chatId, userId)
      .run();
  }

  /**
   * Some of the chats where Claude answers, for the daily check of their
   * holders. Random, and capped: each check of a group is a Bot API call, and
   * a Worker run makes only so many.
   */
  async someClaudeChats(limit: number): Promise<ClaudeChat[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM claude_chats ORDER BY RANDOM() LIMIT ?")
      .bind(limit)
      .all<ClaudeChat>();
    return results;
  }

  /** The chats where Claude answers for this user, and whether others may start it there. */
  async claudeChatsOf(userId: number): Promise<Map<number, boolean>> {
    const { results } = await this.db
      .prepare("SELECT chat_id, others FROM claude_chats WHERE user_id = ?")
      .bind(userId)
      .all<{ chat_id: number; others: number }>();
    return new Map(results.map((row) => [row.chat_id, row.others === 1]));
  }

  async dropClaudeChats(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM claude_chats WHERE user_id = ?").bind(userId).run();
  }

  // --- starts --------------------------------------------------------------

  /**
   * Claim the start for this message, within the hourly limits, in one
   * statement: Telegram delivers updates in parallel, and a burst of tags
   * checked first and written after would all pass. Failed starts do not
   * count against the limits.
   */
  async beginFire(
    fire: FireEntry,
    limits: { user: number; others: number; scene?: number },
  ): Promise<"claimed" | "again" | "limit"> {
    const now = nowSeconds();
    const result = await this.db
      .prepare(
        `INSERT INTO fires (chat_id, message_id, user_id, by_other, status, at, from_name, excerpt, album,
           scene_id)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?9, ?10, ?11, ?12
         WHERE (SELECT COUNT(*) FROM fires WHERE user_id = ?3 AND at >= ?6
                AND (status IN ('pending', 'started') OR (status = 'relayed' AND by_other = 1))) < ?7
           AND (?4 = 0 OR (SELECT COUNT(*) FROM fires
                WHERE user_id = ?3 AND at >= ?6 AND chat_id = ?1 AND by_other = 1
                  AND status IN ('pending', 'started', 'relayed')) < ?8)
           AND (?11 IS NULL OR NOT EXISTS (SELECT 1 FROM fires WHERE chat_id = ?1 AND album = ?11))
           AND (?12 IS NULL OR (SELECT COUNT(*) FROM fires WHERE user_id = ?3 AND scene_id = ?12
                AND at >= ?6 AND status IN ('pending', 'started', 'relayed')) < ?13)
         ON CONFLICT (chat_id, message_id) DO NOTHING`,
      )
      .bind(
        fire.chatId,
        fire.messageId,
        fire.userId,
        fire.byOther ? 1 : 0,
        now,
        now - 3600,
        limits.user,
        limits.others,
        fire.fromName,
        fire.excerpt,
        fire.album,
        fire.sceneId ?? null,
        limits.scene ?? 0,
      )
      .run();
    if ((result.meta.changes ?? 0) > 0) return "claimed";
    const seen = await this.db
      .prepare("SELECT 1 FROM fires WHERE chat_id = ?1 AND (message_id = ?2 OR album = ?3) LIMIT 1")
      .bind(fire.chatId, fire.messageId, fire.album)
      .first();
    return seen ? "again" : "limit";
  }

  /** A start claimed for nothing (a waking rule that did not wake after all): as if never claimed. */
  async dropFire(chatId: number, messageId: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM fires WHERE chat_id = ? AND message_id = ? AND status = 'pending'")
      .bind(chatId, messageId)
      .run();
  }

  /** When the oldest start that counts against the user's hourly limit was made. */
  async oldestStart(userId: number, since: number): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT MIN(at) AS at FROM fires WHERE user_id = ? AND at >= ?
         AND status IN ('pending', 'started', 'relayed')`,
      )
      .bind(userId, since)
      .first<{ at: number | null }>();
    return row?.at ?? null;
  }

  async endFire(
    chatId: number,
    messageId: number,
    outcome: { status: "started" | "relayed"; sessionId: string } | { status: "failed" | "joined" },
  ): Promise<void> {
    await this.db
      .prepare("UPDATE fires SET status = ?, session_id = ? WHERE chat_id = ? AND message_id = ?")
      .bind(outcome.status, "sessionId" in outcome ? outcome.sessionId : null, chatId, messageId)
      .run();
  }

  /**
   * Record a start held back by the limit. True when it is the first in this
   * chat within the hour: the holder hears about it once, not per message.
   */
  async noteLimited(fire: FireEntry): Promise<boolean> {
    const now = nowSeconds();
    const [earlier] = await this.db.batch([
      this.db
        .prepare(
          "SELECT 1 FROM fires WHERE chat_id = ? AND by_other = ? AND status = 'limited' AND at >= ? LIMIT 1",
        )
        .bind(fire.chatId, fire.byOther ? 1 : 0, now - 3600),
      this.db
        .prepare(
          `INSERT INTO fires (chat_id, message_id, user_id, by_other, status, at, from_name, excerpt, album)
           VALUES (?, ?, ?, ?, 'limited', ?, ?, ?, ?) ON CONFLICT (chat_id, message_id) DO NOTHING`,
        )
        .bind(
          fire.chatId,
          fire.messageId,
          fire.userId,
          fire.byOther ? 1 : 0,
          now,
          fire.fromName,
          fire.excerpt,
          fire.album,
        ),
    ]);
    return earlier.results.length === 0;
  }

  /**
   * The holder's latest starts in a chat, newest first: the chat's log. Tags
   * held back by the limit are only counted, so a flood of them cannot push
   * the real starts out of sight.
   */
  async firesIn(
    userId: number,
    chatId: number,
    limit: number,
    since: number,
  ): Promise<{ fires: FireRow[]; limited: number }> {
    const [fires, limited] = await this.db.batch([
      this.db
        .prepare(
          `SELECT message_id, status, session_id, at, from_name, excerpt FROM fires
           WHERE chat_id = ? AND user_id = ? AND status != 'limited'
           ORDER BY at DESC, message_id DESC LIMIT ?`,
        )
        .bind(chatId, userId, limit),
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM fires WHERE chat_id = ? AND user_id = ? AND status = 'limited' AND at >= ?",
        )
        .bind(chatId, userId, since),
    ]);
    return {
      fires: fires.results as FireRow[],
      limited: (limited.results[0] as { n: number } | undefined)?.n ?? 0,
    };
  }

  /**
   * A start for an earlier message in this chat since `since`: a session about
   * to read this one along. Earlier only — two messages handled at once must
   * not both wait on the other.
   */
  async recentStart(chatId: number, messageId: number, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM fires WHERE chat_id = ? AND message_id < ? AND message_id > 0 AND at >= ?
         AND status IN ('pending', 'started') LIMIT 1`,
      )
      .bind(chatId, messageId, since)
      .first();
    return row !== null;
  }

  /**
   * The session messages in these chats went to most recently since `since`:
   * the holder's own, or the one other members' messages go to. The two are
   * kept apart, so a session the user works in never hears a third party.
   * Only a session started for that audience in these chats counts: a reply
   * passed into someone else's session must not make it theirs for the day.
   * A session a scene woke was told to read the scene, not the chat: it is no
   * chat's session of the day.
   */
  async latestSession(
    userId: number,
    chatIds: number[],
    since: number,
    byOther: boolean,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT f.session_id FROM fires f WHERE f.user_id = ?1 AND f.at >= ?2 AND f.by_other = ?3
         AND f.chat_id IN (${chatIds.map((_, i) => `?${i + 4}`).join(", ")})
         AND f.status IN ('started', 'relayed') AND f.session_id IS NOT NULL AND f.scene_id IS NULL
         AND EXISTS (SELECT 1 FROM fires s WHERE s.user_id = ?1 AND s.session_id = f.session_id
                     AND s.status = 'started' AND s.by_other = ?3 AND s.scene_id IS NULL
                     AND s.chat_id IN (${chatIds.map((_, i) => `?${i + 4}`).join(", ")}))
         ORDER BY f.at DESC, f.message_id DESC LIMIT 1`,
      )
      .bind(userId, since, byOther ? 1 : 0, ...chatIds)
      .first<{ session_id: string }>();
    return row?.session_id ?? null;
  }

  /** Whether other members' starts already failed in this chat since `since`: the holder heard once. */
  async othersFailedSince(userId: number, chatId: number, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM fires WHERE user_id = ? AND at >= ? AND chat_id = ? AND by_other = 1
         AND status = 'failed' LIMIT 1`,
      )
      .bind(userId, since, chatId)
      .first();
    return row !== null;
  }

  async routineUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT user_id FROM routines")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  /** Users with any memory, for dropping those no longer allowed. */
  async memoryUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT user_id FROM memory_docs")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  // --- relay ---------------------------------------------------------------

  async getRelay(userId: number): Promise<RelayRow | null> {
    return this.db.prepare("SELECT * FROM relays WHERE user_id = ?").bind(userId).first<RelayRow>();
  }

  async relayByToken(tokenHash: string): Promise<RelayRow | null> {
    return this.db
      .prepare("SELECT * FROM relays WHERE token_hash = ?")
      .bind(tokenHash)
      .first<RelayRow>();
  }

  /** A new token: the old one stops working at once. */
  async setRelay(userId: number, tokenHash: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO relays (user_id, token_hash, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash,
           created_at = excluded.created_at, last_seen = NULL, login_failed_at = NULL,
           offline_noticed_at = NULL, runners = NULL`,
      )
      .bind(userId, tokenHash, nowSeconds())
      .run();
  }

  /** Removes the relay; the jobs it had not done fail and are returned. */
  async deleteRelay(userId: number): Promise<RelayJob[]> {
    const [, failed] = await this.db.batch([
      this.db.prepare("DELETE FROM relays WHERE user_id = ?").bind(userId),
      this.db
        .prepare(
          `UPDATE relay_jobs SET status = 'failed', error = 'the relay was turned off'
           WHERE user_id = ? AND status IN ('queued', 'taken') RETURNING *`,
        )
        .bind(userId),
    ]);
    return failed.results as RelayJob[];
  }

  /** The relay asked for work: it is alive. Written at most every 30 s. */
  async touchRelay(userId: number, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE relays SET last_seen = ?1, offline_noticed_at = NULL
         WHERE user_id = ?2 AND (last_seen IS NULL OR last_seen < ?1 - 30)`,
      )
      .bind(now, userId)
      .run();
  }

  async setRelayLogin(userId: number, failedAt: number | null): Promise<void> {
    await this.db
      .prepare("UPDATE relays SET login_failed_at = ? WHERE user_id = ?")
      .bind(failedAt, userId)
      .run();
  }

  /** True when this call marked the relay as gone quiet: the user hears once per outage. */
  async noteRelayOffline(userId: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE relays SET offline_noticed_at = ? WHERE user_id = ? AND offline_noticed_at IS NULL",
      )
      .bind(now, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async enqueueJob(
    job: Pick<
      RelayJob,
      | "id"
      | "user_id"
      | "target_session"
      | "body"
      | "origin"
      | "from_session"
      | "chat_id"
      | "message_id"
      | "thread_id"
      | "wants_answer"
      | "kind"
    > &
      Partial<Pick<RelayJob, "runner" | "params">>,
    /** `done`: passed on already, by a provider that needs no relay (src/agents/openai.ts). */
    status: "queued" | "done" = "queued",
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO relay_jobs (id, user_id, target_session, body, origin, from_session,
           chat_id, message_id, thread_id, wants_answer, kind, status, created_at, runner, params)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        job.id,
        job.user_id,
        job.target_session,
        job.body,
        job.origin,
        job.from_session,
        job.chat_id,
        job.message_id,
        job.thread_id,
        job.wants_answer,
        job.kind,
        status,
        nowSeconds(),
        job.runner ?? "claude-continue",
        job.params ?? null,
      )
      .run();
  }

  /**
   * Hand the oldest queued jobs the relay can run (`runners`) to it, each
   * once. A Codex thread is carried on only once its start told the thread's
   * id, and only one job of a thread at a time: the rest wait their turn.
   * `thread`: that id, for a job that carries one on.
   */
  async takeJobs(
    userId: number,
    limit: number,
    runners: readonly Runner[],
    sandboxes: boolean,
  ): Promise<(RelayJob & { thread: string | null })[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'taken', taken_at = ?1
         WHERE id IN (SELECT j.id FROM relay_jobs j
                      LEFT JOIN agent_sessions s ON s.id = j.target_session
                      WHERE j.user_id = ?2 AND j.status = 'queued'
                        AND instr(?4, ',' || j.runner || ',') > 0
                        AND (?5 OR json_extract(j.params, '$.sandbox') IS NOT 'read-only')
                        AND (j.runner != 'codex-resume' OR (s.external_id IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM relay_jobs t
                                          WHERE t.user_id = ?2 AND t.status = 'taken'
                                            AND t.target_session = j.target_session)))
                      ORDER BY j.created_at, j.message_id LIMIT ?3)
         RETURNING *, (SELECT external_id FROM agent_sessions
                       WHERE id = relay_jobs.target_session) AS thread`,
      )
      .bind(nowSeconds(), userId, limit, `,${runners.join(",")},`, sandboxes ? 1 : 0)
      .all<RelayJob & { thread: string | null }>();
    return results.sort(
      (a, b) => a.created_at - b.created_at || (a.message_id ?? 0) - (b.message_id ?? 0),
    );
  }

  /** Sandboxed Codex jobs, queued for a relay that cannot sandbox: they fail now, not taken. */
  async failUnboxedJobs(userId: number, error: string): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', error = ?
         WHERE user_id = ? AND status = 'queued' AND runner IN ('codex-start', 'codex-resume')
           AND json_extract(params, '$.sandbox') = 'read-only' RETURNING *`,
      )
      .bind(error, userId)
      .all<RelayJob>();
    return results.sort(
      (a, b) => a.created_at - b.created_at || (a.message_id ?? 0) - (b.message_id ?? 0),
    );
  }

  /** What the relay said it can run, when that changed. */
  async setRelayRunners(userId: number, runners: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE relays SET runners = ? WHERE user_id = ?")
      .bind(runners, userId)
      .run();
  }

  /**
   * A Codex start the relay took told the thread's id: kept on the session,
   * whose queued messages can follow now. The first id told stands.
   */
  async setAgentThread(userId: number, session: string, thread: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE agent_sessions SET external_id = ? WHERE id = ? AND user_id = ? AND external_id IS NULL",
      )
      .bind(thread, session, userId)
      .run();
  }

  /** The relay's report on a job it took; null when it was not that relay's or not taken. */
  async finishJob(
    userId: number,
    id: string,
    outcome: { ok: boolean; error: string | null },
  ): Promise<RelayJob | null> {
    return this.db
      .prepare(
        `UPDATE relay_jobs SET status = ?, error = ?
         WHERE id = ? AND user_id = ? AND status = 'taken' RETURNING *`,
      )
      .bind(outcome.ok ? "done" : "failed", outcome.ok ? null : outcome.error, id, userId)
      .first<RelayJob>();
  }

  /**
   * Jobs gone stale, the oldest first, left as they are: each fails only when
   * what becomes of it is about to run (`expireJob`), so a sweep cut short
   * loses none. Claude's: queued ones nobody took since `queued` (the relay is
   * gone), and taken ones never reported since `taken` (it restarted or lost
   * the report). Codex's run for long: queued ones go stale after
   * `codexQueued` only while no relay that runs Codex was `online` since —
   * before that they may wait behind a running start, up to `codexHeld` — and
   * taken ones after `codexTaken`.
   */
  async staleJobs(
    cutoffs: {
      queued: number;
      taken: number;
      codexQueued: number;
      codexHeld: number;
      codexTaken: number;
      online: number;
    },
    limit: number,
  ): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `SELECT j.* FROM relay_jobs j
         WHERE (j.runner = 'claude-continue'
                AND ((j.status = 'queued' AND j.created_at < ?1)
                     OR (j.status = 'taken' AND j.taken_at < ?2)))
            OR (j.runner != 'claude-continue'
                AND ((j.status = 'queued' AND (j.created_at < ?4
                       OR (j.created_at < ?3 AND NOT EXISTS (
                         SELECT 1 FROM relays r WHERE r.user_id = j.user_id
                           AND r.last_seen >= ?6
                           AND instr(',' || r.runners || ',', ',codex,') > 0))))
                     OR (j.status = 'taken' AND j.taken_at < ?5)))
         ORDER BY j.created_at, j.message_id LIMIT ?7`,
      )
      .bind(
        cutoffs.queued,
        cutoffs.taken,
        cutoffs.codexQueued,
        cutoffs.codexHeld,
        cutoffs.codexTaken,
        cutoffs.online,
        limit,
      )
      .all<RelayJob>();
    return results;
  }

  /** A stale job fails, if it is still as it was found; null when it moved on meanwhile. */
  async expireJob(job: Pick<RelayJob, "id" | "status">): Promise<RelayJob | null> {
    return this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', error = ?
         WHERE id = ? AND status = ? RETURNING *`,
      )
      .bind(
        job.status === "queued" ? "the relay did not pick it up" : "the relay did not report back",
        job.id,
        job.status,
      )
      .first<RelayJob>();
  }

  /**
   * The day's messages still queued for a session that turned out gone: they
   * fail too, and the session started in its place reads them along.
   */
  async foldDayJobs(userId: number, session: string): Promise<RelayJob[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE relay_jobs SET status = 'failed', error = 'its session was gone; the new one reads it'
         WHERE user_id = ? AND target_session = ? AND kind = 'day' AND status = 'queued' RETURNING *`,
      )
      .bind(userId, session)
      .all<RelayJob>();
    return results;
  }

  async getJob(userId: number, id: string): Promise<RelayJob | null> {
    return this.db
      .prepare("SELECT * FROM relay_jobs WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<RelayJob>();
  }

  /** The first answer stands. False when there is no such question, it wants none, or it was answered. */
  async answerJob(userId: number, id: string, answer: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE relay_jobs SET answer = ?, answered_at = ?
         WHERE id = ? AND user_id = ? AND answer IS NULL AND wants_answer = 1`,
      )
      .bind(redactSecrets(answer), nowSeconds(), id, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Whether the user's routine started this session, and for whom. Null: not by a tag. */
  async sessionStart(userId: number, sessionId: string): Promise<{ by_other: boolean } | null> {
    const row = await this.db
      .prepare(
        "SELECT by_other FROM fires WHERE user_id = ? AND session_id = ? AND status = 'started' LIMIT 1",
      )
      .bind(userId, sessionId)
      .first<{ by_other: number }>();
    return row ? { by_other: row.by_other === 1 } : null;
  }

  /**
   * Whether anyone but the user has had messages relayed into this session —
   * scene wakes that others caused among them.
   */
  async sessionHeardOthers(userId: number, sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        // A scene's wake from the session's own act is no third party's word.
        `SELECT 1 FROM relay_jobs WHERE user_id = ?1 AND target_session = ?2 AND origin != 'user'
           AND (kind != 'scene' OR from_session IS NULL OR from_session != ?2) LIMIT 1`,
      )
      .bind(userId, sessionId)
      .first();
    return row !== null;
  }

  /** Sessions the bot knows of for this user, most recently heard of first. */
  async knownSessions(userId: number, limit: number): Promise<KnownSession[]> {
    const [started, wrote, asked] = await this.db.batch([
      this.db
        .prepare(
          `SELECT session_id, chat_id, at, from_name, excerpt, by_other FROM fires
           WHERE user_id = ? AND status = 'started' AND session_id IS NOT NULL
           ORDER BY at DESC LIMIT 200`,
        )
        .bind(userId),
      this.db
        .prepare(
          `SELECT session_id, chat_id, MAX(date) AS at, text FROM messages
           WHERE account_id = ? AND sent_by = ? AND session_id IS NOT NULL
           GROUP BY session_id ORDER BY at DESC LIMIT 200`,
        )
        .bind(BOT_ACCOUNT, userId),
      this.db
        .prepare(
          `SELECT target_session AS session_id, MAX(created_at) AS at FROM relay_jobs
           WHERE user_id = ? GROUP BY target_session ORDER BY at DESC LIMIT 200`,
        )
        .bind(userId),
    ]);
    const known = new Map<string, KnownSession>();
    const entry = (id: string) => known.get(id) ?? known.set(id, { session_id: id }).get(id)!;
    for (const row of started.results as {
      session_id: string;
      chat_id: number;
      at: number;
      from_name: string | null;
      excerpt: string | null;
      by_other: number;
    }[]) {
      const session = entry(row.session_id);
      session.started ??= { ...row, by_other: row.by_other === 1 };
    }
    for (const row of wrote.results as {
      session_id: string;
      chat_id: number;
      at: number;
      text: string;
    }[]) {
      entry(row.session_id).wrote = { chat_id: row.chat_id, at: row.at, text: row.text };
    }
    for (const row of asked.results as { session_id: string; at: number }[]) {
      entry(row.session_id).asked_at = row.at;
    }
    const last = (s: KnownSession) =>
      Math.max(s.started?.at ?? 0, s.wrote?.at ?? 0, s.asked_at ?? 0);
    return [...known.values()].sort((a, b) => last(b) - last(a)).slice(0, limit);
  }

  // --- guest calls ---------------------------------------------------------

  /** The chat a guest call came from, known since the first call there. */
  guestChat(chatType: string, chatId: number): Promise<GuestChat | null> {
    return this.db
      .prepare("SELECT * FROM guest_chats WHERE chat_type = ? AND chat_id = ?")
      .bind(chatType, chatId)
      .first<GuestChat>();
  }

  guestChatByKey(key: number): Promise<GuestChat | null> {
    return this.db
      .prepare("SELECT * FROM guest_chats WHERE id = ?")
      .bind(key - GUEST_BASE)
      .first<GuestChat>();
  }

  /** Remember the chat, and its title when it changed. */
  async upsertGuestChat(chatType: string, chatId: number, title: string | null) {
    const row = await this.db
      .prepare(
        `INSERT INTO guest_chats (chat_type, chat_id, title) VALUES (?, ?, ?)
         ON CONFLICT (chat_type, chat_id) DO UPDATE SET title = excluded.title RETURNING *`,
      )
      .bind(chatType, chatId, title)
      .first<GuestChat>();
    return row!;
  }

  /** The guest chats this user holds, latest first, with whether others may call there. */
  async guestChatsOf(userId: number): Promise<(GuestChat & { others: number })[]> {
    const { results } = await this.db
      .prepare(
        `SELECT g.*, c.others FROM claude_chats c JOIN guest_chats g ON g.id = c.chat_id - ?
         WHERE c.user_id = ? AND c.chat_id >= ? ORDER BY c.since DESC LIMIT 30`,
      )
      .bind(GUEST_BASE, userId, GUEST_BASE)
      .all<GuestChat & { others: number }>();
    return results;
  }

  /** Record a call from a chat the bot is not in. Null when Telegram already delivered it. */
  async insertGuestCall(
    call: Omit<
      GuestCall,
      "id" | "inline_message_id" | "answer" | "at" | "buttons" | "media" | "scene_id"
    >,
  ) {
    const row = await this.db
      .prepare(
        `INSERT INTO guest_calls
           (user_id, chat_key, query_id, from_id, from_name, from_username, by_other, text, file, reply, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (query_id) DO NOTHING RETURNING id`,
      )
      .bind(
        call.user_id,
        call.chat_key,
        call.query_id,
        call.from_id,
        call.from_name,
        call.from_username,
        call.by_other,
        redactSecrets(call.text),
        call.file,
        call.reply,
        nowSeconds(),
      )
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  /** The bot's one message in that chat, which answers edit. */
  async setGuestMessage(id: number, inlineMessageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE guest_calls SET inline_message_id = ? WHERE id = ?")
      .bind(inlineMessageId, id)
      .run();
  }

  getGuestCall(userId: number, id: number): Promise<GuestCall | null> {
    return this.db
      .prepare("SELECT * FROM guest_calls WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<GuestCall>();
  }

  /**
   * What answer_guest put on the call's message: its text, buttons and media.
   * It replaces whatever a scene that ran there left.
   */
  async setGuestAnswer(
    id: number,
    answer: string,
    shown: { buttons?: string | null; media?: string | null } = {},
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE guest_calls SET answer = ?, buttons = ?,
           media = COALESCE(?, media), scene_id = NULL WHERE id = ?`,
      )
      .bind(redactSecrets(answer), shown.buttons ?? null, shown.media ?? null, id)
      .run();
  }

  /** The call whose message this is: a press on an inline message names nothing else. */
  guestCallByMessage(inlineMessageId: string): Promise<GuestCall | null> {
    return this.db
      .prepare("SELECT * FROM guest_calls WHERE inline_message_id = ?")
      .bind(inlineMessageId)
      .first<GuestCall>();
  }

  /**
   * A scene takes the call's message, unless one runs there already: its id
   * is returned then. The message's own buttons go with it.
   */
  async takeGuestMessage(id: number, sceneId: number): Promise<number | null> {
    const taken = await this.db
      .prepare(
        `UPDATE guest_calls SET scene_id = ?1, buttons = NULL WHERE id = ?2 AND (scene_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM scenes WHERE id = guest_calls.scene_id AND status = 'active'))`,
      )
      .bind(sceneId, id)
      .run();
    if (taken.meta.changes) return null;
    const row = await this.db
      .prepare("SELECT scene_id FROM guest_calls WHERE id = ?")
      .bind(id)
      .first<{ scene_id: number | null }>();
    return row?.scene_id ?? null;
  }

  /**
   * A scene that took the call's message could not start there: the message
   * gets back what it had, unless something else took it since.
   */
  async returnGuestMessage(
    id: number,
    sceneId: number,
    had: Pick<GuestCall, "buttons" | "scene_id">,
  ): Promise<void> {
    await this.db
      .prepare("UPDATE guest_calls SET scene_id = ?, buttons = ? WHERE id = ? AND scene_id = ?")
      .bind(had.scene_id, had.buttons, id, sceneId)
      .run();
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

  /** A new sign-in, at generation 0: what the code exchange hands out. */
  async createSignIn(
    id: string,
    userId: number,
    clientName: string | null,
    expiresAt: number,
  ): Promise<void> {
    const now = nowSeconds();
    await this.db
      .prepare(
        `INSERT INTO refresh_sessions (id, user_id, generation, rotated_at, expires_at, client_name, created_at)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?3)`,
      )
      .bind(id, userId, now, expiresAt, clientName)
      .run();
  }

  /**
   * The user's standing sign-in named `clientName`, kept until at least
   * `expiresAt`; a new one when there is none. For sign-ins the Worker holds
   * itself (src/oauth.ts `mintSessionToken`): no refresh token, one row.
   */
  async workerSignIn(
    userId: number,
    clientName: string,
    expiresAt: number,
    newId: string,
  ): Promise<string> {
    const now = nowSeconds();
    const found = await this.db
      .prepare(
        `UPDATE refresh_sessions SET rotated_at = ?1, expires_at = MAX(expires_at, ?2)
         WHERE id = (SELECT id FROM refresh_sessions
                     WHERE user_id = ?3 AND client_name = ?4 AND revoked = 0 AND expires_at > ?1
                     ORDER BY created_at DESC LIMIT 1)
         RETURNING id`,
      )
      .bind(now, expiresAt, userId, clientName)
      .first<{ id: string }>();
    if (found) return found.id;
    await this.createSignIn(newId, userId, clientName, expiresAt);
    return newId;
  }

  /** The user's row and, when `sessionId` is given, whether that sign-in is revoked. */
  tokenState(userId: number, sessionId: string | null): Promise<TokenState | null> {
    return this.db
      .prepare(
        `SELECT u.token_version, u.connected_at, u.username, u.first_name,
                s.revoked AS session_revoked, s.client_name
         FROM users u
         LEFT JOIN refresh_sessions s ON s.id = ?2 AND s.user_id = u.user_id
         WHERE u.user_id = ?1`,
      )
      .bind(userId, sessionId)
      .first<TokenState>();
  }

  /** Sign-ins still standing, the most recently used first. */
  async listSignIns(userId: number): Promise<RefreshSessionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM refresh_sessions
         WHERE user_id = ? AND revoked = 0 AND expires_at > ?
         ORDER BY rotated_at DESC`,
      )
      .bind(userId, nowSeconds())
      .all<RefreshSessionRow>();
    return results;
  }

  /** Ends one of the user's own sign-ins. False when it is not theirs or already ended. */
  async revokeSignIn(userId: number, id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE refresh_sessions SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0",
      )
      .bind(id, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
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
      // A scene's messages stay while the scene does: they are drawn and reacted to.
      this.db
        .prepare(
          `DELETE FROM messages WHERE date < ? AND NOT (account_id = 0 AND EXISTS (
             SELECT 1 FROM scene_links l
             WHERE l.kind = 'message' AND l.key = messages.chat_id || ':' || messages.message_id))`,
        )
        .bind(cutoff),
      this.db.prepare("DELETE FROM button_presses WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM reactions WHERE date < ?").bind(cutoff),
      this.db.prepare("DELETE FROM upload_nonces WHERE expires_at < ?").bind(nowSeconds()),
      // A day past expiry: tokens can outlive their row by a few minutes, and
      // a session with no row would start afresh.
      this.db.prepare("DELETE FROM refresh_sessions WHERE expires_at < ?").bind(nowSeconds() - DAY),
      this.db.prepare("DELETE FROM day_marks WHERE day < ?").bind(Math.floor(cutoff / DAY)),
      this.db.prepare("DELETE FROM fires WHERE at < ?").bind(cutoff),
      this.db.prepare("DELETE FROM relay_jobs WHERE created_at < ?").bind(cutoff),
      this.db.prepare("DELETE FROM agent_sessions WHERE created_at < ?").bind(cutoff),
      this.db.prepare("DELETE FROM guest_calls WHERE at < ?").bind(cutoff),
      // Guest chats nobody holds any more: disconnected in the menu, or their holder is gone.
      this.db
        .prepare(
          `DELETE FROM guest_chats WHERE NOT EXISTS (
             SELECT 1 FROM claude_chats c WHERE c.chat_id = guest_chats.id + ?
           )`,
        )
        .bind(GUEST_BASE),
      // People nobody has heard from within retention.
      this.db.prepare(
        `DELETE FROM personal_chats WHERE NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.account_id = personal_chats.account_id AND m.chat_id = personal_chats.chat_id
         )`,
      ),
    ]);
    return results[0].meta.changes ?? 0;
  }

  // --- scenes --------------------------------------------------------------

  async createScene(row: {
    chat_id: number;
    thread_id: number | null;
    owner: number;
    owner_name: string;
    session_id: string | null;
    agent: string | null;
    title: string;
    brief: string | null;
    def: string;
    state: string;
    wake_limit: number;
    template_id?: number | null;
    template_version?: number | null;
    inline_id?: string | null;
    /** Its live messages, when they are known before anything is drawn (a guest call's). */
    messages?: string;
  }): Promise<number> {
    const now = nowSeconds();
    const created = await this.db
      .prepare(
        `INSERT INTO scenes (chat_id, thread_id, owner, owner_name, session_id, agent, title, brief,
           def, state, wake_limit, template_id, template_version, inline_id, messages, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(
        row.chat_id,
        row.thread_id,
        row.owner,
        row.owner_name,
        row.session_id,
        row.agent,
        row.title,
        row.brief,
        row.def,
        row.state,
        row.wake_limit,
        row.template_id ?? null,
        row.template_version ?? null,
        row.inline_id ?? null,
        row.messages ?? "[]",
        now,
        now,
      )
      .first<{ id: number }>();
    return created!.id;
  }

  getScene(id: number): Promise<SceneRow | null> {
    return this.db.prepare("SELECT * FROM scenes WHERE id = ?").bind(id).first<SceneRow>();
  }

  /**
   * Write what an event changed, if nobody else did in between: false when the
   * version moved (the caller reads again and retries). A change of `state`
   * counts as activity; drawing alone does not move `updated`.
   */
  async commitScene(id: number, version: number, patch: ScenePatch): Promise<boolean> {
    const sets = Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([column]) => `${column} = ?`);
    const values: unknown[] = Object.values(patch).filter((value) => value !== undefined);
    const result = await this.db
      .prepare(
        `UPDATE scenes SET ${[...sets, "version = version + 1", "updated = ?"].join(", ")}
         WHERE id = ? AND version = ?`,
      )
      .bind(...values, nowSeconds(), id, version)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** How the scene was drawn: no version change, nothing an event depends on. */
  async markSceneDrawn(
    id: number,
    drawn: { dirty?: number; edited_at?: number; quiet_until?: number },
  ): Promise<void> {
    const entries = Object.entries(drawn).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    await this.db
      .prepare(
        `UPDATE scenes SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
      )
      .bind(...entries.map(([, value]) => value), id)
      .run();
  }

  /*
   * What a scene's actions keep beside its state — recent posts, live
   * messages, the open poll — changes by targeted statements, never by
   * writing back a copy read earlier: two events at once must not lose
   * one another's message or poll.
   */

  /** Count a post against the minute's limit, if it allows one more. */
  async spendScenePost(id: number, perMinute: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.db
        .prepare("SELECT posts FROM scenes WHERE id = ?")
        .bind(id)
        .first<{ posts: string | null }>();
      if (!row) return false;
      const now = nowSeconds();
      const recent = ((row.posts ? JSON.parse(row.posts) : []) as number[]).filter(
        (at) => at > now - 60,
      );
      if (recent.length >= perMinute) return false;
      const result = await this.db
        .prepare("UPDATE scenes SET posts = ? WHERE id = ? AND posts IS ?")
        .bind(JSON.stringify([...recent, now]), id, row.posts)
        .run();
      if ((result.meta.changes ?? 0) > 0) return true;
    }
    return false;
  }

  /** Add a live message, if the scene has room for it. */
  async addLiveMessage(id: number, message: SceneMessage, limit: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scenes SET messages = json_insert(messages, '$[#]', json(?)) WHERE id = ?
         AND json_array_length(messages) < ?`,
      )
      .bind(JSON.stringify(message), id, limit)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** A live message that is gone from the chat leaves the scene's list. */
  async dropLiveMessage(id: number, messageId: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scenes SET messages = (
           SELECT json_group_array(json(value)) FROM json_each(scenes.messages)
           WHERE json_extract(value, '$.id') != ?2)
         WHERE id = ?1`,
      )
      .bind(id, messageId)
      .run();
  }

  /** Take the scene's one poll slot; false when a poll is open already. */
  async claimScenePoll(id: number, poll: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE scenes SET poll = ? WHERE id = ? AND poll IS NULL")
      .bind(poll, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Put what the slot holds from `was` to `poll` (null frees it). */
  async setScenePoll(id: number, was: string, poll: string | null): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE scenes SET poll = ? WHERE id = ? AND poll = ?")
      .bind(poll, id, was)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async unlinkScene(kind: "message" | "poll", key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM scene_links WHERE kind = ? AND key = ?")
      .bind(kind, key)
      .run();
  }

  /**
   * Take the owed redraw, in one statement: exactly one of those waiting gets
   * the row, with the edit's time already set, so a commit after it waits its
   * second. Null when nothing is owed, or Telegram asked for quiet.
   */
  async claimRedraw(id: number, now: number): Promise<SceneRow | null> {
    return this.db
      .prepare(
        `UPDATE scenes SET dirty = 0, edited_at = ?2 WHERE id = ?1 AND dirty = 1 AND quiet_until <= ?2
         RETURNING *`,
      )
      .bind(id, now)
      .first<SceneRow>();
  }

  /**
   * Forget the drawing an ended scene still owes: something else replaced its
   * message whole. False when nothing was owed (or the scene still runs).
   */
  async dropOwedRedraw(id: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE scenes SET dirty = 0 WHERE id = ? AND status != 'active' AND dirty = 1")
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** A scene in use, though its state did not change: the daily cleanup must not end it. */
  async touchScene(id: number): Promise<void> {
    await this.db
      .prepare("UPDATE scenes SET updated = ? WHERE id = ?")
      .bind(nowSeconds(), id)
      .run();
  }

  /** Scenes ended in bulk; their buttons are owed (drawEnded, or the daily run, takes them off). */
  private finishScenesStatement(where: string, values: unknown[]): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE scenes SET status = 'finished', version = version + 1, updated = ?, dirty = 1
         WHERE status = 'active' AND ${where}`,
      )
      .bind(nowSeconds(), ...values);
  }

  /** Scenes matching `where`, with their links and events. */
  private dropScenesStatements(where: string, values: unknown[]): D1PreparedStatement[] {
    return [
      ...["scene_links", "scene_events"].map((table) =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE scene_id IN (SELECT id FROM scenes WHERE ${where})`)
          .bind(...values),
      ),
      this.db.prepare(`DELETE FROM scenes WHERE ${where}`).bind(...values),
    ];
  }

  /** Active scenes nobody touched since `before`: the daily cleanup ends them. */
  async idleScenes(before: number, limit: number): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT id FROM scenes WHERE status = 'active' AND updated < ? LIMIT ?")
      .bind(before, limit)
      .all<{ id: number }>();
    return results.map((row) => row.id);
  }

  /** Finished scenes whose last drawing is still owed (Telegram asked for quiet then). */
  async undrawnScenes(limit: number): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT id FROM scenes WHERE status = 'finished' AND dirty = 1 LIMIT ?")
      .bind(limit)
      .all<{ id: number }>();
    return results.map((row) => row.id);
  }

  /** The owner's finished scenes whose last drawing is owed, in one chat or everywhere. */
  async undrawnScenesOf(owner: number, limit: number, chatId?: number): Promise<number[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id FROM scenes WHERE status = 'finished' AND dirty = 1 AND owner = ?1
         AND (?2 IS NULL OR chat_id = ?2) LIMIT ?3`,
      )
      .bind(owner, chatId ?? null, limit)
      .all<{ id: number }>();
    return results.map((row) => row.id);
  }

  /** Scenes finished before `before` go, with their links and events. */
  async dropFinishedScenes(before: number): Promise<void> {
    await this.db.batch(this.dropScenesStatements("status = 'finished' AND updated < ?", [before]));
  }

  /** A scene and everything that leads to it or came of it. */
  async deleteScene(id: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM scene_links WHERE scene_id = ?").bind(id),
      this.db.prepare("DELETE FROM scene_events WHERE scene_id = ?").bind(id),
      this.db.prepare("DELETE FROM scenes WHERE id = ?").bind(id),
    ]);
  }

  async finishScene(id: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE scenes SET status = 'finished', version = version + 1, updated = ? WHERE id = ? AND status = 'active'",
      )
      .bind(nowSeconds(), id)
      .run();
  }

  /** How many scenes the user has running in a chat. */
  async countScenesOf(owner: number, chatId: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM scenes WHERE chat_id = ? AND status = 'active' AND owner = ?",
      )
      .bind(chatId, owner)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Wakes from this scene since `since` (its starts), and when the oldest of them was. */
  async sceneWakes(
    owner: number,
    sceneId: number,
    since: number,
  ): Promise<{ n: number; oldest: number | null }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(at) AS oldest FROM fires WHERE user_id = ? AND scene_id = ?
         AND at >= ? AND status IN ('pending', 'started', 'relayed')`,
      )
      .bind(owner, sceneId, since)
      .first<{ n: number; oldest: number | null }>();
    return row ?? { n: 0, oldest: null };
  }

  /** The oldest start that counts against the others' limit in a chat. */
  async oldestOthersStart(userId: number, chatId: number, since: number): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT MIN(at) AS at FROM fires WHERE user_id = ? AND chat_id = ? AND by_other = 1
         AND at >= ? AND status IN ('pending', 'started', 'relayed')`,
      )
      .bind(userId, chatId, since)
      .first<{ at: number | null }>();
    return row?.at ?? null;
  }

  async sceneEventCount(sceneId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM scene_events WHERE scene_id = ?")
      .bind(sceneId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * The session a scene's wakes go to, once a start made one: the owner's
   * own, or (`others`) the one third parties' wakes go to.
   */
  async setSceneSession(id: number, sessionId: string, others: boolean): Promise<void> {
    await this.db
      .prepare(`UPDATE scenes SET ${others ? "others_session_id" : "session_id"} = ? WHERE id = ?`)
      .bind(sessionId, id)
      .run();
  }

  async setSceneWakeLimit(owner: number, id: number, limit: number): Promise<void> {
    await this.db
      .prepare("UPDATE scenes SET wake_limit = ? WHERE id = ? AND owner = ?")
      .bind(limit, id, owner)
      .run();
  }

  /** The user's active scenes everywhere, the newest first, a page at a time, for the menu. */
  async activeScenesOf(
    owner: number,
    limit: number,
    offset = 0,
  ): Promise<{ id: number; title: string; chat_id: number }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, title, chat_id FROM scenes WHERE owner = ? AND status = 'active' ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .bind(owner, limit, offset)
      .all<{ id: number; title: string; chat_id: number }>();
    return results;
  }

  /** How many scenes the user has running anywhere. */
  /** The newest scene the user owns, running or not (0 for none): a ready-made game's ▶ names it. */
  async lastSceneOf(owner: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT MAX(id) AS id FROM scenes WHERE owner = ?")
      .bind(owner)
      .first<{ id: number | null }>();
    return row?.id ?? 0;
  }

  async countActiveScenesOf(owner: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM scenes WHERE owner = ? AND status = 'active'")
      .bind(owner)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** End every running scene of the user's, everywhere; how many ended. Their drawing is owed. */
  async finishScenesOf(owner: number): Promise<number> {
    const result = await this.finishScenesStatement("owner = ?", [owner]).run();
    return result.meta.changes ?? 0;
  }

  /** The user's active scenes in a chat, for the menu. */
  async scenesOf(owner: number, chatId: number): Promise<{ id: number; title: string }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, title FROM scenes WHERE chat_id = ? AND status = 'active' AND owner = ? ORDER BY id",
      )
      .bind(chatId, owner)
      .all<{ id: number; title: string }>();
    return results;
  }

  async linkScene(
    kind: "message" | "poll",
    key: string,
    sceneId: number,
    view?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO scene_links (kind, key, scene_id, view) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET scene_id = excluded.scene_id, view = excluded.view`,
      )
      .bind(kind, key, sceneId, view ?? null)
      .run();
  }

  sceneByLink(
    kind: "message" | "poll",
    key: string,
  ): Promise<{ scene_id: number; view: string | null } | null> {
    return this.db
      .prepare("SELECT scene_id, view FROM scene_links WHERE kind = ? AND key = ?")
      .bind(kind, key)
      .first<{ scene_id: number; view: string | null }>();
  }

  /** Record an event for the session; the next number in the scene's log. */
  async addSceneEvent(
    sceneId: number,
    event: {
      name: string;
      user_id: number | null;
      user_name: string | null;
      data: string | null;
      woke?: boolean;
    },
  ): Promise<number> {
    const [inserted] = await this.db.batch<{ seq: number }>([
      this.db
        .prepare(
          `INSERT INTO scene_events (scene_id, seq, name, user_id, user_name, data, date, woke)
           SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM scene_events
           WHERE scene_id = ?1
           RETURNING seq`,
        )
        .bind(
          sceneId,
          event.name,
          event.user_id,
          event.user_name,
          event.data,
          nowSeconds(),
          event.woke ? 1 : 0,
        ),
      // A live scene keeps only its latest events: a log per press must not grow without end.
      this.db
        .prepare(
          `DELETE FROM scene_events WHERE scene_id = ?1
           AND seq <= (SELECT MAX(seq) FROM scene_events WHERE scene_id = ?1) - ?2`,
        )
        .bind(sceneId, SCENE_EVENTS_KEPT),
    ]);
    return inserted.results[0].seq;
  }

  async sceneEvents(sceneId: number, afterSeq: number, limit: number): Promise<SceneEventRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM scene_events WHERE scene_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .bind(sceneId, afterSeq, limit)
      .all<SceneEventRow>();
    return results;
  }

  /** The latest events, oldest of them first. */
  async lastSceneEvents(sceneId: number, limit: number): Promise<SceneEventRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM scene_events WHERE scene_id = ? ORDER BY seq DESC LIMIT ?")
      .bind(sceneId, limit)
      .all<SceneEventRow>();
    return results.reverse();
  }
  // --- saved scenes -----------------------------------------------------------

  /** The user's saved scenes, the most recently used first; definitions left out. */
  async listTemplates(owner: number): Promise<SceneTemplateEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, owner, name, title, brief, version, uses, kept, created, updated, used
         FROM scene_templates WHERE owner = ? ORDER BY used DESC, id DESC`,
      )
      .bind(owner)
      .all<SceneTemplateEntry>();
    return results;
  }

  getTemplate(owner: number, name: string): Promise<SceneTemplateRow | null> {
    return this.db
      .prepare("SELECT * FROM scene_templates WHERE owner = ? AND name = ?")
      .bind(owner, name)
      .first<SceneTemplateRow>();
  }

  getTemplateById(owner: number, id: number): Promise<SceneTemplateRow | null> {
    return this.db
      .prepare("SELECT * FROM scene_templates WHERE owner = ? AND id = ?")
      .bind(owner, id)
      .first<SceneTemplateRow>();
  }

  /** A saved scene of this shape, the one with exactly this definition first. */
  templateLike(owner: number, shape: string, definition: string): Promise<SceneTemplateRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM scene_templates WHERE owner = ? AND shape = ?
         ORDER BY definition = ? DESC, used DESC LIMIT 1`,
      )
      .bind(owner, shape, definition)
      .first<SceneTemplateRow>();
  }

  /** An earlier version of a saved scene, while it is kept. */
  async templateVersion(templateId: number, version: number): Promise<string | null> {
    const row = await this.db
      .prepare(
        "SELECT definition FROM scene_template_history WHERE template_id = ? AND version = ?",
      )
      .bind(templateId, version)
      .first<{ definition: string }>();
    return row?.definition ?? null;
  }

  async countTemplates(owner: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM scene_templates WHERE owner = ?")
      .bind(owner)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Save a new one; null when the name is taken. */
  async insertTemplate(
    owner: number,
    t: {
      name: string;
      title: string;
      brief: string | null;
      definition: string;
      shape: string;
      kept: boolean;
    },
  ): Promise<number | null> {
    const now = nowSeconds();
    const row = await this.db
      .prepare(
        `INSERT INTO scene_templates (owner, name, title, brief, definition, shape, kept, created,
           updated, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, name) DO NOTHING RETURNING id`,
      )
      .bind(owner, t.name, t.title, t.brief, t.definition, t.shape, t.kept ? 1 : 0, now, now, now)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  /**
   * Bring the library down to `limit` by dropping auto-saved scenes, the one
   * unused the longest first — possibly the one just saved, when all others
   * were saved on purpose. One transaction, so scenes saved at once never
   * leave more than `limit`. Returns the names dropped.
   */
  async trimTemplates(owner: number, limit: number): Promise<string[]> {
    const victims = `SELECT id FROM scene_templates WHERE owner = ?1 AND kept = 0
      ORDER BY used, id
      LIMIT MAX(0, (SELECT COUNT(*) FROM scene_templates WHERE owner = ?1) - ?2)`;
    const results = await this.db.batch<{ name: string }>([
      this.db
        .prepare(`UPDATE scenes SET template_id = NULL WHERE template_id IN (${victims})`)
        .bind(owner, limit),
      this.db
        .prepare(`DELETE FROM scene_template_history WHERE template_id IN (${victims})`)
        .bind(owner, limit),
      this.db
        .prepare(`DELETE FROM scene_templates WHERE id IN (${victims}) RETURNING name`)
        .bind(owner, limit),
    ]);
    return results[2].results.map((row) => row.name);
  }

  /** Saved on purpose: a full library never drops it. */
  async keepTemplate(owner: number, name: string): Promise<void> {
    await this.db
      .prepare("UPDATE scene_templates SET kept = 1 WHERE owner = ? AND name = ? AND kept = 0")
      .bind(owner, name)
      .run();
  }

  /**
   * Replace a saved scene's definition if it is still at `version`, keeping
   * the one it replaces. False when it moved on (or is gone).
   */
  async updateTemplate(
    owner: number,
    name: string,
    version: number,
    t: { title: string; brief: string | null; definition: string; shape: string },
  ): Promise<boolean> {
    const now = nowSeconds();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR REPLACE INTO scene_template_history (template_id, version, definition, changed_at)
           SELECT id, version, definition, ?4 FROM scene_templates
           WHERE owner = ?1 AND name = ?2 AND version = ?3`,
        )
        .bind(owner, name, version, now),
      this.db
        .prepare(
          `UPDATE scene_templates SET title = ?4, brief = ?5, definition = ?6, shape = ?8,
             version = version + 1, updated = ?7, kept = 1
           WHERE owner = ?1 AND name = ?2 AND version = ?3`,
        )
        .bind(owner, name, version, t.title, t.brief, t.definition, now, t.shape),
      this.db
        .prepare(
          `DELETE FROM scene_template_history WHERE template_id =
             (SELECT id FROM scene_templates WHERE owner = ?1 AND name = ?2)
           AND version <= (SELECT version FROM scene_templates WHERE owner = ?1 AND name = ?2) - 1 - ?3`,
        )
        .bind(owner, name, TEMPLATE_VERSIONS),
    ]);
    return (results[1].meta.changes ?? 0) > 0;
  }

  /** False when there is no such saved scene or the new name is taken. */
  async renameTemplate(owner: number, name: string, newName: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE OR IGNORE scene_templates SET name = ?3, updated = ?4, kept = 1
         WHERE owner = ?1 AND name = ?2`,
      )
      .bind(owner, name, newName, nowSeconds())
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** It started a scene. */
  /**
   * Count a start from the menu, if the saved scene is still at `version`
   * and started `uses` times: what the card showed. Two presses on one card
   * cannot both pass; a changed scene passes neither.
   */
  async claimTemplateStart(
    owner: number,
    id: number,
    version: number,
    uses: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scene_templates SET uses = uses + 1, used = ?
         WHERE id = ? AND owner = ? AND version = ? AND uses = ?`,
      )
      .bind(nowSeconds(), id, owner, version, uses)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** A claimed start that did not happen after all. */
  async unclaimTemplateStart(id: number): Promise<void> {
    await this.db
      .prepare("UPDATE scene_templates SET uses = MAX(uses - 1, 0) WHERE id = ?")
      .bind(id)
      .run();
  }

  async useTemplate(id: number): Promise<void> {
    await this.db
      .prepare("UPDATE scene_templates SET uses = uses + 1, used = ? WHERE id = ?")
      .bind(nowSeconds(), id)
      .run();
  }

  private dropTemplatesStatements(where: string, values: unknown[]): D1PreparedStatement[] {
    const ids = `SELECT id FROM scene_templates WHERE ${where}`;
    return [
      this.db
        .prepare(`UPDATE scenes SET template_id = NULL WHERE template_id IN (${ids})`)
        .bind(...values),
      this.db
        .prepare(`DELETE FROM scene_template_history WHERE template_id IN (${ids})`)
        .bind(...values),
      this.db.prepare(`DELETE FROM scene_templates WHERE ${where}`).bind(...values),
    ];
  }

  /** A saved scene and its versions; scenes started from it go on. */
  async deleteTemplate(owner: number, name: string): Promise<boolean> {
    const results = await this.db.batch(
      this.dropTemplatesStatements("owner = ? AND name = ?", [owner, name]),
    );
    return (results[2].meta.changes ?? 0) > 0;
  }

  async templateUsers(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT owner FROM scene_templates")
      .all<{ owner: number }>();
    return results.map((row) => row.owner);
  }

  /** Every saved scene of the user, with their versions. */
  async wipeTemplates(owner: number): Promise<void> {
    await this.db.batch(this.dropTemplatesStatements("owner = ?", [owner]));
  }
}
