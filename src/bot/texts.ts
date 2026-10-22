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
