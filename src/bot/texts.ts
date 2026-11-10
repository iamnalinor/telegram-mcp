/**
 * What the bot says, in English and Russian, picked by the sender's Telegram
 * language. Telegram HTML: only <b>, <i>, <code>, <a> are used, and every
 * interpolated value goes through `escapeHtml`.
 */

import { sessionLink } from "../agents/types";
import type { SandboxPolicy } from "../agents/codex";
import type { CodexRelayState, RelayState } from "../relay";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A session's id as the user reads it: its prefix and the first six characters
 * after it (`oa_3f9c2a`), enough to tell sessions apart. The model always gets
 * the full id.
 */
function shortSession(id: string): string {
  const match = /^([a-z]+_)(.{6})./.exec(id);
  return match ? match[1] + match[2] : id;
}

/** A session under `label`: a link where it has a page, else the label and its short id. */
export function sessionRef(id: string, label: string): string {
  const link = sessionLink(id);
  return link
    ? `<a href="${escapeHtml(link)}">${label}</a>`
    : `${label} <code>${escapeHtml(shortSession(id))}</code>`;
}

/** How a provider's setup is named on the assistant screen. */
const STATE_EN = { set: "set up", none: "not set up", broken: "needs setting up again" };
const STATE_RU = { set: "настроен", none: "не настроен", broken: "нужно настроить заново" };

