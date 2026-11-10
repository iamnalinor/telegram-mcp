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
- **answer where the bot is not a member**: tag it in any chat (Telegram's guest mode) and Claude
  answers there,
- **show more than text**: rich messages with tables and collapsible blocks, coloured buttons,
  quizzes, live previews of a long answer, interactive widgets,
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
- Bot Settings (in BotFather's Mini App) → **Guest Mode** → on, if you want to call Claude from chats
  the bot is not in (see [Claude on tag](#claude-on-tag)).
- `/setprivacy` → your bot → **Disable**, if the bot should see every message in groups. With
  privacy on it only sees commands, @mentions and replies to it (an admin bot sees everything
  either way). Telegram applies the change only to groups the bot joins afterwards, so re-add it to
  groups it is already in.

### 4. Lock it to yourself (optional)

By default anyone may connect their own Telegram account to your deployment. Each person still sees
only their own chat and groups, but to keep it to yourself:

1. Send `/start` to your bot. Its menu shows **your Telegram ID** (or ask
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

- **Adding the bot** to a group gives you (whoever added it) access straight away. The menu's
  **Connect a group** button opens Telegram's own picker for that.
- **Anyone else** in the group links their own assistant by sending `/connect` in the group.
- **Two people, one group**: access is per person. Each connects and revokes on their own; messages
  are stored once.
- **History for later connectors**: someone who connects after the bot joined sees the stored
  history only if the group shows history to new members, which the bot can only check as an admin.
  Otherwise they see messages from the moment they connect, and the bot says which applies.
- **Groups** in the menu (or `/groups`) lists your groups; revoke any of them there. When the last
  person revokes a group, its stored history is deleted.
- **Leaving** a group drops your access: the bot notices the leave when Telegram tells it (always as
  an admin, otherwise unless the group hides join and leave messages), and re-checks membership at
  least hourly before reading a group anyway.
- **Forum topics** are kept apart: messages carry their topic, `list_chats` names the topics, and
  Claude can read or post within one.
- **Replies**: when someone replies to a message, the bot keeps the original too (even one older than
  the bot), so "@bot what about this?" under a message shows Claude both.

Bot commands: `/start` opens the menu (groups, connecting a group, personal chats, how it works,
your Telegram ID). `/connect` in a group, `/groups` and `/disconnect` (signs out every assistant
connected with your account) work too; only `/start` is listed in Telegram's command suggestions.

## Personal chats

Telegram lets a user connect a bot to their own account (Telegram Business → Chatbots). The bot then
receives the user's private chats with other people, and Claude can read and search them like any
other chat.

1. In [@BotFather](https://t.me/BotFather): your bot → Bot Settings → **Secretary Mode** → on
   (called Business Mode before). Once per bot.
2. Each user who wants it, in Telegram: Settings → Telegram Business → **Chatbots** → add the bot.
   There they choose which chats it gets (all except some, or only some) and what it may do.

**What Claude may do is exactly what you allowed there**, checked on every call:

| Permission in Telegram | What it lets Claude do                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| (connected at all)     | read and search the chats you gave it                                  |
| Reply to messages      | `send_as_user` (text and files), `edit_as_user`                        |
| Mark messages as read  | `mark_read`                                                            |
| Delete sent messages   | `delete_as_user`: messages it sent (never yours or the other person's) |

Without a permission the tool refuses before anything reaches Telegram. Change it in Telegram and
the next call follows; the bot tells you in its chat what Claude can do whenever it changes.
Telegram also allows writing only within 24 hours of the other person's last message. Buttons,
`ask_user`, reactions, pins, forwards, albums, locations and polls are not used in personal chats. Claude is told that
anything it sends there goes out as you, and to send only when you ask it to in the conversation.

Acting as you has its own tools, marked destructive, and the bot's tools (`send_message`,
`edit_message`, …) refuse personal chats. So your client can let Claude message you and your groups
freely and still ask you before anything goes out in your name: in Claude Code, allow
`mcp__Telegram` and add `mcp__Telegram__send_as_user`, `…__edit_as_user`, `…__delete_as_user` and
`…__mark_read` to `permissions.ask`.

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
|                       | — or a rich message (tables, headings, details), or for one member only    |
| `ask_user`            | A question with answer buttons, then waits for the press or a typed reply  |
| `wait_for_reply`      | Keep waiting for an answer to a message the bot sent                       |
| `create_upload_url`   | One-time upload link: the file is sent when curl finishes                  |
| `send_file`           | A small file passed inline (text or base64)                                |
| `send_album`          | 2–10 photos/videos/documents as one album                                  |
| `send_location`       | A map pin or venue                                                         |
| `send_poll`           | A native poll or quiz                                                      |
| `send_draft`          | A live preview of an answer being written (private chat)                   |
| `send_widget`         | An interactive HTML widget inside a message (private chat)                 |
| `set_widget_state`    | Change what a widget shows                                                 |
| `send_chat_action`    | "typing…" before a slow send                                               |
| `edit_message`        | Change the bot's message text or buttons, e.g. one progress message        |
| `delete_message`      | Delete the bot's message (or yours, in the private chat)                   |
| `pin_message`         | Pin or unpin                                                               |
| `react`               | An emoji reaction instead of a reply                                       |
| `forward_message`     | Copy a message (with its file) into another chat you can access            |
| `send_as_user`        | In a personal chat, as you: text, or a file (inline or upload link)        |
| `edit_as_user`        | Edit a message sent as you                                                 |
| `delete_as_user`      | Delete a message sent as you                                               |
| `mark_read`           | Mark a personal chat's latest message read (needs that permission)         |
| `list_chats`          | Your chat, groups, personal chats (with permissions), topics, t.me links   |
| `search_messages`     | Keywords, sender, time, files, topic, or only messages that tag the bot    |
| `get_recent_messages` | Latest messages in a chat, or the window around one message                |
| `get_message`         | One message in full, with its reply chain, button presses and reactions    |
| `get_file`            | Download link for an attachment, and the content when small                |
| `memory`              | Read and edit what your assistants keep about each chat (see Memory)       |
| `list_sessions`       | Claude Code sessions the bot knows of, and whether the relay is up         |
| `message_session`     | Ask another session something, or hand it a request (needs the relay)      |
| `wait_for_session`    | Keep waiting for that session's answer                                     |
| `answer_session`      | Answer a session that asked you                                            |
| `get_guest_call`      | Read a call from a chat the bot is not in                                  |
| `answer_guest`        | Answer it, by editing the bot's one message there                          |
| `scene_guide`         | The scene language in brief, and ready scenes to adapt (see Scenes)        |
| `create_scene`        | A message the bot runs by itself: state, screens, rules; or a dry run      |
| `get_scene`           | A scene's state, its creator's note and its latest events                  |
| `update_scene`        | Change a scene's state, fire one of its `act:` rules, or finish it         |
| `wait_for_scene`      | Wait for the next event a scene logs or wakes Claude with                  |

Every send returns a `t.me` link Claude can hand you. Buttons are recorded when pressed;
reactions on the bot's messages are recorded too (in groups, that needs the bot to be an admin).

What Telegram added in Bot API 10 is used where it helps:

- **Rich messages**: `send_message` and `edit_message` with `format: "rich"` take GitHub-flavoured
  Markdown with headings, tables, task lists, `<details>` and formulas, up to 32k characters in one
  message. Incoming rich messages are read as text.
- **Buttons** take a `style` (primary, success, danger).
- **For one member only**: `only_for` shows a group message to a single member (an ephemeral
  message; the bot must be an admin there). It is not stored.
- **Widgets**: `send_widget` sends one self-contained HTML document drawn inside the message.
  Telegram shows them only in the private chat with the bot for now. A widget's taps reach the bot
  as queries that must be answered within 15 seconds, so the Worker answers them itself and records
  each like a button press; Claude reads them (`wait_for_reply` with `after_press`) and changes
  what the widget shows with `set_widget_state`.
- **Polls**: quizzes with several right answers, a description, revoting, options added by
  members, hidden results, a closing time.

## Scenes

A scene is a message the bot runs by itself. Claude describes it once — its state, how the
message looks, and rules for each press, vote, reply or reaction — and goes. From then on the
Worker takes every event, changes the state, redraws the message and answers whoever pressed,
without a session. Claude is woken only where its own rules call `wake()`.

On it: a who's-coming list, a checklist, a board for a long task with Pause and Stop, a triage of
findings that wakes Claude when you press Done, a pinned control panel, tic-tac-toe, a quiz, mafia
with Claude as host. `scene_guide` hands out these as presets to adapt.

```json
{
  "title": "Lunch?",
  "state": { "yes": {} },
  "view": {
    "text": "**Coming:** {len(yes)} {join(values(yes))}",
    "buttons": [
      [
        { "text": "Me", "press": "me" },
        { "text": "Ask Claude", "press": "ask" }
      ]
    ]
  },
  "rules": [
    { "on": "press:me", "do": ["yes[user.id] = user.name"] },
    { "on": "press:ask", "who": "owner", "do": ["wake('ask')"] }
  ]
}
```

The rules are written in a small language of its own (paths, arithmetic, `?:`, a few dozen pure
functions), parsed once when the scene is created and run with a step budget — never `eval`. Names
and replies from the chat are shown as text, never as markup, and reach Claude fenced as data.

**Who can press what.** Anyone in the chat can press a button whose rule says `anyone`; `owner`
rules answer only you. Every press gets an answer: the rule's own, or why not ("not now", "only for
@you", "out of date" for an old keyboard or forged button data, "not so fast" past 10 events in 10
seconds per person).

**Waking Claude.** A rule with `wake()` runs only if the wake may happen: it is your press, or the
chat is a group where you hold Claude on tag with «Others too» on; your routine is set up (or the
relay is up and knows the session to wake); and the limits allow it — the scene's own wakes an hour
(10 by default; change it in the menu: chat → 🎬 Scenes) and the starts every tag shares. Otherwise
the press is refused and nothing changes. The scene's own limit starts afresh if a scene is finished
and created again; the shared limits do not.

Like a group's sessions of the day, a scene keeps two audiences apart. Your wakes go into the
session that made the scene, through the relay, or start your routine. Other members' wakes never go
into that session: the first starts a session of its own for them, and later ones go there through
the relay (or start the routine again without it). A session that drives its scene with
`update_scene` `act` may wake only itself, and is never taken for you. Each wake is a start in the
chat's log (📜 Starts, in a group where you hold Claude on tag).

**Cost.** A press that changes something is one Worker request; it reads the scene's row and, for
each of its live messages, the stored copy, and writes two rows: the scene and the redrawn message's
record. A press within a second of the last edit writes two more when the held-back edit is made. A
refused press writes nothing, and a press that changes nothing writes nothing (except once a day, to
mark the scene as in use). `log()` and `wake()` write one more row each; a scene keeps its latest 200
events. Edits keep to one a second per message. Up to 20 active scenes per person per chat; a scene
nobody used for `RETENTION_DAYS` ends and is deleted a retention later, and its messages are kept as
long as it is. Scenes end, and their messages lose their buttons, when you lose access to the group
or `/disconnect`. A vote the scene could not take (too fast, a full state) shows as an error in
`get_scene`, since nobody sees the answer to a vote.

Scenes were tested against a fake Bot API only. On a live bot, check: the ephemeral reply to a press
(`whisper`), poll updates reaching the bot, `setChatMemberTag` (`tag`, needs the bot to be an admin
with that right), and how fast Telegram lets a busy scene be edited. An existing deployment asks
Telegram for poll updates only once it registers the webhook again: on the next visit to the
Worker's page, or the daily cron.

## Memory

Your assistants keep notes about each chat in one Markdown document per chat: `me` for your private
chat with the bot and things that apply everywhere, and one per group — who is responsible for what,
the project's repository, the tone, and under `## Trust` who may ask for what. Every assistant you
connect reads the same memory, so what Claude learns ChatGPT knows too. The `memory` tool works like
Claude's own memory tool (`view`, `create`, `str_replace`, `insert`, `delete`), with a chat in place
of a file path.

- **You see every change**: each one arrives silently in your private chat, with what changed, which
  assistant made it, and an **Undo** button. Changes in quick succession share one message.
- **Trust** changes only when you ask yourself; assistants are told nothing overrides that.
- **Menu → Memory** lists the chats with memory; read, delete, or erase it all there.
- Memory is kept until deleted (not limited to `RETENTION_DAYS`). It goes with your access to a
  group, and when your ID leaves `ALLOWED_USER_IDS`.

## Claude on tag

Tag the bot in Telegram and a Claude Code cloud session does the work and answers there. The session
runs as your [routine](https://claude.ai/code/routines) on your Anthropic account, with the
connectors and repositories you give that routine; this bot only starts it.

Set it up from the bot's menu, **🤖 Claude on tag**: it walks you through creating the routine,
sends you the prompt to paste into it, and asks for the routine's API trigger id and token. Send both
in one message: the bot deletes it, keeps the token encrypted (with a key derived from the bot
token), and starts a test session that answers "ok". No message containing an Anthropic key is ever
stored, in any chat.

What starts a session:

- **Your private chat with the bot** (on once the routine is set; 💬 Here turns it off): every
  message, forwards too — commands aside, and an answer a waiting `ask_user` picks up. With the
  relay (below) the day's messages, from 00:00 UTC, go to one session; without it each message
  starts its own. A message right after a start — a forward, then what to do with it — joins that
  session, which reads the messages around its own.
- **A group**, once you turn it on in the group's screen: a mention of the bot, or a reply to a
  message your assistant sent there. One person per group: whoever turned it on first. If they leave
  the group, it passes to the next who asks. With the relay, the group's tags of the day go to one
  session, like in the private chat — yours to one, other members' to another, so the session you
  work in never hears a third party.
- **Any chat the bot is not in** (guest mode): tag the bot there, or reply to its message. Telegram
  hands the bot that one message and the one it replied to — no history, no members — and lets it
  post one message per call, which Claude then edits: Claude Code's «✻ Clauding…» at once, the answer when
  ready. Such a chat is connected like a group: the first call there by someone who may use the bot
  and has a routine binds the chat to them. From then on their routine answers there, and other
  people's calls count only if they turn "Others too" on for that chat (🤖 Claude on tag → 🕊 Guest
  chats: others, their hourly limit, the log of starts, disconnect) — under the same rules and
  limits as in a group. Calls go to that chat's session of the day (with the relay) or start one;
  a reply to the bot's message there goes to the chat's latest session. Everything else in that
  chat is a third party's, and what Claude writes there is seen by everyone in it.
- **Other members** of that group too, only if you turn on "Others too" — including messages posted
  as a channel or as the group, which always count as someone else's. The session helps them with
  what anyone could do on their own (answers, explanations, web search, talk about the chat). What is
  yours — connectors, data, memory, other chats, repositories, your account — and running code it
  uses for them only where your memory for the chat explicitly allows it; it declines the rest and
  tells you only on signs of abuse. It runs with your connectors, so that is a guard of instructions, not of
  access. Their starts are limited per chat — 20 an hour by default, 5 to 50 in the group's screen;
  past that the bot reacts 😴 and tells you quietly, once an hour. A reply of theirs to your
  assistant's message starts a new session too, told which session wrote it — under the same rules.

Every start goes into the chat's 📜 Starts: who, when, the first words and a link to the session.

**Who does the work.** The routine runs on Sonnet and does the talking: it answers what it can at
once and hands real work — research, building something, code — to a subagent on Opus, in the
background, so the next message is not kept waiting. An agent sends its result itself and names
itself (`agent`, next to `session`); a reply to that message reaches the session marked as that
agent's, and the session passes it on. The prompt also tells Claude to write the way the chat does
— its language, length and tone — rather than as an assistant with a house style.

**Tags by another name.** If the bot has more usernames than the one BotFather gave it — a
secondary one ending in `agent`, `ai`, `app` or `game`, which Telegram lets Premium owners assign to
two of their bots, or a collectible one — list them in `BOT_USERNAMES` (comma-separated), and a tag
by any of them counts.

Never: commands, edits, answers to the bot's own prompts, a reply that a waiting `ask_user` will
pick up, and — in groups — forwards and messages via inline bots. Each message starts one session at
most, however often Telegram retries it. The bot reacts 👀 when a new session starts (not when a
message goes into one already running); sessions answer by replying to it rather than tagging
anyone. Failures go to your private chat, never to the group. Each start is a billed session that counts toward the
routine's own limits.

### Talking to other sessions

Sessions cannot write to one another by themselves: only a full Claude Code sign-in can put a
message into a cloud session. A **relay** can — any always-on Linux machine of yours (an Oracle free
VM will do) signed in to Claude Code. The bot queues messages; the relay asks for them and the
Worker holds the request until one comes, up to 25 s, so a message is on its way within a couple of
seconds — about 3,500 Worker requests a day, a few percent of the free plan. The relay passes each
one on with `claude -p --cloud <session>`. It needs no open port or domain.

Set it up in the menu: 🤖 Claude → 🛰 Relay → 📋 Install command, and run what it sends on the
machine:

```sh
curl -fsSL https://<your worker>/relay/install.sh | RELAY_TOKEN=relay_… bash
```

It installs curl, jq and Claude Code if missing and runs the relay as a systemd service. Then sign
Claude Code in there once (`claude`, then `/login`) and `sudo systemctl restart tg-relay`. To update
the relay later, run the same `curl … | bash` without `RELAY_TOKEN`: it keeps the token it has.

With the relay:

- A reply to a session's message goes into **that** session instead of starting a new one; so do
  a chat's messages of the day, guest calls among them. Nothing new starts, so the bot puts no 👀 on them.
- `list_sessions` shows the sessions the bot knows of (started by a tag, wrote through the bot, or
  were messaged). `message_session` asks one of them something — "how is the migration going?" —
  or hands it a request, by id or link; the session answers with `answer_session`. A session the
  bot does not know of is reached by its link.
- A session started by a tag first looks for a session already on the request, and asks it or
  hands the request over instead of doing the work twice.

Everything passed on arrives marked as data, with who stands behind it by the bot's own records:
you, a third party, or unknown (a session the bot did not start). A session started by someone
else's tag, or one their replies were passed into, counts as theirs. The receiving session acts for
you; for anyone else it gives a short status answer, and more only where the chat's memory Trust
allows that person. The label rests on the session id the sender gives: every assistant of yours
signs in the same way, so a session talked round can name another's id. It narrows what a message
can claim; it is not proof — keep "Others too" where you trust people.

Without a relay, or while it is down, everything works as before: a reply starts a new session that
carries on, and the session tools say why another session cannot be reached. If the relay's Claude
sign-in expires or it goes quiet, you hear once, and the session that answers instead says so too.

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
- A scene writes two rows per press that changes it (the scene and its redrawn message), and nothing
  for one that does not.

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
  a copy, and that sign-in's tokens are revoked. An assistant used at least once in 90 days never
  has to reconnect.
- **Sign-ins** in the bot's menu lists where an assistant is signed in with your account (Claude,
  ChatGPT, an app on your computer), with when it signed in and was last seen. Signing one out stops
  its tokens on the next call (tokens issued before this list existed run out within a day instead). Upload and download links it already made keep working until they
  expire (10 to 15 minutes); signing out everywhere stops those too.
- **`/disconnect`** (or **Sign out everywhere**) revokes every token you issued. Removing an ID from
  `ALLOWED_USER_IDS` cuts access on the next call.
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
