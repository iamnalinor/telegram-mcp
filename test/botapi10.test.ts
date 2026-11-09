import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { richText } from "../src/bot/extract";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const ELSEWHERE = { id: -1005550001111, title: "Friends", type: "supergroup" };
const BOT = "@test_mcp_bot";

const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
const SESSION = "01Svopn2AB4YoGuZVfSMUKGR";

let h: Harness;
let alice: string;

async function setUp(vars = {}) {
  h = new Harness(vars);
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
  h.fires.length = 0;
}

beforeEach(() => setUp());
afterEach(() => h.restore());

async function press(data: string) {
  await h.update({
    callback_query: {
      id: "q",
      from: { ...ALICE, is_bot: false },
      data,
      message: { message_id: 77, date: 1, chat: dm(ALICE) },
    },
  });
}

async function relayOnline(): Promise<string> {
  await press("m:rlnew");
  const text = String(h.telegram.called("sendMessage").at(-1)!.params.text);
  const token = /RELAY_TOKEN=(relay_[\w-]+)/.exec(text)![1];
  await poll(token);
  return token;
}
const poll = (token: string) =>
  h.fetch("/relay/jobs", { headers: { authorization: `Bearer ${token}` } });
const jobs = async (token: string) =>
  (await poll(token)).json<{ id: string; session: string; text: string }[]>();
const payload = () => h.fires.at(-1)!.body.text;
const age = (seconds: number) => h.db.raw.exec(`UPDATE fires SET at = at - ${seconds}`);
/** Each start gets a session of its own, as Anthropic's API gives. */
function distinctSessions() {
  let n = 0;
  h.fireAnswer = () => {
    const id = `01Session${String(++n).padStart(15, "0")}`;
    return Response.json({ claude_code_session_id: `cse_${id}` });
  };
}
const lastSent = () =>
  (
    h.db.raw
      .query("SELECT message_id FROM messages WHERE outgoing = 1 ORDER BY message_id DESC")
      .get() as { message_id: number }
  ).message_id;

describe("a group's sessions of the day", () => {
  beforeEach(async () => {
    await h.addBot(TEAM, ALICE);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    h.telegram.members.set(`${TEAM.id}:${BOB.id}`, "member");
    await press(`m:gc:${TEAM.id}`);
    distinctSessions();
  });

  it("takes the holder's tags of the day into one session, and a new one the next day", async () => {
    const token = await relayOnline();
    await h.say(TEAM, ALICE, `${BOT} fix the login page`);
    expect(h.fires).toHaveLength(1);

    await h.say(TEAM, ALICE, `${BOT} and the signup page`);
    expect(h.fires).toHaveLength(1);
    const [job] = await jobs(token);
    expect(job.session).toBe("session_01Session000000000000001");
    expect(job.text).toContain("A new message for you in a group");
    expect(job.text).toContain("the user (id 111)");

    age(86_400);
    await h.say(TEAM, ALICE, `${BOT} new day`);
    expect(h.fires).toHaveLength(2);
  });

  it("keeps other members in a session of their own", async () => {
    await press(`m:goy:${TEAM.id}`);
    const token = await relayOnline();
    await h.say(TEAM, ALICE, `${BOT} deploy it`);
    await h.say(TEAM, BOB, `${BOT} what is the deadline?`);
    // Bob's tag does not go into the session Alice works in.
    expect(h.fires).toHaveLength(2);
    expect(payload()).toContain("by: other");

    await h.say(TEAM, BOB, `${BOT} and who is on call?`);
    expect(h.fires).toHaveLength(2);
    const [job] = await jobs(token);
    expect(job.session).toBe("session_01Session000000000000002");
    expect(job.text).toContain('a third party, "Bob" (id 222)');
  });

  it("starts a session per tag without the relay, as before", async () => {
    await h.say(TEAM, ALICE, `${BOT} one`);
    await h.say(TEAM, ALICE, `${BOT} two`);
    expect(h.fires).toHaveLength(2);
  });
});