const en = {
  notAllowed: (id: number) =>
    `This bot is private. Your Telegram ID is <code>${id}</code> — ask its owner to add it to <code>ALLOWED_USER_IDS</code>.`,
  menuIntro: (id: number) =>
    "Hi! I connect your AI assistant (Claude, ChatGPT, Codex) to Telegram: it can message you here, send files, ask you questions with buttons, and read what you send me or what is said in groups you connect.\n\n" +
    `Your Telegram ID: <code>${id}</code>`,
  menuNotConnected:
    "To start, add this bot as a connector in Claude or ChatGPT and sign in with Telegram. Then this menu opens up.",
  helpScreen: (p: { retention: number; privacyOn: boolean }) =>
    [
      "<b>How it works</b>",
      "Your assistant reaches you through me: messages, files, questions with buttons. It reads what you send me and what is said in groups you connect.",
      "",
      `I keep messages for ${p.retention} days and only see chats I am in.` +
        (p.privacyOn
          ? " Privacy mode is on, so in groups I only see commands, mentions and replies to me — turn it off in @BotFather (/setprivacy) and re-add me to see everything."
          : ""),
      "",
      "<b>Commands</b>",
      "/start — this menu",
      "/groups — connected groups",
      "/disconnect — sign out every connected assistant",
    ].join("\n"),
  personalScreen:
    "<b>Personal chats</b>\n\nTo let your assistant read your own chats with other people, add me in Settings → Telegram Business → Chatbots. Whether it may also reply for you is up to the permissions you give me there.",
  // Spelled with the bot's name: with privacy mode on and other bots in the
  // group, a bare /connect may never reach this one.
  addScreen: (bot: string) =>
    `<b>Connect a group</b>\n\nAdd me with the button below — whoever adds me gets access right away.\n\nAlready in the group? Send <code>/connect@${bot}</code> there.`,
  connectInPrivate: (bot: string) =>
    `Add me to a group with the button below, or send <code>/connect@${bot}</code> in a group I'm already in.`,
  groupScreen: (p: { title: string; full: boolean; since: string }) =>
    `<b>${escapeHtml(p.title)}</b>\n\n` +
    (p.full
      ? "Your assistant sees everything I have stored here."
      : `Your assistant sees messages from ${p.since}.`),
  noGroupsMenu: "No groups connected yet. Add me to a group to start.",
  useMenu: "That picker is gone. Send /start for the menu.",
  menuGone: "That group is not connected for you.",
  buttonGroups: "👥 Groups",
  buttonAdd: "➕ Connect a group",
  buttonPersonal: "🔗 Personal chats",
  buttonHelp: "❓ How it works",
  buttonBack: "« Back",
  buttonAddToGroup: "Add to a group",
  buttonRevoke: "Revoke access",
  someAssistant: "An assistant",
  memoryOfMe: "Chat with me",
  memoryNotice: (p: { client: string; chat: string; diff: string }) =>
    `📝 <b>${escapeHtml(p.client)}</b> changed the memory of <b>${escapeHtml(p.chat)}</b>\n\n<pre>${p.diff}</pre>`,
  memoryNoVisibleChange: "(only blank lines or order changed)",
  memoryMoreLines: (n: number) => `… and ${n} more changed line(s)`,
  buttonUndo: "Undo",
  buttonUndoAnyway: "Undo anyway",
  undone: "Undone.",
  undoGone: "That change is too old to undo.",
  undoConfirm: (later: number) =>
    `The memory changed ${later} more time(s) since. Undoing goes back to before this change and drops those too.`,
  buttonMemory: "📝 Memory",
  buttonChatMemory: "📝 Chat memory",
  memoryListScreen: (lines: string[]) =>
    lines.length
      ? `<b>Memory</b>\nWhat your assistants keep about each chat. Tap one to read or delete it.\n\n${lines.join("\n")}`
      : "<b>Memory</b>\n\nNothing yet. Ask your assistant to remember something about a chat.",
  memoryLine: (p: { chat: string; size: number; date: string }) =>
    `• <b>${escapeHtml(p.chat)}</b> — ${p.size} characters, ${p.date}`,
  memoryDoc: (p: { chat: string; content: string }) =>
    `<b>Memory: ${escapeHtml(p.chat)}</b>\n\n<pre>${escapeHtml(p.content)}</pre>`,
  memoryAsFile: (chat: string) =>
    `<b>Memory: ${escapeHtml(chat)}</b>\n\nIt is long, so I sent it as a file.`,
  memoryNone: (chat: string) =>
    `<b>Memory: ${escapeHtml(chat)}</b>\n\nNothing kept for this chat yet.`,
  buttonDelete: "🗑 Delete",
  confirmDeleteMemory: (chat: string) =>
    `Delete the memory of <b>${escapeHtml(chat)}</b>, with its history? This cannot be undone.`,
  buttonConfirmDelete: "Yes, delete",
  memoryDeleted: "Deleted.",
  buttonWipe: "🗑 Erase all memory",
  confirmWipe: "Erase the memory of every chat, with its history? This cannot be undone.",
  buttonConfirmWipe: "Yes, erase everything",
  memoryWiped: "All memory erased.",
  buttonSignIns: "🔑 Sign-ins",
  buttonSignOutAll: "Sign out everywhere",
  buttonConfirmSignOut: "Yes, sign out everywhere",
  buttonCancel: "Cancel",
  signInsScreen: (lines: string[]) =>
    lines.length
      ? `<b>Sign-ins</b>\nWhere an assistant is signed in with your account. Tap one to sign it out.\n\n${lines.join("\n")}`
      : "<b>Sign-ins</b>\n\nNo assistant is signed in with your account.",
  signInLine: (p: { client: string; since: string | null; seen: string }) =>
    `• <b>${escapeHtml(p.client)}</b> — ${p.since ? `signed in ${p.since}, ` : ""}last seen ${p.seen}`,
  signOutButton: (client: string) => `Sign out ${client}`,
  unknownClient: "Unknown client",
  signedOut: "Signed out.",
  alreadySignedOut: "Already signed out.",
  confirmSignOutAll:
    "Sign out every assistant connected with your account? Each of them will have to sign in again.",
  connectFirst:
    "Connect your AI assistant to this bot first (add it as a connector in Claude or ChatGPT and sign in with Telegram), then link groups.",
  leavingNotConnected: (name: string) =>
    `${escapeHtml(name)}, connect your AI assistant to this bot first, then add me again. Leaving for now.`,
  notInGroup:
    "I'm not in that group. Add me there first — whoever adds me gets access automatically.",
  notMember: "You don't seem to be a member of that group, so I can't give you access to it.",
  notAGroup: "That isn't a group.",
  connected: (p: { title: string; full: boolean; retention: number; name?: string }) =>
    `✅ ${p.name ? `${escapeHtml(p.name)}: ` : ""}<b>${escapeHtml(p.title)}</b> is connected. ` +
    (p.full
      ? `Your assistant sees everything I have stored here (up to ${p.retention} days).`
      : "Your assistant sees messages from now on. Older ones stay hidden because this group hides history from new members, or I'm not an admin and can't check — make me an admin with visible history to change that."),
  addedGreeting: (p: { name: string; retention: number; privacyOn: boolean; admin: boolean }) =>
    `👋 Hi! ${escapeHtml(p.name)} added me so their AI assistant can read and post here. ` +
    `I keep messages for ${p.retention} days.` +
    (p.privacyOn && !p.admin
      ? "\n\n⚠️ Privacy mode is on: I only see commands, mentions and replies. Make me an admin, or turn privacy off in @BotFather and re-add me."
      : ""),
  noGroups: "No groups connected. Add me to a group, or send /connect in a group I'm already in.",
  groupsHeader: "<b>Connected groups</b>",
  groupLine: (p: { mark?: string; title: string; full: boolean; since: string }) =>
    `• ${p.mark ?? ""}<b>${escapeHtml(p.title)}</b> — ${p.full ? "full stored history" : `from ${p.since}`}`,
  revokeButton: (title: string) => `Revoke ${title}`,
  revoked: "Access revoked.",
  notYours: "Nothing to revoke.",
  disconnected:
    "Done — every assistant signed in with your account is disconnected. Connect again from your assistant's settings when you want. Your scenes keep running: stop them in /start → 🎬 Scenes.",
  pressed: (label: string) => `✓ ${label}`,
  alreadyAnswered: "Already answered.",
  unknownCommand: "Unknown command. Try /start.",
  business: (p: BusinessStatus) =>
    [
      p.changed
        ? "🔗 Permissions for your personal chats changed."
        : "🔗 You connected me to your account. Your assistant can now read the personal chats you gave me in Telegram's settings, from this moment on. Secret chats, groups and older messages stay out of reach.",
      "",
      "What your assistant may do there:",
      `${p.reply ? "✅" : "🚫"} reply on your behalf — people will see these messages as yours`,
      `${p.read ? "✅" : "🚫"} mark messages as read`,
      `${p.delete ? "✅" : "🚫"} delete messages it sent`,
      "",
      `Only you decide this: Settings → Telegram Business → Chatbots. I keep messages for ${p.retention} days; removing me there deletes them.` +
        (p.signedIn
          ? ""
          : "\n\n⚠️ Connect your AI assistant to this bot first (add it as a connector and sign in with Telegram). Until then I store nothing."),
    ].join("\n"),
  businessOff:
    "🔗 You disconnected me from your account. Everything I stored from your personal chats is deleted.",
  buttonRoutine: "🤖 Assistant",
  assistantScreen: (p: {
    active: "claude" | "openai" | "codex" | null;
    claude: "none" | "set" | "broken";
    openai: "none" | "set" | "broken";
    codex: "none" | "set" | "broken";
  }) =>
    "<b>Assistant</b>\n\nWho answers when you write to me or tag me: one at a time, the one you choose. The others keep their settings, and replies to their earlier messages still go to them.\n\n" +
    (p.active ? "" : "Nothing answers yet: set one up, then choose it.\n\n") +
    `${p.active === "claude" ? "✓" : "•"} Claude — a routine on claude.ai: ${STATE_EN[p.claude]}\n` +
    `${p.active === "codex" ? "✓" : "•"} Codex — the Codex CLI on your machine, through the relay: ${STATE_EN[p.codex]}\n` +
    `${p.active === "openai" ? "✓" : "•"} OpenAI — the Agents API, with your API key: ${STATE_EN[p.openai]}`,
  buttonUse: (name: string, active: boolean) => (active ? `✓ ${name}` : `Use ${name}`),
  buttonSettings: (name: string) => `⚙️ ${name}`,
  providerChosen: (name: string) => `${name} answers now.`,
  providerFirst: (name: string) => `Set ${name} up first.`,
  openaiScreen: (p: {
    state: "none" | "set" | "broken";
    chatModel: string;
    taskModel: string;
    since?: string;
    /** Whether OpenAI's webhooks are set up: failures reach the user then. */
    hooked: boolean;
  }) =>
    "<b>OpenAI</b>\n\nI run sessions on OpenAI's Agents API with your API key: a chat session answers, and hands real work to a task session with a machine of its own. You pay OpenAI per use: a chat message on terra costs roughly $0.02–0.05, a task on sol $0.3–1.5 (terra $1/$5, sol $2/$10 per 1M tokens in/out).\n\n" +
    (p.state === "set"
      ? `✅ Key set ${p.since}.\nChat: <code>${escapeHtml(p.chatModel)}</code>, tasks: <code>${escapeHtml(p.taskModel)}</code>.` +
        (p.hooked
          ? ""
          : "\n\nA session that fails on OpenAI's side does not tell me until you set up the webhook (🔔 Webhook): until then, if no answer comes, check the logs on platform.openai.com.")
      : p.state === "broken"
        ? "⚠️ I can no longer read the saved key: the bot's token changed. Send the key again."
        : "Not set up yet: create a project key on platform.openai.com (API keys) and send it to me."),
  buttonOpenAIKey: "🔑 Send the API key",
  openaiKeyAsk:
    "Send your OpenAI API key (<code>sk-proj-…</code> or <code>sk-svcacct-…</code>). I delete the message right away and keep the key encrypted.",
  openaiKeyNote: "Waiting for the key.",
  buttonChatModel: (model: string) => `💬 Chat: ${model}`,
  buttonTaskModel: (model: string) => `🛠 Tasks: ${model}`,
  modelPicker: (kind: "chat" | "task"): string =>
    kind === "chat"
      ? "The model for the chat session: it talks, reads Telegram and starts tasks."
      : "The model for task sessions: research, code, many-step work.",
  modelSet: "Saved.",
  confirmDeleteOpenAI:
    "Remove the OpenAI key here? I will stop starting sessions with it. Revoke it on platform.openai.com too.",
  openaiSaved: (deleted: boolean) =>
    "✅ Saved your OpenAI key, kept only encrypted" +
    (deleted ? ", and I deleted your message." : "."),
  providerActive: (name: string) => `${name} answers for you now (🤖 Assistant to switch).`,
  providerReady: (name: string, active: string) =>
    `${name} is set up; ${active} still answers for you. Switch in 🤖 Assistant.`,
  openaiNotSaved: "⚠️ Could not save the key. Send it again in a minute.",
  openaiNotActive: (first: boolean) =>
    "The key is saved, but its test start did not go through, so OpenAI does not answer for you yet. " +
    "Once a test in 🤖 Assistant → OpenAI works, choose OpenAI there" +
    (first ? " and turn answering in this chat on." : "."),
  secretTooLong:
    "⚠️ That is longer than any OpenAI key or webhook secret: nothing saved. Copy it again, whole and alone.",
  webhookSaved: (deleted: boolean) =>
    "✅ Saved the webhook secret, kept only encrypted" +
    (deleted ? ", and I deleted your message." : "."),
  webhookNoKey: "That is an OpenAI webhook secret: send the API key first, then the secret.",
  buttonWebhook: "🔔 Webhook",
  webhookScreen: (url: string, secret: boolean) =>
    "<b>OpenAI webhook</b>\n\nSo that I can tell you when a session fails or gets stuck:\n\n" +
    "1. On platform.openai.com open Settings → Webhooks → Create.\n" +
    `2. Paste this URL:\n<code>${escapeHtml(url)}</code>\n` +
    "3. Select the Agents API session events and save.\n" +
    "4. Send me the signing secret it shows (<code>whsec_…</code>). I delete the message right away and keep the secret encrypted.\n\n" +
    (secret
      ? "✅ The secret is set: failed sessions reach you here."
      : "The secret is not set yet: until it is, I ignore what comes to this URL."),
  agentFailed: (session: string, from: { chat: string; link: string | null } | null) =>
    `⚠️ An OpenAI session failed: <code>${escapeHtml(shortSession(session))}</code>.` +
    (from
      ? ` It started from ${from.link ? `<a href="${escapeHtml(from.link)}">a message</a>` : "a message"} in «${escapeHtml(from.chat)}».`
      : "") +
    " What it was doing did not finish: write again to start a new one, or check its logs on platform.openai.com.",
  agentStuck: (session: string, from: { chat: string; link: string | null } | null) =>
    `⏸ An OpenAI session is waiting for an action I cannot give: <code>${escapeHtml(shortSession(session))}</code>.` +
    (from
      ? ` It started from ${from.link ? `<a href="${escapeHtml(from.link)}">a message</a>` : "a message"} in «${escapeHtml(from.chat)}».`
      : "") +
    " It will not go on by itself: write again to start a new one.",
  codexScreen: (p: {
    state: "none" | "set" | "broken";
    relay: CodexRelayState;
    seen: string | null;
    model: string | null;
    sandbox: SandboxPolicy;
    workdir: string | null;
    /** Whether the relay can sandbox: bubblewrap works there. */
    boxes: boolean;
  }) =>
    "<b>Codex</b>\n\nThe Codex CLI on a machine of yours, signed in to your ChatGPT plan: I hand it starts and messages through a relay there, and it works with that machine's files.\n\n" +
    {
      none: "Relay: not set up. Get the install command and run it on the machine (Linux with systemd).",
      online: "Relay: online ✅, with Codex.",
      offline: `Relay: offline ⚠️${p.seen ? ` since ${p.seen}` : " — it has not called in yet"}. Check the machine: <code>systemctl status tg-relay</code>.`,
      nocodex:
        "Relay: online, but it serves Claude ⚠️. A relay serves one assistant: run the install command from this screen to have it serve Codex.",
    }[p.relay] +
    "\n\n" +
    (p.state === "broken"
      ? "⚠️ I can no longer read the saved settings: the bot's token changed. Choose them again."
      : `Model: ${p.model ? `<code>${escapeHtml(p.model)}</code>` : "Codex's default"}. Working directory: ` +
        `${p.workdir ? `<code>${escapeHtml(p.workdir)}</code>` : "the relay's home"}.\n\n` +
        "Sandbox — a sandboxed run goes inside bubblewrap on that machine. It sees its own empty directory, the system's " +
        "programs and your Codex login (it runs on it, so it can read it too), and keeps the network; it does not see your " +
        "files, keys or the relay's token, and its conversations are kept apart from yours. Codex's own read-only sandbox " +
        "applies inside it too, where the machine allows. Outside it Codex can do whatever the relay's user can:\n" +
        (["all", "others", "none"] as const)
          .map(
            (policy) =>
              `${policy === p.sandbox ? "✓" : "•"} ` +
              {
                all: "All: every run is sandboxed.",
                others:
                  "Others: yours run freely; whatever a third party stands behind is sandboxed.",
                none: "None: nothing is sandboxed — anyone you let call me runs commands there.",
              }[policy],
          )
          .join("\n") +
        (p.relay === "online" && !p.boxes && p.sandbox !== "none"
          ? "\n\n⚠️ The relay cannot sandbox: bubblewrap does not work on that machine. Sandboxed runs are refused " +
            "until it does — run the install command there again, it says what is wrong."
          : "")),
  buttonSandbox: (policy: SandboxPolicy, current: boolean) =>
    `${current ? "✓ " : ""}${{ all: "🧱 All", others: "🧱 Others", none: "🧱 None" }[policy]}`,
  buttonCodexModel: (model: string | null) => `🧠 Model: ${model ?? "default"}`,
  buttonWorkdir: "📁 Working directory",
  buttonCodexSetup: "🔌 Sign Codex in",
  codexModelPicker: "The model Codex runs with. «Default»: whatever Codex picks itself.",
  buttonDefaultModel: "Codex's default",
  workdirAsk:
    "Send the directory Codex works in on the relay's machine: an absolute path or one under <code>~</code>, like <code>~/projects</code>. Sandboxed runs do not use it.",
  workdirNote: "Waiting for the directory.",
  workdirInvalid:
    "That is not a path I can use: an absolute path or one under ~, without quotes, $ or backslashes. Send it again, as a reply.",
  codexInstall: (command: string) =>
    "Run this on the machine (Linux with systemd; it asks for sudo). It installs Codex if needed — that takes Node.js and npm — and " +
    `starts the relay as a service:\n<pre>${escapeHtml(command)}</pre>\nThen sign Codex in there once: 🔌 in the Codex screen. ` +
    "This command holds the relay's token. A relay serves one assistant, and you have one relay: getting a new command turns the old one off, Claude's included.",
  codexSetup:
    "<b>Signing Codex in</b>\n\nOnce, on the relay's machine, as the user the relay runs as:\n\n" +
    "1. Sign Codex in to ChatGPT: <code>codex login</code> (on a machine without a browser: <code>codex login --device-auth</code>).\n" +
    "2. <code>sudo systemctl restart tg-relay</code>, then ▶️ Test start.\n\n" +
    "Codex needs no sign-in to me: the relay hands each run a key of its own to my tools, good for that run only. " +
    "You see them as «Codex runs» among the sign-ins.",
  confirmDeleteCodex:
    "Remove the Codex settings? I will stop starting Codex. The relay stays: turn it off in its own screen.",
  codexStartFailed: (error: string) =>
    `⚠️ Codex could not start on your machine: <code>${escapeHtml(error)}</code>. ` +
    "What was sent to it did not get through: write again once that is fixed.",
  codexDeliverFailed: (session: string, error: string) =>
    `⚠️ Codex failed on the message in ${sessionRef(session, "its session")} on your machine: ` +
    `<code>${escapeHtml(error)}</code>. It did not get through: write again to try once more.`,
  routineScreen: (p: { state: "none" | "set" | "broken"; trigger?: string; since?: string }) =>
    "<b>Claude</b>\n\nA Claude Code cloud session that I start for you: it does the work and answers in Telegram. It is your routine on claude.ai and runs on your account.\n\n" +
    (p.state === "set"
      ? `✅ Routine <code>${escapeHtml(p.trigger ?? "")}</code>, set ${p.since}.`
      : p.state === "broken"
        ? "⚠️ I can no longer read the saved token: the bot's token changed. Send the routine again."
        : "Not set up yet: follow the guide, then send me the routine's trigger and token."),
  routineGuide:
    "<b>Setting it up</b>\n\n" +
    "1. Open routines on claude.ai → New routine.\n" +
    "2. Paste the prompt from «Send the prompt». Model: Sonnet — it talks, and hands real work to Opus agents itself. Attach the repositories Claude may work in, if any. Keep the connectors: Telegram must be among them.\n" +
    "3. Add trigger → API → Generate token. Copy the trigger id (trig_…) and the token.\n" +
    "4. Send me both in one message. I delete it right away, keep the token encrypted, and start a test session that writes «ok» here.",
  buttonOpenRoutines: "Open routines",
  buttonSendPrompt: "📋 Send the prompt",
  buttonSetRoutine: "🔑 Set the routine",
  buttonGuide: "📖 Guide",
  buttonTestRoutine: "▶️ Test start",
  buttonDeleteRoutine: "🗑 Remove",
  routinePromptIntro: "The routine's prompt — tap the block to copy it:",
  promptSent: "Sent below.",
  setRoutineAsk:
    "Send the trigger id and the token in one message:\n<code>trig_… sk-ant-oat01-…</code>",
  setRoutineNote: "Waiting for the trigger and the token.",
  confirmDeleteRoutine:
    "Remove the routine here? I will stop starting it. It stays on claude.ai — revoke its token there too.",
  buttonConfirmRemove: "Remove",
  routineDeleted: "Removed.",
  routineSaved: (trigger: string, deleted: boolean) =>
    `✅ Saved routine <code>${escapeHtml(trigger)}</code>. The token is kept only encrypted` +
    (deleted ? ", and I deleted your message." : "."),
  routineNotSaved: "⚠️ Could not save the routine. Send it again in a minute.",
  routineNotActive: (first: boolean) =>
    "The routine is saved, but its test start did not go through, so Claude does not answer for you yet. " +
    "Once a test in 🤖 Assistant → Claude works, choose Claude there" +
    (first ? " and turn answering in this chat on." : "."),
  deleteYourself:
    "⚠️ I could not delete your message: delete it yourself, and if others can see this chat, generate a new token.",
  testTooSoon:
    "A test session was started less than a minute ago. Wait for its «ok», or try again shortly.",
  testStarted: (url: string | null) =>
    `▶️ Started a test session${url ? ` (<a href="${escapeHtml(url)}">open</a>)` : ""}. If everything is set up, it writes «ok» here within a minute or two.`,
  /** `provider` null: none is chosen. */
  fireFailed: (
    reason: FireFailure,
    retryMinutes: number | undefined,
    provider: "claude" | "openai" | "codex" | null,
  ) =>
    provider === null
      ? "⚠️ Nothing started: no assistant is chosen. Set one up and choose it in 🤖 Assistant."
      : provider === "codex"
        ? "⚠️ Could not start Codex: " +
          {
            relay:
              "the relay on your machine is offline or serves another assistant. Check it: <code>systemctl status tg-relay</code>.",
            sandbox:
              "this run is to be sandboxed, and the relay on your machine cannot sandbox: bubblewrap does not work there. " +
              "Run the install command there again — it says what is wrong — or set the sandbox policy to None in 🤖 Assistant → Codex.",
            limit: `too many starts this hour. Try again in ${retryMinutes ?? 60} min.`,
            none: "it is not set up.",
            broken: "I can no longer read its settings. Choose them again in 🤖 Assistant → Codex.",
            token: "the relay did not take it. Try again later.",
            missing: "the relay did not take it. Try again later.",
            paused: "the relay did not take it. Try again later.",
            quota: "the relay did not take it. Try again later.",
            other: "the relay did not take it. Try again later.",
          }[reason]
        : provider === "openai"
          ? "⚠️ Could not start OpenAI: " +
            {
              token: "the API key was refused. Send a new one.",
              missing: "OpenAI's API answered «not found». Try again later.",
              paused: "OpenAI's API did not accept the start. Try again later.",
              limit: `its rate limit is reached. Try again in ${retryMinutes ?? 1} min.`,
              quota: "the key has no quota left. Check billing on platform.openai.com.",
              other: "OpenAI's API did not accept the start. Try again later.",
              relay: "OpenAI's API did not accept the start. Try again later.",
              sandbox: "OpenAI's API did not accept the start. Try again later.",
              none: "no API key is set.",
              broken: "I can no longer read the key. Send it again.",
            }[reason]
          : "⚠️ Could not start the routine: " +
            {
              token:
                "its token was refused. Generate a new one in the routine's trigger and send it again.",
              missing: "there is no such trigger. Check the trig_… id.",
              paused: "it is paused on claude.ai.",
              limit: `its start limit is reached. Try again in ${retryMinutes ?? 60} min.`,
              quota: "Anthropic's API did not accept the start. Try again later.",
              other: "Anthropic's API did not accept the start. Try again later.",
              relay: "Anthropic's API did not accept the start. Try again later.",
              sandbox: "Anthropic's API did not accept the start. Try again later.",
              none: "none is set up.",
              broken: "I can no longer read its token. Send the routine again.",
            }[reason],
  deliverFailed: (reason: FireFailure, retryMinutes?: number) =>
    "⚠️ Could not pass the message to its OpenAI session: " +
    (reason === "token"
      ? "the API key was refused. Send a new one."
      : reason === "limit"
        ? `the rate limit is reached. Try again in ${retryMinutes ?? 1} min.`
        : reason === "quota"
          ? "the key has no quota left. Check billing on platform.openai.com."
          : "OpenAI's API did not take it. Try again later."),
  inChat: (title: string) => `«${escapeHtml(title)}»:`,
  tooManyStarts: "⚠️ Too many starts in the last hour; I start no more until it passes.",
  guestFailed: "⚠️ Could not start your assistant.",
  buttonGuestChats: "🕊 Guest chats",
  guestChatsScreen: (lines: string[]) =>
    "🕊 <b>Guest chats</b>\n\nChats I am not in, where I was called by a tag. The first call in a chat binds it to whoever called: from then on your routine answers there, and your rules apply. Others' calls there count only if you turn «Others too» on.\n\n" +
    (lines.length
      ? lines.join("\n")
      : "None yet: tag me in any chat. Guest Mode must be on for the bot in @BotFather."),
  guestChatScreen: (p: { title: string; others: boolean; limit: number }) =>
    `🕊 <b>${escapeHtml(p.title)}</b>\n\nI am not a member here: I see only the message that calls me and the one it replies to, and answer in one message.\n\n` +
    (p.others
      ? `⚠️ Others there may call me too, up to ${p.limit} times an hour. I help them only with what anyone could do on their own.`
      : "Only your calls count there."),
  guestHeld: (title: string, holder: string) =>
    `ℹ️ You called me in «${escapeHtml(title)}», but that chat is connected to ${holder}: there I answer them, and others only if they allow it.`,
  buttonGuestRelease: "🔌 Disconnect",
  guestReleased: "Disconnected. The next call there binds the chat anew.",
  guestNoAnswer: (title: string) =>
    `⚠️ You called me in «${escapeHtml(title)}», but Telegram did not let me answer there. Check that Guest Mode is on for the bot in @BotFather, then try again.`,
  startsButton: "📜 Starts",
  startsScreen: (title: string, lines: string[]) =>
    `<b>${escapeHtml(title)}</b> — latest starts, newest first (UTC):\n\n${lines.join("\n")}`,
  startsEmpty: (title: string) => `<b>${escapeHtml(title)}</b>: no starts yet.`,
  startsSession: "session",
  startsLimited: (n: number) => `😴 ${n} more held back by the limit in the last 24 hours.`,
  buttonRelay: (state: RelayState) =>
    `🛰 Relay: ${{ none: "off", online: "online ✅", offline: "offline ⚠️", login: "sign-in needed ⚠️", noclaude: "serves Codex ⚠️" }[state]}`,
  relayScreen: (p: { state: RelayState; seen: string | null }) =>
    "🛰 <b>Relay</b>\n\nClaude Code sessions cannot be written to from outside. A relay can: a machine of yours " +
    "signed in to Claude Code that I hand messages to. With it, a reply to a session's message goes to that " +
    "session instead of starting a new one, and sessions can ask each other how things are going. Without it " +
    "everything works as before.\n\n" +
    {
      none: "Not set up. Any always-on Linux machine will do (an Oracle free VM, for one): get the install command and run it there.",
      online: "✅ Online.",
      offline: `⚠️ Offline${p.seen ? ` since ${p.seen}` : " — it has not called in yet"}. Check the machine: <code>systemctl status tg-relay</code>.`,
      login:
        "⚠️ Its Claude sign-in expired. On the machine: <code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>.",
      noclaude:
        "⚠️ Online, but it serves Codex. A relay serves one assistant: run the install command from this screen to have it serve Claude.",
    }[p.state],
  buttonRelayInstall: "📋 Install command",
  buttonRelayOff: "Turn off",
  relayInstall: (command: string) =>
    "Run this on the machine (Linux with systemd; it asks for sudo). It installs Claude Code if needed and " +
    `starts the relay as a service:\n<pre>${escapeHtml(command)}</pre>\nThen sign Claude Code in there once: ` +
    "<code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>. This command holds the " +
    "relay's token. A relay serves one assistant, and you have one relay: getting a new command turns the old one off, Codex's included.",
  relayOff: "Relay turned off.",
  relayLoginLost:
    "⚠️ The relay's Claude sign-in expired, so replies to sessions start new sessions instead. On the machine: <code>claude</code>, then /login, then <code>sudo systemctl restart tg-relay</code>.",
  relayWentOffline:
    "⚠️ The relay has gone quiet: messages to sessions are not getting through, and replies start new sessions instead. Check the machine: <code>systemctl status tg-relay</code>.",
  claudeHere: (on: boolean): string => (on ? "💬 Here: on ✅" : "💬 Here: off"),
  claudeHereHint:
    "Here: every message goes to your assistant — a chat's messages of the day go to one session (from 00:00 UTC), and a reply to a session's message goes back to that session, where the session can take messages (Claude's need the 🛰 relay); otherwise each message starts its own. In groups, turn it on in 👥 Groups. You can also call me from chats I am not in, by tagging me there: see 🕊 Guest chats.",
  claudeToggle: (on: boolean): string =>
    on ? "🤖 Assistant answers: ✅" : "🤖 Assistant answers: off",
  othersToggle: (on: boolean): string => (on ? "👥 Others too: ⚠️ on" : "👥 Others too: off"),
  groupClaude: (p: { on: boolean; others: boolean; limit: number; heldBy: string | null }) =>
    p.heldBy
      ? `\n\n🤖 The assistant answers here for ${p.heldBy}. You can turn yours on once they turn theirs off.`
      : p.on
        ? `\n\n🤖 A mention of me or a reply to your assistant's message starts your assistant — for you` +
          (p.others ? `, and ⚠️ for everyone else here, up to ${p.limit} times an hour.` : " only.")
        : "",
  chatHeld: "An assistant already answers here for someone else.",
  othersLimitButton: (limit: number) => `⏱ Others: up to ${limit}/h`,
  limitPickerTitle: (subject: string, current: number) =>
    `⏱ <b>${escapeHtml(subject)}</b>\n\nHow many times an hour, at most? Now: ${current}. Pick one, or type your own number (1–500).`,
  limitPickerCustom: "✏️ Other number",
  limitPrompt: (subject: string) => `Send a number from 1 to 500 for «${escapeHtml(subject)}».`,
  limitInvalid: "A number from 1 to 500, please.",
  sceneDenied: "Not now.",
  sceneNotForYou: (name: string) => `This button is only for ${name}.`,
  sceneNoWake: "No assistant is connected, so nobody was woken.",
  sceneResting: (minutes: number) => `The assistant is resting. Try again in ${minutes} min.`,
  sceneTooFast: "Not so fast.",
  sceneStale: "This button is out of date.",
  sceneOver: "This scene is over.",
  sceneFull: "The scene is full: nothing more fits.",
  sceneFailed: "That did not work. Try again.",
  sceneWakesLimited: (title: string, minutes: number) =>
    `😴 The scene «${escapeHtml(title)}» reached its wakes for this hour; the next can wake your assistant in ${minutes} min (members see «The assistant is resting»). Change it in 🎬 Scenes.`,
  limitGone: "That is gone meanwhile: nothing to set.",
  buttonScenes: (n: number) => `🎬 Scenes (${n})`,
  scenesScreen: (title: string, lines: string[]) =>
    `🎬 <b>Scenes in «${escapeHtml(title)}»</b>\n\nMessages that run by themselves: buttons, votes, games.\n\n` +
    (lines.length ? lines.join("\n") : "None running."),
  sceneScreen: (p: {
    title: string;
    session: string | null;
    events: number;
    wakes: number;
    limit: number;
  }) =>
    `🎬 <b>${escapeHtml(p.title)}</b>\n\n` +
    (p.session
      ? `Wakes go to ${sessionRef(p.session, "a session")}.`
      : "No session behind it: a wake starts your assistant if one is set up, and otherwise wakes nobody.") +
    `\nEvents logged: ${p.events}.\nWakes this hour: ${p.wakes} of ${p.limit}.`,
  buttonSceneWakes: (limit: number) => `⏱ Wakes: up to ${limit}/h`,
  buttonStopScene: "■ Stop",
  sceneStopped: "Stopped: the buttons are gone.",
  buttonScenesHub: "🎬 Scenes",
  scenesHub: (lines: string[], saved: number) =>
    "🎬 <b>Scenes</b>\n\nMessages that run by themselves: buttons, votes, games. Your assistant makes them, and keeps every one it makes in 📚 Saved scenes: start one from there in this chat, whether an assistant is connected or not.\n\n<b>Running</b>\n" +
    (lines.length ? lines.join("\n") : "None running.") +
    (saved ? "" : "\n\nNo saved scenes yet: ask your assistant to make one."),
  buttonSavedScenes: (n: number) => `📚 Saved scenes (${n})`,
  savedScenesScreen: (lines: string[]) =>
    `📚 <b>Saved scenes</b>\n\nThe most recently used first. Pick one to start it in this chat.\n\n${lines.join("\n")}`,
  savedSceneScreen: (p: {
    name: string;
    title: string;
    brief: string | null;
    version: number;
    uses: number;
  }) =>
    `📄 <b>${escapeHtml(p.title)}</b>\n<code>${escapeHtml(p.name)}</code> · version ${p.version} · started ${p.uses} time${p.uses === 1 ? "" : "s"}` +
    (p.brief ? `\n\n<i>${escapeHtml(p.brief)}</i>` : "") +
    "\n\nIt starts in this chat, as yours. A button that wakes the assistant starts yours if one is set up; otherwise it works without waking anyone.",
  buttonStartScene: "▶ Start here",
  buttonDeleteSaved: "🗑 Delete",
  confirmDeleteSaved: (name: string) =>
    `Delete the saved scene «${escapeHtml(name)}» and its earlier versions? Scenes running from it go on.`,
  savedDeleted: "Deleted.",
  sceneStarted: "Started: it is in this chat now.",
  sceneCannotStart:
    "This saved scene cannot start: it no longer checks out. Ask your assistant to fix it.",
  sceneStartRefused: "Telegram did not take the message. Try again later.",
  scenesFull: (n: number) => `You have ${n} scenes running in this chat: stop one first.`,
  sceneMenuGone: "That is gone already.",
  privateChatName: "your private chat",
  buttonPrev: "← Newer",
  buttonNext: "Older →",
  othersLimited: (limit: number) =>
    `😴 Other members used up ${limit} starts this hour; theirs wait until it passes (they see 😴). Change the limit in 👥 Groups.`,
  routineFirst: "Set up 🤖 Assistant first.",
  othersWarning: (title: string) =>
    `⚠️ Your assistant will answer the members of «${escapeHtml(title)}». It is told not to do what they ask or share your data unless your memory for this chat allows it. But that is a guard of instructions, not of access: the session has your connectors, chats and repositories, and a clever message can talk it round. Turn it on where you trust people. Every start goes into 📜 Starts here.`,
  buttonTurnOn: "Turn on",
  privacyHint:
    "👁 I am not an admin here and privacy mode is on: I see only mentions and replies, so your assistant may miss the context. Make me an admin to fix it.",
  testPassed: (at: string) => `✅ The test start at ${at} answered: it works.`,
  testWaiting: (at: string) =>
    `⏳ Test started at ${at}, no answer yet. If none comes, check that the routine has the Telegram connector.`,
  secretDropped: (deleted: boolean) =>
    (deleted
      ? "That looked like an API key, so I deleted the message and kept nothing."
      : "That looked like an API key, so I kept nothing.") +
    " To set the routine, send its trig_… id and the token together, in one message.",
};

