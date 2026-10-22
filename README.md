# telegram-mcp

A remote MCP server that connects Claude (and ChatGPT, Codex) to you through a Telegram bot. Claude
can:

- **message you** when it finishes or gets stuck ("ping me in Telegram when the build is done"),
- **send files** it built (reports, archives, screenshots, up to 50 MB) without base64 through the
  model,
- **ask you something and wait**, with answer buttons ("ask me in Telegram before deploying"),
- **read what you send the bot** ("I sent you a file in Telegram, take a look"),
- **read groups you connect**: search by keywords, find every message where someone tagged the
  bot, follow replies and walk the messages around them for context, work inside forum topics,
- **read your personal chats**, if you connect the bot to your account ("what did Anna write
  yesterday?"), and reply in them as you — only if you allowed that in Telegram.

It runs on Cloudflare Workers with D1. Each person who connects sees only their own private chat
with the bot, the groups they connected and their own personal chats.

> **What the bot can read is only what it received.** The Bot API has no history, so the bot
> stores what Telegram delivers to it, for **14 days** (`RETENTION_DAYS`), and deletes the rest.
> Nothing from before the bot joined a chat, nothing from your other chats, and in groups only what
> privacy mode lets through. The model is told this, so it does not mistake "not stored" for "never
> happened".

## Setup

### 1. Create the bot

In [@BotFather](https://t.me/BotFather): `/newbot`, and keep the token.

### 2. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iamnalinor/telegram-mcp)

The button asks for `BOT_TOKEN` (required) and `ALLOWED_USER_IDS` (optional, see below), creates
the D1 database, and deploys. The Worker creates its own tables on first use.

<details>
<summary>Or from a terminal</summary>

```bash
bun install
```

```bash
bunx wrangler login
```

```bash
bun run deploy
```

```bash
bunx wrangler secret put BOT_TOKEN
```

</details>

### 3. Finish in BotFather

Open `https://telegram-mcp.<your-subdomain>.workers.dev` in a browser. The page registers the
bot's webhook and shows what is left to do:

- `/setdomain` → your bot → `telegram-mcp.<your-subdomain>.workers.dev`. Telegram Login only works on
  this domain.
- `/setprivacy` → your bot → **Disable**, if the bot should see every message in groups. With
  privacy on it only sees commands, @mentions and replies to it (an admin bot sees everything
  either way). Telegram applies the change only to groups the bot joins afterwards, so re-add it to
  groups it is already in.

### 4. Lock it to yourself (optional)

By default anyone may connect their own Telegram account to your deployment. Each person still sees
only their own chat and groups, but to keep it to yourself:

1. Send `/start` to your bot. It replies with **your Telegram ID** (or ask
   [@userinfobot](https://t.me/userinfobot)).
2. Set `ALLOWED_USER_IDS` to that number (comma-separate several):
   `bunx wrangler secret put ALLOWED_USER_IDS`, or in the Cloudflare dashboard → Worker → Settings
   → Variables and Secrets.

Others then get "this bot is private" with their ID, and a group added by someone not on the list is
left at once.

### 5. Connect your assistant

**Claude** (web, desktop, mobile): Settings → Connectors → **Add custom connector** → URL
`https://telegram-mcp.<your-subdomain>.workers.dev/`. Leave the OAuth fields empty. Claude opens
Telegram's login page; confirm, allow the bot to message you, and you are back in Claude.

**Claude Code**:

```bash
claude mcp add --transport http telegram https://telegram-mcp.<your-subdomain>.workers.dev/
```

Then `/mcp` in Claude Code to sign in.

**ChatGPT** (needs Developer mode: Pro, Business, Enterprise, Edu): Settings → Apps & Connectors →
Advanced → Developer mode on, then **Create** with the same URL and **OAuth** authentication.
ChatGPT registers itself; no client id needed.

**Codex**:

```bash
codex mcp add telegram --url https://telegram-mcp.<your-subdomain>.workers.dev/
```

```bash
codex mcp login telegram
```

## Groups

- **Adding the bot** to a group gives you (whoever added it) access straight away.
- **Anyone else** in the group links their own assistant with `/connect` in the group, or `/connect`
  in a private chat with the bot, which shows a group picker. A public `@groupname` works too.
- **Two people, one group**: access is per person. Each connects and revokes on their own; messages
  are stored once.
- **History for later connectors**: someone who connects after the bot joined sees the stored
  history only if the group shows history to new members, which the bot can only check as an admin.
  Otherwise they see messages from the moment they connect, and the bot says which applies.
- **`/groups`** in the private chat lists your groups, each with a **Revoke** button. When the last
  person revokes a group, its stored history is deleted.
- **Leaving** a group drops your access: the bot re-checks membership at least hourly before reading
  a group.
- **Forum topics** are kept apart: messages carry their topic, `list_chats` names the topics, and
  Claude can read or post within one.
- **Replies**: when someone replies to a message, the bot keeps the original too (even one older than
  the bot), so "@bot what about this?" under a message shows Claude both.

Bot commands: `/start` (what this is, and your Telegram ID), `/connect`, `/groups`,
`/disconnect` (signs out every assistant connected with your account).

## Personal chats

Telegram lets a user connect a bot to their own account (Telegram Business → Chatbots). The bot then
receives the user's private chats with other people, and Claude can read and search them like any
other chat.

1. In [@BotFather](https://t.me/BotFather): your bot → Bot Settings → **Secretary Mode** → on
   (called Business Mode before). Once per bot.
2. Each user who wants it, in Telegram: Settings → Telegram Business → **Chatbots** → add the bot.
   There they choose which chats it gets (all except some, or only some) and what it may do.

**What Claude may do is exactly what you allowed there**, checked on every call:

| Permission in Telegram | What it lets Claude do                                               |
| ---------------------- | -------------------------------------------------------------------- |
| (connected at all)     | read and search the chats you gave it                                |
| Reply to messages      | send and edit messages as you: text, files, albums, locations, polls |
| Mark messages as read  | `mark_read`                                                          |
| Delete sent messages   | delete messages it sent (never yours or the other person's)          |

Without a permission the tool refuses before anything reaches Telegram. Change it in Telegram and
the next call follows; the bot tells you in its chat what Claude can do whenever it changes.
Telegram also allows writing only within 24 hours of the other person's last message. Buttons,
`ask_user`, reactions, pins and forwards are not used in personal chats. Claude is told that
anything it sends there goes out as you, and to send only when you ask it to in the conversation.

- **What the bot sees**: messages from the moment you connect it, in the chats you chose, including
  your own replies. No history, no secret chats, no groups.
- **Removing the bot** there deletes everything it stored from your personal chats. Storage starts
  only once you have also signed an assistant in.
- **Other people's privacy**: the people you talk to have not agreed to anything. Their messages sit
  in the database for `RETENTION_DAYS`, readable by whoever runs the Worker. Give the bot only the
  chats you need, and run your own deployment.
- **Cost**: every message in a connected chat is a Worker request and about two D1 row writes, like
  a busy group. With `ALLOWED_USER_IDS` empty, anyone can connect their account to your bot on your
  quota.

## Files

Models cannot attach files to MCP calls, so files travel through short-lived links instead:

- **Sending**: `create_upload_url` returns a one-time link (10 minutes). Claude Code, or any agent
  with a shell, runs `curl -T file '<link>'`, and the Worker passes the file straight to Telegram.
  Nothing is stored. Up to 50 MB (photos 10 MB), which is Telegram's limit for bots.
- **Without a shell** (claude.ai chat, ChatGPT): `send_file` takes text, or base64 up to 1 MB. In
  claude.ai the code sandbox can use the curl route too, if network access to your Worker's domain
  is allowed in Claude's settings.
- **Receiving**: `get_file` returns a 15-minute download link, plus the content itself for images up
  to 1.5 MB and the start of text files (up to ~60k characters). Telegram lets bots download files up
  to 20 MB.

Upload links stream the body straight on to Telegram (the Worker never holds the file), so curl must
send the size — `curl -T` does. Links stop working after `/disconnect` or when your ID leaves the
allowlist.

## Tools

| Tool                  | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `send_message`        | Text to your private chat (default) or a group; Markdown, buttons, replies |
| `ask_user`            | A question with answer buttons, then waits for the press or a typed reply  |
| `wait_for_reply`      | Keep waiting for an answer to a message the bot sent                       |
| `create_upload_url`   | One-time upload link: the file is sent when curl finishes                  |
| `send_file`           | A small file passed inline (text or base64)                                |
| `send_album`          | 2–10 photos/videos/documents as one album                                  |
| `send_location`       | A map pin or venue                                                         |
| `send_poll`           | A native poll                                                              |
| `send_chat_action`    | "typing…" before a slow send                                               |
| `edit_message`        | Change the bot's message text or buttons, e.g. one progress message        |
| `delete_message`      | Delete the bot's message (or yours, in the private chat)                   |
| `pin_message`         | Pin or unpin                                                               |
| `react`               | An emoji reaction instead of a reply                                       |
| `forward_message`     | Copy a message (with its file) into another chat you can access            |
| `mark_read`           | Mark a personal chat's latest message read (needs that permission)         |
| `list_chats`          | Your chat, groups, personal chats (with permissions), topics, t.me links   |
| `search_messages`     | Keywords, sender, time, files, topic, or only messages that tag the bot    |
| `get_recent_messages` | Latest messages in a chat, or the window around one message                |
| `get_message`         | One message in full, with its reply chain, button presses and reactions    |
| `get_file`            | Download link for an attachment, and the content when small                |

Every send returns a `t.me` link Claude can hand you. Buttons are recorded when pressed;
reactions on the bot's messages are recorded too (in groups, that needs the bot to be an admin).

## Limits

Cloudflare's limits are **per account**, shared by every Worker on it. On the free plan:

| Resource        | Free plan           | What this Worker spends                                  |
| --------------- | ------------------- | -------------------------------------------------------- |
| Worker requests | 100,000 / day       | one per Telegram update, one per MCP call                |
| D1 rows written | 100,000 / day       | ~2 per stored message (insert, and the delete at expiry) |
| D1 rows read    | 5,000,000 / day     | a search reads the messages in the window it covers      |
| D1 storage      | 500 MB per database | ~0.5 KB per message                                      |

That is roughly **50,000 stored messages a day** across everything on the account. What keeps it
low:

- Only chats someone connected are written. Messages from other chats are dropped without a write.
- `messages` has no secondary index (each index entry is one more billed row).
- OAuth codes, tokens and file links are signed, not stored.
- Command answers go back in the webhook response itself, without a separate Bot API call.

Reads are cheaper but not free: a keyword search scans the stored messages of the chats and time
window it covers (pass `since` and it starts at that day), so searching a very busy group hundreds
of times a day can reach the read cap. When either D1 cap is hit, D1 refuses all queries until the
next UTC day.

**Open mode costs you**: with `ALLOWED_USER_IDS` empty, anyone can add your bot to a busy group and
your account pays for its messages. Every update to a group the bot is in costs a Worker request even
when nothing is stored. Set the allowlist if that matters.

If you outgrow it, the $5 Workers Paid plan includes 10M requests and 50M D1 row writes a month.
Increasing `RETENTION_DAYS` costs storage, not writes.

## Security

- **Webhook**: Telegram's calls are accepted only from its published ranges (`149.154.160.0/20`,
  `91.108.4.0/22`) **and** with the secret token registered with the webhook, compared in constant
  time. The secret is an HMAC of the bot token, not the token itself.
- **Webhook origin**: the first public URL the Worker is opened under is where the webhook points,
  and other hosts (preview URLs, extra routes) cannot move it. To move to a new domain:
  `bunx wrangler d1 execute telegram-mcp --remote --command "DELETE FROM meta WHERE key IN ('public_origin','webhook_fingerprint')"`,
  then open the new URL.
- **One secret**: every key (token signing, webhook secret) is derived from `BOT_TOKEN`. Revoking
  the token in BotFather invalidates all sessions and links; the Worker re-registers the webhook on
  its own (on the next visit to its page, or the daily cron).
- **Login** is Telegram Login, checked against the bot token's hash, valid for 10 minutes. OAuth
  uses PKCE, and codes only go to Claude's and ChatGPT's exact callback URLs or to loopback. Before
  Telegram's login, a page names the assistant that will get access, and the sign-in can only finish
  in the browser that saw it, so a link someone else started cannot be accepted by mistake.
- **Access** is checked on every call: your own private chat, groups where you hold a grant and are
  still a member, and your personal chats while your business connection is on, with only the
  permissions you gave it in Telegram. Personal messages are keyed by your account, so no query can
  return them to anyone else. A model cannot post to or read any other chat. It can only edit or delete the
  bot's own messages, and in a shared group only those sent for the same user.
- **Refresh tokens rotate**: each refresh returns a new one and retires the old. A retired token
  coming back after its successor was used, or more than 10 minutes later, means someone else holds
  a copy, and that sign-in's refresh tokens are revoked (access tokens already issued run out within
  a day; `/disconnect` stops those too). An assistant used at least once in 90 days never has to
  reconnect.
- **`/disconnect`** revokes every token you issued. Removing an ID from `ALLOWED_USER_IDS` cuts
  access on the next call.
- **What is stored**: message text and attachment metadata (Telegram file ids, not the files), for
  `RETENTION_DAYS`. Whoever runs the Worker can read the database. Run your own.

## Development

```bash
bun install
```

```bash
bun test
```

```bash
bun run lint
```

```bash
bun run dev
```

- `bun test`: unit tests plus end-to-end runs of the real Worker against SQLite (behind a D1-shaped
  adapter) and a fake Bot API. They cover the webhook gate, groups and grants, topics, replies,
  buttons, file links, OAuth, the allowlist, and concurrent and out-of-order updates.
- `bun run lint`: prettier, eslint, tsc (TypeScript 7) and knip. It fixes what it can in place;
  `bun run check` only reports, and is what CI runs, with `bun test`, on pushes to `main` and on
  pull requests.
- `bun run dev` reads `BOT_TOKEN` from `.dev.vars` or `.env`. To feed it webhook calls from your
  machine, also set `DEV_SKIP_IP_CHECK=1` there (never in production).

`wrangler` needs Node. On a Bun-only machine, `bun add -d node-linux-x64` (or your platform's
package) and put its `bin` on `PATH`.

## License

MIT