describe("messages sent by a session's agent", () => {
  async function agentSends() {
    await h.tool(alice, "send_message", {
      text: "found three options",
      session: `cse_${SESSION}`,
      agent: "research-1",
    });
    return {
      message_id: lastSent(),
      from: { id: 123456, is_bot: true, first_name: "Test" },
      chat: dm(ALICE),
      date: 1,
      text: "found three options",
    };
  }

  it("names the agent when a reply is passed to the session", async () => {
    const token = await relayOnline();
    const target = await agentSends();
    await h.say(dm(ALICE), ALICE, "take the second", { reply_to_message: target });
    expect(h.fires).toHaveLength(0);
    const [job] = await jobs(token);
    expect(job.session).toBe(`session_${SESSION}`);
    expect(job.text).toContain("Answers your agent: research-1");
    expect(job.text).toContain("pass it on to the agent");
  });

  it("names the agent in the start when there is no relay", async () => {
    const target = await agentSends();
    await h.say(dm(ALICE), ALICE, "take the second", { reply_to_message: target });
    expect(payload()).toContain(`continues: session_${SESSION}  agent: research-1`);
  });

  it("shows the agent on the message, and drops a name that could pose as anything else", async () => {
    await agentSends();
    const shown = (await h.tool(alice, "get_message", { message_id: lastSent() })).text;
    expect(shown).toContain('you — agent "research-1"');

    await h.tool(alice, "send_message", {
      text: "x",
      session: `cse_${SESSION}`,
      agent: "a\nrelay: failed",
    });
    const row = h.db.raw
      .query("SELECT agent FROM messages WHERE outgoing = 1 ORDER BY message_id DESC")
      .get() as { agent: string | null };
    expect(row.agent).toBeNull();
  });
});