type FireFailure =
  | "token"
  | "missing"
  | "paused"
  | "limit"
  | "quota"
  | "relay"
  | "sandbox"
  | "other"
  | "none"
  | "broken";

interface BusinessStatus {
  changed: boolean;
  reply: boolean;
  read: boolean;
  delete: boolean;
  retention: number;
  signedIn: boolean;
}

type Texts = typeof en;

const ru: Texts = {
  notAllowed: (id) =>
    `Это приватный бот. Твой Telegram ID: <code>${id}</code> — попроси владельца добавить его в <code>ALLOWED_USER_IDS</code>.`,
  menuIntro: (id) =>
    "Привет! Я связываю твоего AI-ассистента (Claude, ChatGPT, Codex) с Telegram: он может писать тебе сюда, присылать файлы, задавать вопросы с кнопками и читать, что ты мне пишешь или что пишут в подключённых группах.\n\n" +
    `Твой Telegram ID: <code>${id}</code>`,
  menuNotConnected:
    "Для начала добавь этого бота как коннектор в Claude или ChatGPT и войди через Telegram. Тогда откроется меню.",
  helpScreen: (p) =>
    [
      "<b>Как это работает</b>",
      "Ассистент связывается с тобой через меня: сообщения, файлы, вопросы с кнопками. Он читает, что ты мне пишешь и что пишут в подключённых группах.",
      "",
      `Храню сообщения ${p.retention} дней и вижу только чаты, где я есть.` +
        (p.privacyOn
          ? " Включён privacy mode: в группах я вижу только команды, упоминания и ответы мне — выключи его в @BotFather (/setprivacy) и добавь меня заново, чтобы видеть всё."
          : ""),
      "",
      "<b>Команды</b>",
      "/start — это меню",
      "/groups — подключённые группы",
      "/disconnect — отключить все подключённые ассистенты",
    ].join("\n"),
  personalScreen:
    "<b>Личные переписки</b>\n\nЧтобы ассистент читал твои переписки с другими людьми, добавь меня в Настройки → Telegram для бизнеса → Чат-боты. Может ли он ещё и отвечать за тебя — решают права, которые ты дашь мне там.",
  addScreen: (bot) =>
    `<b>Подключить группу</b>\n\nДобавь меня кнопкой ниже — тот, кто добавляет, сразу получает доступ.\n\nЯ уже в группе? Отправь <code>/connect@${bot}</code> прямо там.`,
  connectInPrivate: (bot) =>
    `Добавь меня в группу кнопкой ниже или отправь <code>/connect@${bot}</code> в группе, где я уже есть.`,
  groupScreen: (p) =>
    `<b>${escapeHtml(p.title)}</b>\n\n` +
    (p.full
      ? "Ассистенту видно всё, что я здесь сохранил."
      : `Ассистенту видны сообщения с ${p.since}.`),
  noGroupsMenu: "Подключённых групп пока нет. Добавь меня в группу, чтобы начать.",
  useMenu: "Этого выбора больше нет. Отправь /start, чтобы открыть меню.",
  menuGone: "Эта группа у тебя не подключена.",
  buttonGroups: "👥 Группы",
  buttonAdd: "➕ Подключить группу",
  buttonPersonal: "🔗 Личные переписки",
  buttonHelp: "❓ Как это работает",
  buttonBack: "« Назад",
  buttonAddToGroup: "Добавить в группу",
  buttonRevoke: "Отозвать доступ",
  someAssistant: "Ассистент",
  memoryOfMe: "Чат со мной",
  memoryNotice: (p) =>
    `📝 <b>${escapeHtml(p.client)}</b> изменил память «<b>${escapeHtml(p.chat)}</b>»\n\n<pre>${p.diff}</pre>`,
  memoryNoVisibleChange: "(поменялись только пустые строки или порядок)",
  memoryMoreLines: (n) => `… и ещё строк изменено: ${n}`,
  buttonUndo: "Отменить",
  buttonUndoAnyway: "Всё равно отменить",
  undone: "Отменено.",
  undoGone: "Это изменение слишком старое, отменить нельзя.",
  undoConfirm: (later) =>
    `После этого память менялась ещё ${later} раз(а). Отмена вернёт её к состоянию до этого изменения и уберёт и их.`,
  buttonMemory: "📝 Память",
  buttonChatMemory: "📝 Память чата",
  memoryListScreen: (lines) =>
    lines.length
      ? `<b>Память</b>\nЧто ассистенты помнят о каждом чате. Нажми, чтобы прочитать или удалить.\n\n${lines.join("\n")}`
      : "<b>Память</b>\n\nПока пусто. Попроси ассистента запомнить что-нибудь о чате.",
  memoryLine: (p) => `• <b>${escapeHtml(p.chat)}</b> — ${p.size} символов, ${p.date}`,
  memoryDoc: (p) => `<b>Память: ${escapeHtml(p.chat)}</b>\n\n<pre>${escapeHtml(p.content)}</pre>`,
  memoryAsFile: (chat) =>
    `<b>Память: ${escapeHtml(chat)}</b>\n\nОна длинная, поэтому прислал её файлом.`,
  memoryNone: (chat) =>
    `<b>Память: ${escapeHtml(chat)}</b>\n\nОб этом чате пока ничего не сохранено.`,
  buttonDelete: "🗑 Удалить",
  confirmDeleteMemory: (chat) =>
    `Удалить память «<b>${escapeHtml(chat)}</b>» вместе с историей? Отменить будет нельзя.`,
  buttonConfirmDelete: "Да, удалить",
  memoryDeleted: "Удалено.",
  buttonWipe: "🗑 Стереть всю память",
  confirmWipe: "Стереть память всех чатов вместе с историей? Отменить будет нельзя.",
  buttonConfirmWipe: "Да, стереть всё",
  memoryWiped: "Вся память стёрта.",
  buttonSignIns: "🔑 Входы",
  buttonSignOutAll: "Выйти везде",
  buttonConfirmSignOut: "Да, выйти везде",
  buttonCancel: "Отмена",
  signInsScreen: (lines) =>
    lines.length
      ? `<b>Входы</b>\nГде под твоим аккаунтом вошёл ассистент. Нажми, чтобы выйти.\n\n${lines.join("\n")}`
      : "<b>Входы</b>\n\nПод твоим аккаунтом не вошёл ни один ассистент.",
  signInLine: (p) =>
    `• <b>${escapeHtml(p.client)}</b> — ${p.since ? `вошёл ${p.since}, ` : ""}последняя активность ${p.seen}`,
  signOutButton: (client) => `Выйти: ${client}`,
  unknownClient: "Неизвестный клиент",
  signedOut: "Вход завершён.",
  alreadySignedOut: "Этот вход уже завершён.",
  confirmSignOutAll:
    "Выйти из всех ассистентов, подключённых под твоим аккаунтом? Каждому придётся войти заново.",
  connectFirst:
    "Сначала подключи AI-ассистента к этому боту (добавь коннектор в Claude или ChatGPT и войди через Telegram), потом привязывай группы.",
  leavingNotConnected: (name) =>
    `${escapeHtml(name)}, сначала подключи AI-ассистента к этому боту, потом добавь меня снова. Пока выхожу.`,
  notInGroup:
    "Меня нет в этой группе. Сначала добавь меня — тот, кто добавляет, получает доступ сразу.",
  notMember: "Похоже, ты не участник этой группы, поэтому доступ дать не могу.",
  notAGroup: "Это не группа.",
  connected: (p) =>
    `✅ ${p.name ? `${escapeHtml(p.name)}: ` : ""}<b>${escapeHtml(p.title)}</b> подключена. ` +
    (p.full
      ? `Ассистенту видно всё, что я здесь сохранил (до ${p.retention} дней).`
      : "Ассистенту видны сообщения с этого момента. Старые скрыты: в группе история скрыта от новых участников, или я не админ и не могу это проверить — сделай меня админом с видимой историей, чтобы это изменить."),
  addedGreeting: (p) =>
    `👋 Привет! ${escapeHtml(p.name)} добавил(а) меня, чтобы AI-ассистент мог читать и писать здесь. ` +
    `Храню сообщения ${p.retention} дней.` +
    (p.privacyOn && !p.admin
      ? "\n\n⚠️ Включён privacy mode: я вижу только команды, упоминания и ответы. Сделай меня админом или выключи privacy в @BotFather и добавь меня заново."
      : ""),
  noGroups:
    "Нет подключённых групп. Добавь меня в группу или отправь /connect в группе, где я уже есть.",
  groupsHeader: "<b>Подключённые группы</b>",
  groupLine: (p) =>
    `• ${p.mark ?? ""}<b>${escapeHtml(p.title)}</b> — ${p.full ? "вся сохранённая история" : `с ${p.since}`}`,
  revokeButton: (title) => `Отозвать ${title}`,
  revoked: "Доступ отозван.",
  notYours: "Нечего отзывать.",
  disconnected:
    "Готово — все ассистенты, подключённые под твоим аккаунтом, отключены. Подключиться снова можно в настройках ассистента. Сцены продолжают идти: остановить их можно в /start → 🎬 Сцены.",
  pressed: (label) => `✓ ${label}`,
  alreadyAnswered: "Уже отвечено.",
  unknownCommand: "Не знаю такой команды. Попробуй /start.",
  business: (p) =>
    [
      p.changed
        ? "🔗 Права в личных переписках изменились."
        : "🔗 Ты подключил(а) меня к своему аккаунту. Теперь ассистент может читать личные переписки, которые ты отдал(а) мне в настройках Telegram, начиная с этого момента. Секретные чаты, группы и старые сообщения недоступны.",
      "",
      "Что ассистент может делать в них:",
      `${p.reply ? "✅" : "🚫"} отвечать от твоего имени — собеседники увидят это как твои сообщения`,
      `${p.read ? "✅" : "🚫"} отмечать сообщения прочитанными`,
      `${p.delete ? "✅" : "🚫"} удалять отправленные им сообщения`,
      "",
      `Решаешь только ты: Настройки → Telegram для бизнеса → Чат-боты. Храню сообщения ${p.retention} дней; если убрать меня там, всё удалю.` +
        (p.signedIn
          ? ""
          : "\n\n⚠️ Сначала подключи AI-ассистента к этому боту (добавь коннектор и войди через Telegram). До этого я ничего не сохраняю."),
    ].join("\n"),
  businessOff:
    "🔗 Ты отключил(а) меня от своего аккаунта. Всё, что я сохранил из личных переписок, удалено.",
  buttonRoutine: "🤖 Ассистент",
  assistantScreen: (p) =>
    "<b>Ассистент</b>\n\nКто отвечает, когда ты пишешь мне или тегаешь меня: только один — тот, кого ты выберешь. У остальных настройки сохраняются, а ответы на их прежние сообщения по-прежнему идут им.\n\n" +
    (p.active ? "" : "Пока никто не отвечает: настрой одного и выбери его.\n\n") +
    `${p.active === "claude" ? "✓" : "•"} Claude — рутина на claude.ai: ${STATE_RU[p.claude]}\n` +
    `${p.active === "codex" ? "✓" : "•"} Codex — Codex CLI на твоей машине, через relay: ${STATE_RU[p.codex]}\n` +
    `${p.active === "openai" ? "✓" : "•"} OpenAI — Agents API с твоим API-ключом: ${STATE_RU[p.openai]}`,
  buttonUse: (name, active) => (active ? `✓ ${name}` : `Выбрать ${name}`),
  buttonSettings: (name) => `⚙️ ${name}`,
  providerChosen: (name) => `Теперь отвечает ${name}.`,
  providerFirst: (name) => `Сначала настрой ${name}.`,
  openaiScreen: (p) =>
    "<b>OpenAI</b>\n\nЯ запускаю сессии в Agents API от OpenAI с твоим API-ключом: чат-сессия отвечает, а настоящую работу отдаёт сессии-задаче со своей машиной. Платишь OpenAI по факту: сообщение в чате на terra — примерно $0.02–0.05, задача на sol — $0.3–1.5 (terra $1/$5, sol $2/$10 за 1M токенов на вход/выход).\n\n" +
    (p.state === "set"
      ? `✅ Ключ задан ${p.since}.\nЧат: <code>${escapeHtml(p.chatModel)}</code>, задачи: <code>${escapeHtml(p.taskModel)}</code>.` +
        (p.hooked
          ? ""
          : "\n\nЕсли сессия упала на стороне OpenAI, я не узнаю об этом, пока ты не настроишь вебхук (🔔 Вебхук): до тех пор, если ответа нет, посмотри логи на platform.openai.com.")
      : p.state === "broken"
        ? "⚠️ Я больше не могу прочитать сохранённый ключ: сменился токен бота. Пришли ключ заново."
        : "Ещё не настроено: создай ключ проекта на platform.openai.com (API keys) и пришли его мне."),
  buttonOpenAIKey: "🔑 Прислать API-ключ",
  openaiKeyAsk:
    "Пришли свой API-ключ OpenAI (<code>sk-proj-…</code> или <code>sk-svcacct-…</code>). Я сразу удалю сообщение, а ключ сохраню только в зашифрованном виде.",
  openaiKeyNote: "Жду ключ.",
  buttonChatModel: (model) => `💬 Чат: ${model}`,
  buttonTaskModel: (model) => `🛠 Задачи: ${model}`,
  modelPicker: (kind) =>
    kind === "chat"
      ? "Модель чат-сессии: она общается, читает Telegram и запускает задачи."
      : "Модель сессий-задач: исследования, код, многошаговая работа.",
  modelSet: "Сохранено.",
  confirmDeleteOpenAI:
    "Удалить ключ OpenAI отсюда? Я перестану запускать с ним сессии. Отзови его и на platform.openai.com.",
  openaiSaved: (deleted) =>
    "✅ Ключ OpenAI сохранён, только в зашифрованном виде" +
    (deleted ? ", а твоё сообщение я удалил." : "."),
  providerActive: (name) => `Теперь тебе отвечает ${name} (переключить — в 🤖 Ассистенте).`,
  providerReady: (name, active) =>
    `${name} настроен; тебе по-прежнему отвечает ${active}. Переключить — в 🤖 Ассистенте.`,
  openaiNotSaved: "⚠️ Не получилось сохранить ключ. Пришли его ещё раз через минуту.",
  openaiNotActive: (first) =>
    "Ключ сохранён, но тестовый запуск не прошёл, так что OpenAI тебе пока не отвечает. " +
    "Когда тест в 🤖 Ассистент → OpenAI заработает, выбери там OpenAI" +
    (first ? " и включи ответы в этом чате." : "."),
  secretTooLong:
    "⚠️ Это длиннее любого ключа или секрета вебхука OpenAI: ничего не сохранено. Скопируй его ещё раз, целиком и отдельно.",
  webhookSaved: (deleted) =>
    "✅ Секрет вебхука сохранён, только в зашифрованном виде" +
    (deleted ? ", а твоё сообщение я удалил." : "."),
  webhookNoKey: "Это секрет вебхука OpenAI: сначала пришли API-ключ, потом секрет.",
  buttonWebhook: "🔔 Вебхук",
  webhookScreen: (url, secret) =>
    "<b>Вебхук OpenAI</b>\n\nЧтобы я сообщал, когда сессия упала или застряла:\n\n" +
    "1. На platform.openai.com открой Settings → Webhooks → Create.\n" +
    `2. Вставь этот URL:\n<code>${escapeHtml(url)}</code>\n` +
    "3. Выбери события сессий Agents API и сохрани.\n" +
    "4. Пришли мне секрет подписи, который он покажет (<code>whsec_…</code>). Я сразу удалю сообщение, а секрет сохраню только в зашифрованном виде.\n\n" +
    (secret
      ? "✅ Секрет задан: об упавших сессиях я сообщу сюда."
      : "Секрет ещё не задан: пока его нет, я не слушаю, что приходит на этот URL."),
  agentFailed: (session, from) =>
    `⚠️ Сессия OpenAI упала: <code>${escapeHtml(shortSession(session))}</code>.` +
    (from
      ? ` Её запустило ${from.link ? `<a href="${escapeHtml(from.link)}">сообщение</a>` : "сообщение"} в «${escapeHtml(from.chat)}».`
      : "") +
    " Начатое она не закончила: напиши ещё раз, чтобы запустить новую, или посмотри её логи на platform.openai.com.",
  agentStuck: (session, from) =>
    `⏸ Сессия OpenAI ждёт действия, которое я дать не могу: <code>${escapeHtml(shortSession(session))}</code>.` +
    (from
      ? ` Её запустило ${from.link ? `<a href="${escapeHtml(from.link)}">сообщение</a>` : "сообщение"} в «${escapeHtml(from.chat)}».`
      : "") +
    " Сама она дальше не пойдёт: напиши ещё раз, чтобы запустить новую.",
  codexScreen: (p) =>
    "<b>Codex</b>\n\nCodex CLI на твоей машине, со входом в твою подписку ChatGPT: я передаю ему запуски и сообщения через relay на ней, и он работает с файлами этой машины.\n\n" +
    {
      none: "Relay: не настроен. Возьми команду установки и запусти её на машине (Linux с systemd).",
      online: "Relay: онлайн ✅, с Codex.",
      offline: `Relay: офлайн ⚠️${p.seen ? ` с ${p.seen}` : " — он ещё ни разу не выходил на связь"}. Проверь машину: <code>systemctl status tg-relay</code>.`,
      nocodex:
        "Relay: онлайн, но служит Claude ⚠️. Relay служит одному ассистенту: запусти команду установки с этого экрана, чтобы он служил Codex.",
    }[p.relay] +
    "\n\n" +
    (p.state === "broken"
      ? "⚠️ Я больше не могу прочитать сохранённые настройки: сменился токен бота. Выбери их заново."
      : `Модель: ${p.model ? `<code>${escapeHtml(p.model)}</code>` : "по умолчанию Codex"}. Рабочая папка: ` +
        `${p.workdir ? `<code>${escapeHtml(p.workdir)}</code>` : "домашняя папка relay"}.\n\n` +
        "Песочница — запуск в ней идёт внутри bubblewrap на этой машине. Он видит свою пустую папку, системные программы " +
        "и твой вход в Codex (он на нём работает, так что может его и прочитать) и остаётся с сетью; твоих файлов, ключей " +
        "и токена relay он не видит, а его переписки хранятся отдельно от твоих. Внутри, где машина позволяет, действует " +
        "ещё и собственная песочница Codex (только чтение). Вне её Codex может всё, что может пользователь relay:\n" +
        (["all", "others", "none"] as const)
          .map(
            (policy) =>
              `${policy === p.sandbox ? "✓" : "•"} ` +
              {
                all: "Все: любой запуск в песочнице.",
                others:
                  "Чужие: твои запуски без неё; всё, за чем стоит третье лицо, — в песочнице.",
                none: "Никто: песочницы нет — любой, кому ты разрешил звать меня, запускает там команды.",
              }[policy],
          )
          .join("\n") +
        (p.relay === "online" && !p.boxes && p.sandbox !== "none"
          ? "\n\n⚠️ Relay не умеет делать песочницу: на той машине не работает bubblewrap. Запуски в песочнице " +
            "не пойдут, пока он не заработает, — запусти там команду установки ещё раз, она скажет, в чём дело."
          : "")),
  buttonSandbox: (policy, current) =>
    `${current ? "✓ " : ""}${{ all: "🧱 Все", others: "🧱 Чужие", none: "🧱 Никто" }[policy]}`,
  buttonCodexModel: (model) => `🧠 Модель: ${model ?? "по умолчанию"}`,
  buttonWorkdir: "📁 Рабочая папка",
  buttonCodexSetup: "🔌 Вход в Codex",
  codexModelPicker: "Модель, на которой работает Codex. «По умолчанию» — какую выберет сам Codex.",
  buttonDefaultModel: "По умолчанию Codex",
  workdirAsk:
    "Пришли папку, в которой Codex работает на машине relay: абсолютный путь или путь под <code>~</code>, например <code>~/projects</code>. Запуски в песочнице её не используют.",
  workdirNote: "Жду папку.",
  workdirInvalid:
    "Такой путь я принять не могу: нужен абсолютный путь или путь под ~, без кавычек, $ и обратных слэшей. Пришли ещё раз, ответом.",
  codexInstall: (command) =>
    "Запусти это на машине (Linux с systemd; попросит sudo). Команда поставит Codex, если его нет — для этого нужны Node.js и npm, — и " +
    `запустит relay как сервис:\n<pre>${escapeHtml(command)}</pre>\nПотом один раз войди там в Codex: 🔌 на экране Codex. ` +
    "В команде токен relay. Relay служит одному ассистенту, и он у тебя один: новая команда отключает старый, в том числе у Claude.",
  codexSetup:
    "<b>Вход в Codex</b>\n\nОдин раз, на машине relay, от того пользователя, под которым он работает:\n\n" +
    "1. Войди в Codex через ChatGPT: <code>codex login</code> (на машине без браузера: <code>codex login --device-auth</code>).\n" +
    "2. <code>sudo systemctl restart tg-relay</code>, потом ▶️ Тестовый запуск.\n\n" +
    "Входить в меня Codex не нужно: relay выдаёт каждому запуску собственный ключ к моим инструментам, только на этот запуск. " +
    "В списке входов они видны как «Codex runs».",
  confirmDeleteCodex:
    "Удалить настройки Codex? Я перестану запускать Codex. Relay останется: его можно выключить на его экране.",
  codexStartFailed: (error) =>
    `⚠️ Codex не смог запуститься на твоей машине: <code>${escapeHtml(error)}</code>. ` +
    "Отправленное ему не дошло: напиши ещё раз, когда это будет исправлено.",
  codexDeliverFailed: (session, error) =>
    `⚠️ Codex сломался на сообщении в ${sessionRef(session, "его сессии")} на твоей машине: ` +
    `<code>${escapeHtml(error)}</code>. Оно не дошло: напиши ещё раз, чтобы попробовать снова.`,
  routineScreen: (p) =>
    "<b>Claude</b>\n\nОблачная сессия Claude Code, которую я запускаю для тебя: она делает работу и отвечает в Telegram. Это твоя рутина на claude.ai, она работает от твоего аккаунта.\n\n" +
    (p.state === "set"
      ? `✅ Рутина <code>${escapeHtml(p.trigger ?? "")}</code>, задана ${p.since}.`
      : p.state === "broken"
        ? "⚠️ Я больше не могу прочитать сохранённый токен: сменился токен бота. Пришли рутину заново."
        : "Ещё не настроено: пройди инструкцию и пришли мне триггер и токен рутины."),
  routineGuide:
    "<b>Настройка</b>\n\n" +
    "1. Открой рутины на claude.ai → New routine.\n" +
    "2. Вставь промпт из «Прислать промпт». Модель — Sonnet: она общается, а задачи сама отдаёт агентам на Opus. Подключи репозитории, в которых Claude может работать, если нужны. Коннекторы оставь: среди них должен быть Telegram.\n" +
    "3. Add trigger → API → Generate token. Скопируй id триггера (trig_…) и токен.\n" +
    "4. Пришли мне оба одним сообщением. Я сразу его удалю, токен сохраню только в зашифрованном виде и запущу тестовую сессию — она напишет сюда «ok».",
  buttonOpenRoutines: "Открыть рутины",
  buttonSendPrompt: "📋 Прислать промпт",
  buttonSetRoutine: "🔑 Задать рутину",
  buttonGuide: "📖 Инструкция",
  buttonTestRoutine: "▶️ Тестовый запуск",
  buttonDeleteRoutine: "🗑 Удалить",
  routinePromptIntro: "Промпт рутины — нажми на блок, чтобы скопировать:",
  promptSent: "Прислал ниже.",
  setRoutineAsk: "Пришли id триггера и токен одним сообщением:\n<code>trig_… sk-ant-oat01-…</code>",
  setRoutineNote: "Жду триггер и токен.",
  confirmDeleteRoutine:
    "Удалить рутину отсюда? Я перестану её запускать. На claude.ai она останется — отзови там и её токен.",
  buttonConfirmRemove: "Удалить",
  routineDeleted: "Удалено.",
  routineSaved: (trigger, deleted) =>
    `✅ Рутина <code>${escapeHtml(trigger)}</code> сохранена. Токен хранится только зашифрованным` +
    (deleted ? ", а твоё сообщение я удалил." : "."),
  routineNotSaved: "⚠️ Не получилось сохранить рутину. Пришли её ещё раз через минуту.",
  routineNotActive: (first) =>
    "Рутина сохранена, но тестовый запуск не прошёл, так что Claude тебе пока не отвечает. " +
    "Когда тест в 🤖 Ассистент → Claude заработает, выбери там Claude" +
    (first ? " и включи ответы в этом чате." : "."),
  deleteYourself:
    "⚠️ Не получилось удалить твоё сообщение: удали его сам, а если этот чат видят другие — сгенерируй новый токен.",
  testTooSoon:
    "Тестовая сессия уже запущена меньше минуты назад. Дождись её «ok» или попробуй чуть позже.",
  testStarted: (url) =>
    `▶️ Запустил тестовую сессию${url ? ` (<a href="${escapeHtml(url)}">открыть</a>)` : ""}. Если всё настроено, через минуту-две она напишет сюда «ok».`,
  fireFailed: (reason, retryMinutes, provider) =>
    provider === null
      ? "⚠️ Ничего не запущено: ассистент не выбран. Настрой и выбери его в 🤖 Ассистенте."
      : provider === "codex"
        ? "⚠️ Не получилось запустить Codex: " +
          {
            relay:
              "relay на твоей машине офлайн или служит не Codex. Проверь его: <code>systemctl status tg-relay</code>.",
            sandbox:
              "этот запуск должен идти в песочнице, а relay на твоей машине не умеет её делать: там не работает bubblewrap. " +
              "Запусти там команду установки ещё раз — она скажет, в чём дело, — или выбери политику песочницы «Никто» в 🤖 Ассистент → Codex.",
            limit: `слишком много запусков за час. Попробуй через ${retryMinutes ?? 60} мин.`,
            none: "он не настроен.",
            broken:
              "я больше не могу прочитать его настройки. Выбери их заново в 🤖 Ассистент → Codex.",
            token: "relay его не принял. Попробуй позже.",
            missing: "relay его не принял. Попробуй позже.",
            paused: "relay его не принял. Попробуй позже.",
            quota: "relay его не принял. Попробуй позже.",
            other: "relay его не принял. Попробуй позже.",
          }[reason]
        : provider === "openai"
          ? "⚠️ Не получилось запустить OpenAI: " +
            {
              token: "API-ключ не принят. Пришли новый.",
              missing: "API OpenAI ответил «не найдено». Попробуй позже.",
              paused: "API OpenAI не принял запуск. Попробуй позже.",
              limit: `исчерпан лимит запросов. Попробуй через ${retryMinutes ?? 1} мин.`,
              quota: "у ключа закончилась квота. Проверь оплату на platform.openai.com.",
              other: "API OpenAI не принял запуск. Попробуй позже.",
              relay: "API OpenAI не принял запуск. Попробуй позже.",
              sandbox: "API OpenAI не принял запуск. Попробуй позже.",
              none: "API-ключ не задан.",
              broken: "я больше не могу прочитать ключ. Пришли его заново.",
            }[reason]
          : "⚠️ Не получилось запустить рутину: " +
            {
              token: "её токен не принят. Сгенерируй новый в триггере рутины и пришли заново.",
              missing: "такого триггера нет. Проверь id trig_….",
              paused: "она на паузе на claude.ai.",
              limit: `исчерпан лимит запусков. Попробуй через ${retryMinutes ?? 60} мин.`,
              quota: "API Anthropic не принял запуск. Попробуй позже.",
              other: "API Anthropic не принял запуск. Попробуй позже.",
              relay: "API Anthropic не принял запуск. Попробуй позже.",
              sandbox: "API Anthropic не принял запуск. Попробуй позже.",
              none: "она не задана.",
              broken: "я больше не могу прочитать её токен. Пришли рутину заново.",
            }[reason],
  deliverFailed: (reason, retryMinutes) =>
    "⚠️ Не получилось передать сообщение в его сессию OpenAI: " +
    (reason === "token"
      ? "API-ключ не принят. Пришли новый."
      : reason === "limit"
        ? `исчерпан лимит запросов. Попробуй через ${retryMinutes ?? 1} мин.`
        : reason === "quota"
          ? "у ключа закончилась квота. Проверь оплату на platform.openai.com."
          : "API OpenAI его не принял. Попробуй позже."),
  inChat: (title) => `«${escapeHtml(title)}»:`,
  tooManyStarts: "⚠️ Слишком много запусков за последний час; новых не будет, пока он не пройдёт.",
  guestFailed: "⚠️ Не получилось запустить ассистента.",
  buttonGuestChats: "🕊 Гостевые чаты",
  guestChatsScreen: (lines) =>
    "🕊 <b>Гостевые чаты</b>\n\nЧаты, где меня нет, но куда меня позвали тегом. Первый вызов привязывает чат к тому, кто позвал: дальше там отвечает твоя рутина и действуют твои правила. Чужие вызовы считаются, только если включишь «Отвечать другим».\n\n" +
    (lines.length
      ? lines.join("\n")
      : "Пока ни одного: тегни меня в любом чате. У бота в @BotFather должен быть включён Guest Mode."),
  guestChatScreen: (p) =>
    `🕊 <b>${escapeHtml(p.title)}</b>\n\nЯ здесь не участник: вижу только сообщение, которым меня зовут, и то, на которое оно отвечает, и отвечаю одним сообщением.\n\n` +
    (p.others
      ? `⚠️ Меня могут звать и другие, до ${p.limit} раз в час. Им я помогаю только с тем, что любой мог бы сделать сам.`
      : "Считаются только твои вызовы."),
  guestHeld: (title, holder) =>
    `ℹ️ Ты позвал меня в «${escapeHtml(title)}», но этот чат привязан к ${holder}: там я отвечаю ему, а остальным — только если он разрешит.`,
  buttonGuestRelease: "🔌 Отвязать",
  guestReleased: "Отвязано. Следующий вызов привяжет чат заново.",
  guestNoAnswer: (title) =>
    `⚠️ Ты позвал меня в «${escapeHtml(title)}», но Telegram не дал мне там ответить. Проверь, что у бота в @BotFather включён Guest Mode, и попробуй ещё раз.`,
  startsButton: "📜 Запуски",
  startsScreen: (title, lines) =>
    `<b>${escapeHtml(title)}</b> — последние запуски, сначала новые (UTC):\n\n${lines.join("\n")}`,
  startsEmpty: (title) => `<b>${escapeHtml(title)}</b>: запусков пока не было.`,
  startsSession: "сессия",
  startsLimited: (n) => `😴 Ещё ${n} — придержаны лимитом за последние 24 часа.`,
  buttonRelay: (state) =>
    `🛰 Ретранслятор: ${{ none: "выкл", online: "онлайн ✅", offline: "офлайн ⚠️", login: "нужен вход ⚠️", noclaude: "служит Codex ⚠️" }[state]}`,
  relayScreen: (p) =>
    "🛰 <b>Ретранслятор</b>\n\nВ сессии Claude Code нельзя писать снаружи. Ретранслятор может: это твоя машина " +
    "с залогиненным Claude Code, которой я передаю сообщения. С ним реплай на сообщение сессии уходит в эту " +
    "сессию, а не запускает новую, и сессии могут спрашивать друг у друга, как дела. Без него всё работает " +
    "как раньше.\n\n" +
    {
      none: "Не настроен. Подойдёт любая всегда включённая машина с Linux (например, бесплатная ВМ Oracle): получи команду установки и выполни её там.",
      online: "✅ Онлайн.",
      offline: `⚠️ Офлайн${p.seen ? ` с ${p.seen}` : " — ещё ни разу не выходил на связь"}. Проверь машину: <code>systemctl status tg-relay</code>.`,
      login:
        "⚠️ Слетел вход в Claude. На машине: <code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>.",
      noclaude:
        "⚠️ Онлайн, но служит Codex. Ретранслятор служит одному ассистенту: выполни команду установки с этого экрана, чтобы он служил Claude.",
    }[p.state],
  buttonRelayInstall: "📋 Команда установки",
  buttonRelayOff: "Отключить",
  relayInstall: (command) =>
    "Выполни на машине (Linux с systemd; попросит sudo). Команда при необходимости поставит Claude Code и " +
    `запустит ретранслятор как сервис:\n<pre>${escapeHtml(command)}</pre>\nПотом один раз войди там в Claude Code: ` +
    "<code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>. В команде токен " +
    "ретранслятора. Ретранслятор служит одному ассистенту, и он у тебя один: новая команда отключает старый, в том числе у Codex.",
  relayOff: "Ретранслятор отключён.",
  relayLoginLost:
    "⚠️ У ретранслятора слетел вход в Claude, поэтому реплаи сессиям запускают новые сессии. На машине: <code>claude</code>, затем /login, затем <code>sudo systemctl restart tg-relay</code>.",
  relayWentOffline:
    "⚠️ Ретранслятор замолчал: сообщения сессиям не доходят, реплаи запускают новые сессии. Проверь машину: <code>systemctl status tg-relay</code>.",
  claudeHere: (on) => (on ? "💬 Здесь: вкл ✅" : "💬 Здесь: выкл"),
  claudeHereHint:
    "Здесь каждое сообщение идёт твоему ассистенту: сообщения чата за день уходят в одну сессию (с 00:00 UTC), а реплай на сообщение сессии — обратно в неё, если сессия может принимать сообщения (сессиям Claude для этого нужен 🛰 ретранслятор); иначе каждое сообщение запускает свою. В группах включается в 👥 Группы. Меня можно звать и из чатов, где меня нет, — тегом: см. 🕊 Гостевые чаты.",
  claudeToggle: (on) => (on ? "🤖 Ассистент отвечает: ✅" : "🤖 Ассистент отвечает: выкл"),
  othersToggle: (on) => (on ? "👥 Отвечать другим: ⚠️ вкл" : "👥 Отвечать другим: выкл"),
  groupClaude: (p) =>
    p.heldBy
      ? `\n\n🤖 Здесь отвечает ассистент ${p.heldBy}. Включить своего можно, когда он отключит.`
      : p.on
        ? `\n\n🤖 Упоминание меня или реплай на сообщение ассистента запускает твоего ассистента — для тебя` +
          (p.others ? `, и ⚠️ для всех остальных здесь — до ${p.limit} раз в час.` : ".")
        : "",
  chatHeld: "Здесь уже отвечает ассистент другого человека.",
  othersLimitButton: (limit) => `⏱ Другим: до ${limit}/ч`,
  limitPickerTitle: (subject, current) =>
    `⏱ <b>${escapeHtml(subject)}</b>\n\nСколько раз в час, не больше? Сейчас: ${current}. Выбери или впиши своё число (1–500).`,
  limitPickerCustom: "✏️ Другое число",
  limitPrompt: (subject) => `Пришли число от 1 до 500 для «${escapeHtml(subject)}».`,
  limitInvalid: "Нужно число от 1 до 500.",
  sceneDenied: "Сейчас нельзя.",
  sceneNotForYou: (name) => `Эта кнопка только для ${name}.`,
  sceneNoWake: "Ассистент не подключён — будить некого.",
  sceneResting: (minutes) => `Ассистент отдыхает, попробуй через ${minutes} мин.`,
  sceneTooFast: "Не так быстро.",
  sceneStale: "Кнопка устарела.",
  sceneOver: "Сцена завершена.",
  sceneFull: "Сцена заполнена: больше не помещается.",
  sceneFailed: "Не получилось, попробуй ещё раз.",
  sceneWakesLimited: (title, minutes) =>
    `😴 Сцена «${escapeHtml(title)}» исчерпала побудки на этот час; следующая сможет разбудить ассистента через ${minutes} мин (участники видят «Ассистент отдыхает»). Меняется в 🎬 Сценах.`,
  limitGone: "Этого уже нет: настраивать нечего.",
  buttonScenes: (n) => `🎬 Сцены (${n})`,
  scenesScreen: (title, lines) =>
    `🎬 <b>Сцены в «${escapeHtml(title)}»</b>\n\nСообщения, которые работают сами: кнопки, голосования, игры.\n\n` +
    (lines.length ? lines.join("\n") : "Ни одной не идёт."),
  sceneScreen: (p) =>
    `🎬 <b>${escapeHtml(p.title)}</b>\n\n` +
    (p.session
      ? `Побудки идут в ${sessionRef(p.session, "сессию")}.`
      : "Сессии за ней нет: побудка запускает ассистента, если он настроен, а иначе никого не будит.") +
    `\nСобытий в журнале: ${p.events}.\nПобудок за час: ${p.wakes} из ${p.limit}.`,
  buttonSceneWakes: (limit) => `⏱ Побудок: до ${limit}/ч`,
  buttonStopScene: "■ Остановить",
  sceneStopped: "Остановлена: кнопок больше нет.",
  buttonScenesHub: "🎬 Сцены",
  scenesHub: (lines, saved) =>
    "🎬 <b>Сцены</b>\n\nСообщения, которые работают сами: кнопки, голосования, игры. Их делает ассистент и хранит каждую в 📚 Сохранённых сценах: оттуда любую можно запустить в этом чате — подключён ассистент или нет.\n\n<b>Идут</b>\n" +
    (lines.length ? lines.join("\n") : "Ни одной не идёт.") +
    (saved ? "" : "\n\nСохранённых сцен пока нет: попроси ассистента сделать сцену."),
  buttonSavedScenes: (n) => `📚 Сохранённые сцены (${n})`,
  savedScenesScreen: (lines) =>
    `📚 <b>Сохранённые сцены</b>\n\nСначала недавние. Выбери, чтобы запустить в этом чате.\n\n${lines.join("\n")}`,
  savedSceneScreen: (p) =>
    `📄 <b>${escapeHtml(p.title)}</b>\n<code>${escapeHtml(p.name)}</code> · версия ${p.version} · запусков: ${p.uses}` +
    (p.brief ? `\n\n<i>${escapeHtml(p.brief)}</i>` : "") +
    "\n\nЗапустится в этом чате, от твоего имени. Кнопка, которая будит ассистента, запустит твоего, если он настроен; иначе сработает, никого не будя.",
  buttonStartScene: "▶ Запустить здесь",
  buttonDeleteSaved: "🗑 Удалить",
  confirmDeleteSaved: (name) =>
    `Удалить сохранённую сцену «${escapeHtml(name)}» вместе с прошлыми версиями? Запущенные из неё сцены продолжат идти.`,
  savedDeleted: "Удалена.",
  sceneStarted: "Запущена: она в этом чате.",
  sceneCannotStart:
    "Эту сохранённую сцену не запустить: она больше не проходит проверку. Попроси ассистента её исправить.",
  sceneStartRefused: "Telegram не принял сообщение. Попробуй позже.",
  scenesFull: (n) => `В этом чате уже идут ${n} сцен: сначала останови одну.`,
  sceneMenuGone: "Этого уже нет.",
  privateChatName: "личный чат",
  buttonPrev: "← Новее",
  buttonNext: "Старше →",
  othersLimited: (limit) =>
    `😴 Остальные участники исчерпали ${limit} запусков за час; их теги подождут, пока он пройдёт (они видят 😴). Лимит меняется в 👥 Группах.`,
  routineFirst: "Сначала настрой 🤖 Ассистента.",
  othersWarning: (title) =>
    `⚠️ Твой ассистент будет отвечать участникам «${escapeHtml(title)}». Он настроен не выполнять их просьбы и не делиться твоими данными, если память этого чата это не разрешает. Но это защита инструкциями, а не доступом: у сессии твои коннекторы, чаты и репозитории, и хитрое сообщение может её переубедить. Включай там, где доверяешь людям. Все запуски видны в 📜 Запусках здесь.`,
  buttonTurnOn: "Включить",
  privacyHint:
    "👁 Я здесь не админ, а privacy mode включён: вижу только упоминания и реплаи, так что ассистенту может не хватить контекста. Сделай меня админом, чтобы это исправить.",
  testPassed: (at) => `✅ Тестовый запуск в ${at} ответил: всё работает.`,
  testWaiting: (at) =>
    `⏳ Тест запущен в ${at}, ответа пока нет. Если не придёт — проверь, что у рутины есть коннектор Telegram.`,
  secretDropped: (deleted) =>
    (deleted
      ? "Это похоже на API-ключ, так что я удалил сообщение и ничего не сохранил."
      : "Это похоже на API-ключ, так что я ничего не сохранил.") +
    " Чтобы задать рутину, пришли id trig_… и токен вместе, одним сообщением.",
};

export function texts(languageCode: string | null | undefined): Texts {
  return languageCode?.toLowerCase().startsWith("ru") ? ru : en;
}

export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
