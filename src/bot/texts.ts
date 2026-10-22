/**
 * What the bot says, in English and Russian, picked by the sender's Telegram
 * language. Telegram HTML: only <b>, <i>, <code>, <a> are used, and every
 * interpolated value goes through `escapeHtml`.
 */

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const en = {
  notAllowed: (id: number) =>
    `This bot is private. Your Telegram ID is <code>${id}</code> — ask its owner to add it to <code>ALLOWED_USER_IDS</code>.`,
  start: (p: { id: number; retention: number; privacyOn: boolean }) =>
    [
      "Hi! I connect your AI assistant (Claude, ChatGPT, Codex) to Telegram: it can message you here, send files, ask you questions with buttons, and read what you send me or what is said in groups you connect.",
      "",
      `Your Telegram ID: <code>${p.id}</code>`,
      "",
      "<b>Commands</b>",
      "/connect — give your assistant access to a group (or send /connect in the group itself)",
      "/groups — see and revoke group access",
      "/disconnect — sign out every connected assistant",
      "",
      "<b>Personal chats</b>: to let your assistant read your own chats with other people, add me in Settings → Telegram Business → Chatbots. Whether it may also reply for you is up to the permissions you give me there.",
      "",
      `I keep messages for ${p.retention} days and only see chats I am in.` +
        (p.privacyOn
          ? " Privacy mode is on, so in groups I only see commands, mentions and replies to me — turn it off in @BotFather (/setprivacy) and re-add me to see everything."
          : ""),
    ].join("\n"),
  pickGroup: "Pick the group to connect. I must already be a member there.",
  connectFirst:
    "Connect your AI assistant to this bot first (add it as a connector in Claude or ChatGPT and sign in with Telegram), then link groups.",
  leavingNotConnected: (name: string) =>
    `${escapeHtml(name)}, connect your AI assistant to this bot first, then add me again. Leaving for now.`,
  pickButton: "Choose a group",
  cannotResolve: (what: string) =>
    `I can't find ${escapeHtml(what)}. Use the button, or send a public @username. Invite links can't be resolved by bots.`,
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
  noGroups:
    "No groups connected. Add me to a group, or send /connect here or in a group I'm already in.",
  groupsHeader: "<b>Connected groups</b>",
  groupLine: (p: { title: string; full: boolean; since: string }) =>
    `• <b>${escapeHtml(p.title)}</b> — ${p.full ? "full stored history" : `from ${p.since}`}`,
  revokeButton: (title: string) => `Revoke ${title}`,
  revoked: "Access revoked.",
  notYours: "Nothing to revoke.",
  disconnected:
    "Done — every assistant signed in with your account is disconnected. Connect again from your assistant's settings when you want.",
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
};

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
  start: (p) =>
    [
      "Привет! Я связываю твоего AI-ассистента (Claude, ChatGPT, Codex) с Telegram: он может писать тебе сюда, присылать файлы, задавать вопросы с кнопками и читать, что ты мне пишешь или что пишут в подключённых группах.",
      "",
      `Твой Telegram ID: <code>${p.id}</code>`,
      "",
      "<b>Команды</b>",
      "/connect — дать ассистенту доступ к группе (или отправь /connect в самой группе)",
      "/groups — посмотреть и отозвать доступ к группам",
      "/disconnect — отключить все подключённые ассистенты",
      "",
      "<b>Личные переписки</b>: чтобы ассистент читал твои переписки с другими людьми, добавь меня в Настройки → Telegram для бизнеса → Чат-боты. Может ли он ещё и отвечать за тебя — решают права, которые ты дашь мне там.",
      "",
      `Храню сообщения ${p.retention} дней и вижу только чаты, где я есть.` +
        (p.privacyOn
          ? " Включён privacy mode: в группах я вижу только команды, упоминания и ответы мне — выключи его в @BotFather (/setprivacy) и добавь меня заново, чтобы видеть всё."
          : ""),
    ].join("\n"),
  pickGroup: "Выбери группу. Я уже должен в ней состоять.",
  connectFirst:
    "Сначала подключи AI-ассистента к этому боту (добавь коннектор в Claude или ChatGPT и войди через Telegram), потом привязывай группы.",
  leavingNotConnected: (name) =>
    `${escapeHtml(name)}, сначала подключи AI-ассистента к этому боту, потом добавь меня снова. Пока выхожу.`,
  pickButton: "Выбрать группу",
  cannotResolve: (what) =>
    `Не нахожу ${escapeHtml(what)}. Нажми кнопку или пришли публичный @username — инвайт-ссылки боты открыть не могут.`,
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
    "Нет подключённых групп. Добавь меня в группу или отправь /connect здесь или в группе, где я уже есть.",
  groupsHeader: "<b>Подключённые группы</b>",
  groupLine: (p) =>
    `• <b>${escapeHtml(p.title)}</b> — ${p.full ? "вся сохранённая история" : `с ${p.since}`}`,
  revokeButton: (title) => `Отозвать ${title}`,
  revoked: "Доступ отозван.",
  notYours: "Нечего отзывать.",
  disconnected:
    "Готово — все ассистенты, подключённые под твоим аккаунтом, отключены. Подключиться снова можно в настройках ассистента.",
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
};

export function texts(languageCode: string | null | undefined): Texts {
  return languageCode?.toLowerCase().startsWith("ru") ? ru : en;
}

export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