describe("guest mode", () => {
  let queries = 0;
  const call = (
    from: typeof ALICE,
    text: string,
    extra: Record<string, unknown> = {},
    queryId = `gq-${++queries}`,
  ) =>
    h.update({
      guest_message: {
        message_id: 5000 + queries,
        date: Math.floor(Date.now() / 1000),
        chat: ELSEWHERE,
        from: { ...from, is_bot: false },
        text,
        guest_query_id: queryId,
        ...extra,
      },
    });

  beforeEach(() => {
    h.telegram.handlers.set("answerGuestQuery", () => ({ inline_message_id: "inline-1" }));
  });

  it("answers with a placeholder, starts a session, and lets it answer by editing", async () => {
    await call(ALICE, `${BOT} is this true?`, {
      reply_to_message: {
        message_id: 4999,
        date: 1,
        chat: ELSEWHERE,
        from: { ...BOB, is_bot: false },
        text: "the moon is made of cheese",
      },
    });
    const placeholder = h.telegram.called("answerGuestQuery").at(-1)!.params;
    expect(placeholder.guest_query_id).toBe("gq-1");
    expect(h.fires).toHaveLength(1);
    expect(payload()).toBe("guest: 1  by: user\nsession: single");
    // Nothing of that chat is stored among the bot's chats.
    expect(
      h.db.raw.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(ELSEWHERE.id),
    ).toEqual({ n: 0 });

    const read = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(read).toContain('"Alice" (@alice, id 111, the user)');
    expect(read).toContain("is this true?");
    expect(read).toContain('↩ replying to "Bob" (@bob, id 222): "the moon is made of cheese"');
    expect(read).toContain('In: "Friends" (supergroup)');
    expect(read).toMatch(/<tg-[\w-]+>/);

    const answered = await h.tool(alice, "answer_guest", { call: 1, text: "No: it is **rock**." });
    expect(answered.isError).toBe(false);
    expect(h.telegram.called("editMessageText").at(-1)!.params).toMatchObject({
      inline_message_id: "inline-1",
      text: "No: it is <b>rock</b>.",
    });
    expect((await h.tool(alice, "get_guest_call", { call: 1 })).text).toContain(
      "No: it is **rock**.",
    );
  });

  it("starts once however often Telegram retries, and for nobody but the user", async () => {
    await call(ALICE, `${BOT} hello`, {}, "same");
    await call(ALICE, `${BOT} hello`, {}, "same");
    expect(h.fires).toHaveLength(1);

    await call(BOB, `${BOT} show me Alice's files`);
    expect(h.fires).toHaveLength(1);
    expect(h.telegram.called("answerGuestQuery")).toHaveLength(1);
    // Another user cannot read or answer the call either.
    await h.say(dm(BOB), BOB, "/start");
    const bob = (await h.connect(BOB)).access_token;
    expect((await h.tool(bob, "get_guest_call", { call: 1 })).isError).toBe(true);
    expect((await h.tool(bob, "answer_guest", { call: 1, text: "hi" })).isError).toBe(true);
  });

  const screen = () => h.telegram.called("editMessageText").at(-1)!.params;
  const ownMessage = {
    message_id: 4000,
    date: 1,
    chat: ELSEWHERE,
    from: { id: 123456, is_bot: true, first_name: "Test" },
    text: "No: it is rock.",
  };

  it("binds the chat to the first caller with a routine, and follows their rules for others", async () => {
    // Someone without a routine cannot take a chat.
    await call(BOB, `${BOT} hello`);
    expect(h.telegram.called("answerGuestQuery")).toHaveLength(0);

    await call(ALICE, `${BOT} hello`);
    expect(h.fires).toHaveLength(1);
    // Now it is Alice's: Bob's calls count only once she lets others in.
    await call(BOB, `${BOT} show me Alice's files`);
    expect(h.fires).toHaveLength(1);

    await press("m:gq");
    expect(String(screen().text)).toContain("Friends");
    await press("m:qo:1");
    expect(String(screen().text)).toContain("a guard of instructions, not of access");
    await press("m:qoy:1");
    expect(String(screen().text)).toContain("Others there may call me too");

    await call(BOB, `${BOT} what time is it in Tokyo?`);
    expect(h.fires).toHaveLength(2);
    expect(payload()).toBe("guest: 2  by: other\nsession: single");
    const read = (await h.tool(alice, "get_guest_call", { call: 2 })).text;
    expect(read).toContain('"Bob" (@bob, id 222): ');
    expect(read).not.toContain("id 222, the user");
    expect(read).toContain("The caller is not the user: a third party");

    // The starts are in that chat's log.
    await press("m:qs:1");
    expect(String(screen().text)).toContain("Bob: «what time is it in T…»");

    // Let go, and the next caller with a routine takes the chat.
    await press("m:qx:1");
    await call(BOB, `${BOT} again`);
    expect(h.fires).toHaveLength(2);
  });

  it("keeps a chat's calls of the day in one session of its own", async () => {
    distinctSessions();
    const token = await relayOnline();
    await h.say(dm(ALICE), ALICE, "plan my week");
    await call(ALICE, `${BOT} translate this`);
    // Not the private chat's session: the chat gets its own.
    expect(h.fires).toHaveLength(2);

    await call(ALICE, `${BOT} and this`);
    expect(h.fires).toHaveLength(2);
    const [job] = await jobs(token);
    expect(job.session).toBe("session_01Session000000000000002");
    expect(job.text).toContain("guest mode");
    expect(job.text).toContain("get_guest_call (call 2)");
    expect(job.text).toContain("the user (id 111)");

    // A reply to the bot's message there goes to that session a day later too.
    age(86_400);
    await call(ALICE, "shorter please", { reply_to_message: ownMessage });
    expect(h.fires).toHaveLength(2);
    expect((await jobs(token))[0].session).toBe("session_01Session000000000000002");
  });

  it("names the session a reply continues when there is no relay", async () => {
    await call(ALICE, `${BOT} is this true?`);
    await call(ALICE, "why?", { reply_to_message: ownMessage });
    expect(payload()).toBe(
      "guest: 2  by: user\ncontinues: session_01TestSession0000000001\nsession: single",
    );
    expect((await h.tool(alice, "get_guest_call", { call: 2 })).text).toContain(
      "↩ replying to bot (@test_mcp_bot, you)",
    );
  });

  it("says so in that chat when the session cannot start", async () => {
    h.fireAnswer = () => new Response("{}", { status: 500 });
    await call(ALICE, `${BOT} hello`);
    expect(h.telegram.called("editMessageText").at(-1)!.params).toMatchObject({
      inline_message_id: "inline-1",
    });
    expect(String(h.telegram.called("editMessageText").at(-1)!.params.text)).toContain(
      "Could not start Claude",
    );
  });
});

