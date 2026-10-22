/**
 * Database schema, applied by the Worker itself.
 *
 * The deploy button creates the D1 database but runs no migrations, so the
 * Worker brings the schema up on first use: one read per isolate to check the
 * version, and the DDL only when it is behind. Every statement is idempotent,
 * so two isolates racing on a fresh database both succeed.
 *
 * Built to spend few writes, because D1 bills — and the free plan caps — rows
 * written per account per day, and every index entry is one more row:
 *   - `messages` has no secondary index. Per-chat reads walk the primary key
 *     (message ids grow within a chat); the daily purge scans, which costs
 *     only reads.
 *   - Small, rarely written tables (grants, presses) get the indexes they need.
 */

const SCHEMA_VERSION = 1;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    language TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    username TEXT,
    is_forum INTEGER NOT NULL DEFAULT 0,
    bot_is_admin INTEGER NOT NULL DEFAULT 0,
    visible_history INTEGER,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS grants (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    visible_from INTEGER NOT NULL,
    granted_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS grants_by_chat ON grants (chat_id)`,

  `CREATE TABLE IF NOT EXISTS messages (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    date INTEGER NOT NULL,
    edited_at INTEGER,
    thread_id INTEGER,
    from_id INTEGER,
    from_name TEXT,
    from_username TEXT,
    forwarded_from TEXT,
    text TEXT NOT NULL DEFAULT '',
    text_lc TEXT NOT NULL DEFAULT '',
    reply_to_id INTEGER,
    quote TEXT,
    mentions_bot INTEGER NOT NULL DEFAULT 0,
    outgoing INTEGER NOT NULL DEFAULT 0,
    file_kind TEXT,
    file_id TEXT,
    file_name TEXT,
    file_mime TEXT,
    file_size INTEGER,
    buttons TEXT,
    mark_choice INTEGER NOT NULL DEFAULT 0,
    sent_by INTEGER,
    PRIMARY KEY (chat_id, message_id)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS button_presses (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    callback_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    label TEXT NOT NULL,
    data TEXT NOT NULL,
    date INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, callback_id)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS reactions (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    emoji TEXT NOT NULL,
    date INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, user_id)
  ) WITHOUT ROWID`,

  // Forum topic names, learned from the topic-created message Telegram attaches to every
  // message posted in a topic. Bot API offers no way to list topics.
  `CREATE TABLE IF NOT EXISTS topics (
    chat_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, thread_id)
  ) WITHOUT ROWID`,

  // The first message id of each chat on each UTC day. Message ids grow within
  // a chat, so this turns "since <date>" into a primary-key range and keeps
  // reads proportional to the window searched, not the whole chat. Written at
  // most once per chat per day.
  `CREATE TABLE IF NOT EXISTS day_marks (
    chat_id INTEGER NOT NULL,
    day INTEGER NOT NULL,
    first_id INTEGER NOT NULL,
    PRIMARY KEY (chat_id, day)
  ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS upload_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
];

const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let promise = ready.get(db);
  if (!promise) {
    promise = migrate(db);
    ready.set(db, promise);
    promise.catch(() => ready.delete(db));
  }
  return promise;
}

async function migrate(db: D1Database): Promise<void> {
  const current = await db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .first<{ value: string }>()
    .catch(() => null);
  if (current && Number(current.value) >= SCHEMA_VERSION) return;

  await db.batch([
    ...SCHEMA.map((sql) => db.prepare(sql)),
    db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(String(SCHEMA_VERSION)),
  ]);
}