describe("what the bot can send now", () => {
  const sent = (extra: Record<string, unknown> = {}) => ({
    message_id: 3000,
    date: Math.floor(Date.now() / 1000),
    chat: dm(ALICE),
    from: { id: 123456, is_bot: true, first_name: "Test" },
    ...extra,
  });

  it("sends a rich message whole, and falls back to text where Telegram cannot parse it", async () => {
    h.telegram.handlers.set("sendRichMessage", () =>
      sent({ rich_message: { blocks: [{ type: "paragraph", text: "x" }] } }),
    );
    const table = "# Plans\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const result = await h.tool(alice, "send_message", { text: table, format: "rich" });
    expect(result.isError).toBe(false);
    expect(h.telegram.called("sendRichMessage").at(-1)!.params.rich_message).toEqual({
      markdown: table,
    });
    // Stored as written, so a later read shows what was sent.
    expect((await h.tool(alice, "get_message", { message_id: 3000 })).text).toContain("# Plans");

    h.telegram.handlers.delete("sendRichMessage");
    const refused = await h.tool(alice, "send_message", { text: table, format: "rich" });
    expect(refused.isError).toBe(true);
  });

  it("colours buttons and keeps the colour when the text is edited", async () => {
    await h.tool(alice, "send_message", {
      text: "Deploy?",
      buttons: [
        [
          { text: "Deploy", style: "success" },
          { text: "Drop the database", style: "danger" },
        ],
      ],
    });
    const markup = h.telegram.called("sendMessage").at(-1)!.params.reply_markup as {
      inline_keyboard: { text: string; style?: string }[][];
    };
    expect(markup.inline_keyboard[0].map((b) => b.style)).toEqual(["success", "danger"]);

    await h.tool(alice, "edit_message", { message_id: lastSent(), text: "Deploy now?" });
    const edited = h.telegram.called("editMessageText").at(-1)!.params.reply_markup as {
      inline_keyboard: { style?: string }[][];
    };
    expect(edited.inline_keyboard[0][1].style).toBe("danger");
  });

  it("shows a message to one member only, in a group, without storing it", async () => {
    await h.addBot(TEAM, ALICE);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    h.telegram.handlers.set("sendMessage", (params) => ({
      ephemeral_message_id: 1,
      date: 1,
      chat: { id: Number(params.chat_id), type: "supergroup" },
    }));
    const before = h.db.raw.query("SELECT COUNT(*) AS n FROM messages").get();
    const result = await h.tool(alice, "send_message", {
      chat: TEAM.id,
      text: "not for you, sorry",
      only_for: BOB.id,
    });
    expect(result.text).toContain("to member 222 only");
    expect(h.telegram.called("sendMessage").at(-1)!.params.ephemeral_message_parameters).toEqual({
      receiver_user_id: BOB.id,
    });
    expect(h.db.raw.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual(before);

    const inDm = await h.tool(alice, "send_message", { text: "x", only_for: BOB.id });
    expect(inDm.isError).toBe(true);
  });

  it("makes a quiz of a poll with correct options", async () => {
    await h.tool(alice, "send_poll", {
      question: "2 + 2?",
      options: ["3", "4", "four"],
      correct_options: [2, 1],
      explanation: "Count again",
      hide_results: true,
    });
    expect(h.telegram.called("sendPoll").at(-1)!.params).toMatchObject({
      type: "quiz",
      correct_option_ids: [1, 2],
      allows_multiple_answers: true,
      explanation: "Count again",
      hide_results_until_closes: true,
    });
    const wrong = await h.tool(alice, "send_poll", {
      question: "?",
      options: ["a"],
      correct_options: [3],
    });
    expect(wrong.isError).toBe(true);
  });

  it("shows a draft in the private chat", async () => {
    h.telegram.handlers.set("sendMessageDraft", () => true);
    await h.tool(alice, "send_draft", { text: "Looking **into** it" });
    expect(h.telegram.called("sendMessageDraft").at(-1)!.params).toMatchObject({
      chat_id: ALICE.id,
      draft_id: 1,
      text: "Looking <b>into</b> it",
    });
    await h.tool(alice, "send_draft", {});
    expect(h.telegram.called("sendMessageDraft").at(-1)!.params.text).toBe("");
  });

  it("sends a widget, records its taps as presses, and changes its state", async () => {
    h.telegram.handlers.set("sendWidget", () => sent({ message_id: 3100, widget: {} }));
    h.telegram.handlers.set("editMessageWidgetData", () => true);
    const html = "<button onclick=\"TelegramWidget.request('inc')\">+1</button>";
    const result = await h.tool(alice, "send_widget", { html, state: '{"n":0}', taps: true });
    expect(result.isError).toBe(false);
    expect(h.telegram.called("sendWidget").at(-1)!.params).toMatchObject({
      chat_id: ALICE.id,
      html,
      chat_data: '{"n":0}',
      allow_queries: true,
    });

    const tap = async (id: string, data: string, message = 3100) => {
      const response = await h.update({
        widget_query: {
          id,
          from: { ...ALICE, is_bot: false },
          chat: dm(ALICE),
          message_id: message,
          data,
        },
      });
      return response.json<{ method: string; data: string }>();
    };
    // The widget waits 15 s at most: the bot answers by itself.
    expect(await tap("w1", "inc")).toMatchObject({ method: "answerWidgetQuery", data: "ok" });
    await tap("w2", "dec");
    // A tap on a message the bot never sent is not recorded.
    expect((await tap("w3", "inc", 9999)).data).toBe("unknown");

    const first = await h.tool(alice, "wait_for_reply", { message_id: 3100, wait_seconds: 1 });
    expect(first.text).toContain('pressed "inc"');
    expect(first.text).toContain("after_press: 1");
    const second = await h.tool(alice, "wait_for_reply", {
      message_id: 3100,
      wait_seconds: 1,
      after_press: 1,
    });
    expect(second.text).toContain('pressed "dec"');
    const none = await h.tool(alice, "wait_for_reply", {
      message_id: 3100,
      wait_seconds: 1,
      after_press: 2,
    });
    expect(none.text).toContain("No answer");

    await h.tool(alice, "set_widget_state", { message_id: 3100, state: '{"n":1}' });
    expect(h.telegram.called("editMessageWidgetData").at(-1)!.params).toEqual({
      chat_id: ALICE.id,
      message_id: 3100,
      chat_data: '{"n":1}',
    });
    await h.tool(alice, "send_message", { text: "plain" });
    const plain = h.db.raw.query("SELECT message_id FROM messages WHERE text = 'plain'").get() as {
      message_id: number;
    };
    const notWidget = await h.tool(alice, "set_widget_state", {
      message_id: plain.message_id,
      state: "",
    });
    expect(notWidget.isError).toBe(true);
  });
});

describe("what the bot reads now", () => {
  it("reads a rich message as text", async () => {
    expect(
      richText([
        { type: "section_heading", text: "Title" },
        { type: "paragraph", text: ["Hello ", { type: "bold", text: "world" }, "!"] },
        { type: "table", cells: [[{ text: "a" }, { text: "b" }]] },
        {
          type: "list",
          items: [{ label: "1.", blocks: [{ type: "paragraph", text: "one" }] }],
        },
      ]),
    ).toBe("Title\nHello world!\na | b\n1. one");

    await h.say(dm(ALICE), ALICE, "", {
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "the quarterly numbers" }] },
    });
    expect(h.fires).toHaveLength(1);
    const found = await h.tool(alice, "search_messages", { query: "quarterly" });
    expect(found.text).toContain("the quarterly numbers");
  });

  it("takes a tag by the bot's other username", async () => {
    h.restore();
    await setUp({ BOT_USERNAMES: "@ClaudeAgent, x" });
    await h.addBot(TEAM, ALICE);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    await press(`m:gc:${TEAM.id}`);
    await h.say(TEAM, ALICE, "@someoneelse look");
    expect(h.fires).toHaveLength(0);
    await h.say(TEAM, ALICE, "@claudeagent fix the login page");
    expect(h.fires).toHaveLength(1);
    const log = h.db.raw.query("SELECT excerpt FROM fires").get() as { excerpt: string };
    expect(log.excerpt).toBe("fix the login page");
  });
});

describe("what the review found", () => {
  beforeEach(async () => {
    await h.addBot(TEAM, ALICE);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    h.telegram.members.set(`${TEAM.id}:${BOB.id}`, "member");
    await press(`m:gc:${TEAM.id}`);
    await press(`m:goy:${TEAM.id}`);
    distinctSessions();
  });

  it("does not make the holder's session the others' after one reply of theirs", async () => {
    const token = await relayOnline();
    await h.say(TEAM, ALICE, `${BOT} deploy it`);
    await h.tool(alice, "send_message", {
      chat: TEAM.id,
      text: "deployed",
      session: "cse_01Session000000000000001",
    });
    const target = {
      message_id: lastSent(),
      from: { id: 123456, is_bot: true, first_name: "Test" },
      chat: TEAM,
      date: 1,
      text: "deployed",
    };
    // Bob's reply goes into the session that wrote the message…
    await h.say(TEAM, BOB, "thanks", { reply_to_message: target });
    expect(h.fires).toHaveLength(1);
    expect((await jobs(token))[0].session).toBe("session_01Session000000000000001");
    // …but his next tag starts the others' own session.
    await h.say(TEAM, BOB, `${BOT} what is the deadline?`);
    expect(h.fires).toHaveLength(2);
    expect(payload()).toContain("by: other");
  });

  it("lets the user's messages through while a session waits for the next press", async () => {
    h.telegram.handlers.set("sendWidget", () => ({
      message_id: 3200,
      date: Math.floor(Date.now() / 1000),
      chat: dm(ALICE),
      from: { id: 123456, is_bot: true, first_name: "Test" },
      widget: {},
    }));
    await h.tool(alice, "send_widget", { html: "<b>x</b>", taps: true, session: `cse_${SESSION}` });
    await h.tool(alice, "wait_for_reply", { message_id: 3200, wait_seconds: 1, after_press: 1 });
    await h.say(dm(ALICE), ALICE, "something else entirely");
    expect(h.fires).toHaveLength(1);
  });

  it("keeps no key from the message a guest call replies to", async () => {
    h.telegram.handlers.set("answerGuestQuery", () => ({ inline_message_id: "inline-9" }));
    await h.update({
      guest_message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: ELSEWHERE,
        from: { ...ALICE, is_bot: false },
        text: `${BOT} is this key still valid?`,
        guest_query_id: "gq-secret",
        reply_to_message: {
          message_id: 2,
          date: 1,
          chat: ELSEWHERE,
          from: { ...BOB, is_bot: false },
          text: `use ${TOKEN}`,
        },
      },
    });
    const row = h.db.raw.query("SELECT reply FROM guest_calls").get() as { reply: string };
    expect(row.reply).not.toContain(TOKEN);
  });

  it("tells the user in private when Telegram takes no answer for a guest call", async () => {
    await h.update({
      guest_message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: ELSEWHERE,
        from: { ...ALICE, is_bot: false },
        text: `${BOT} hello`,
        guest_query_id: "gq-refused",
      },
    });
    expect(h.fires).toHaveLength(0);
    const told = h.telegram.called("sendMessage").at(-1)!.params;
    expect(told.chat_id).toBe(ALICE.id);
    expect(String(told.text)).toContain("Guest Mode");
  });
});

describe("what the second review found", () => {
  const guest = (
    from: typeof ALICE,
    queryId: string,
    extra: Record<string, unknown> = {},
    chat: Record<string, unknown> = ELSEWHERE,
  ) =>
    h.update({
      guest_message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat,
        from: { ...from, is_bot: false },
        text: `${BOT} hello`,
        guest_query_id: queryId,
        ...extra,
      },
    });

  beforeEach(() => {
    h.telegram.handlers.set("answerGuestQuery", () => ({ inline_message_id: "inline-1" }));
  });

  it("takes no forward and no inline bot's text for a call", async () => {
    await guest(ALICE, "f1", {
      forward_origin: { type: "hidden_user", sender_user_name: "Mallory", date: 1 },
    });
    await guest(ALICE, "f2", { via_bot: { id: 5, is_bot: true, first_name: "Gif" } });
    expect(h.fires).toHaveLength(0);
    expect(h.telegram.called("answerGuestQuery")).toHaveLength(0);
  });

  it("keeps two people's private chats with the same person apart", async () => {
    await h.say(dm(BOB), BOB, "/start");
    await h.connect(BOB);
    await h.say(dm(BOB), BOB, `${TRIGGER} ${TOKEN}`);
    h.fires.length = 0;
    const xavier = { id: 333, type: "private", first_name: "Xavier" };
    await guest(BOB, "p1", {}, xavier);
    await guest(ALICE, "p2", {}, xavier);
    // Each is answered by their own routine, as the user.
    expect(h.fires).toHaveLength(2);
    expect(h.fires.map((fire) => fire.body.text.split("\n")[0])).toEqual([
      "guest: 1  by: user",
      "guest: 2  by: user",
    ]);
    const read = (await h.tool(alice, "get_guest_call", { call: 2 })).text;
    expect(read).toContain('In: "Xavier" (private)');
  });

  it("tells someone who could have taken the chat that it is held, once", async () => {
    await h.say(dm(BOB), BOB, "/start");
    await h.connect(BOB);
    await h.say(dm(BOB), BOB, `${TRIGGER} ${TOKEN}`);
    await guest(ALICE, "h1");
    h.fires.length = 0;
    const toBob = () =>
      h.telegram
        .called("sendMessage")
        .filter((c) => c.params.chat_id === BOB.id && String(c.params.text).includes("Friends"));
    await guest(BOB, "h2");
    await guest(BOB, "h3");
    expect(h.fires).toHaveLength(0);
    expect(toBob()).toHaveLength(1);
    expect(String(toBob()[0].params.text)).toContain("connected to @alice");
  });

  it("posts nothing in the chat past the limit", async () => {
    await guest(ALICE, "l0");
    await press("m:qoy:1");
    for (let i = 0; i < 25; i++) await guest(BOB, `l${i + 1}`);
    // One for Alice, twenty for Bob: the rest get no placeholder.
    expect(h.telegram.called("answerGuestQuery")).toHaveLength(21);
  });

  it("still tells the model about personal chats", async () => {
    const { instructions } = await import("../src/prompts");
    const text = instructions({
      retentionDays: 14,
      botUsername: "b",
      user: { id: 1, username: null, name: null },
    });
    expect(text).toContain("\nPersonal chats\n");
    expect(text).toContain("Anything you send there goes out as the user");
  });
});
