import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { resetBotIdentity } from "../src/telegram/api";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const BOT = "@test_mcp_bot";

const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
const SESSION = "01Svopn2AB4YoGuZVfSMUKGR";

let h: Harness;
let alice: string;

async function signIn(user: typeof ALICE) {
  await h.say(dm(user), user, "/start");
  const token = (await h.connect(user)).access_token;
  await h.say(dm(user), user, `${TRIGGER} ${TOKEN}`);
  return token;
}

beforeEach(async () => {
  h = new Harness();
  alice = await signIn(ALICE);
  h.fires.length = 0;
});
afterEach(() => h.restore());

async function press(user: typeof ALICE, data: string) {
  await h.update({
    callback_query: {
      id: "q",
      from: { ...user, is_bot: false },
      data,
      message: { message_id: 77, date: 1, chat: dm(user) },
    },
  });
  return h.telegram.called("editMessageText").at(-1)?.params;
}

const payload = () => h.fires.at(-1)!.body.text;
const lastTo = (chatId: number) =>
  h.telegram
    .called("sendMessage")
    .filter((call) => call.params.chat_id === chatId)
    .map((call) => String(call.params.text))
    .at(-1);

describe("in the private chat", () => {
  it("starts on /claude, an explicit mention or a reply to the assistant — not on plain messages", async () => {
    await h.say(dm(ALICE), ALICE, "just a file for later");
    expect(h.fires).toHaveLength(0);

    const asked = await h.say(dm(ALICE), ALICE, "/claude check the build");
    expect(h.fires).toHaveLength(1);
    expect(payload()).toContain(`chat: ${ALICE.id}`);
    expect(payload()).toContain(`message: ${String(asked.message_id)}`);
    expect(payload()).toContain("by: user");
    expect(h.telegram.called("setMessageReaction").at(-1)!.params).toMatchObject({
      chat_id: ALICE.id,
      message_id: asked.message_id,
    });
    expect(lastTo(ALICE.id)).toContain("Claude is on it");

    await h.say(dm(ALICE), ALICE, `${BOT} and the tests`);
    expect(h.fires).toHaveLength(2);
  });

  it("explains /claude without a task", async () => {
    await h.say(dm(ALICE), ALICE, "/claude");
    expect(h.fires).toHaveLength(0);
    expect(lastTo(ALICE.id)).toContain("Write the task after /claude");
  });

  it("starts once per message, however often Telegram retries it", async () => {
    const message = {
      message_id: 900,
      date: Math.floor(Date.now() / 1000),
      chat: { ...dm(ALICE), first_name: "Alice" },
      from: { ...ALICE, is_bot: false },
      text: "/claude once",
    };
    await h.update({ message });
    await h.update({ message });
    expect(h.fires).toHaveLength(1);
  });

  it("hands a reply on to the session that sent the message, unless it is waiting for it", async () => {
    await h.tool(alice, "send_message", { text: "build is green", session: `cse_${SESSION}` });
    const sent = h.db.raw
      .query("SELECT message_id FROM messages WHERE outgoing = 1 ORDER BY message_id DESC")
      .get() as { message_id: number };
    const reply = {
      message_id: sent.message_id,
      from: { id: 123456, is_bot: true, first_name: "Test" },
      chat: dm(ALICE),
      date: 1,
      text: "build is green",
    };
    await h.say(dm(ALICE), ALICE, "now deploy it", { reply_to_message: reply });
    expect(h.fires).toHaveLength(1);
    expect(payload()).toContain(`continues: session_${SESSION}`);

    // A session waiting on its question takes the reply itself.
    h.db.raw.exec(
      `UPDATE messages SET awaited_until = ${Math.floor(Date.now() / 1000) + 30} WHERE message_id = ${sent.message_id}`,
    );
    await h.say(dm(ALICE), ALICE, "yes", { reply_to_message: reply });
    expect(h.fires).toHaveLength(1);
  });

  it("does nothing for a forward, or once turned off", async () => {
    await h.say(dm(ALICE), ALICE, `/claude ${BOT} look`, {
      forward_origin: { type: "hidden_user", sender_user_name: "Eve", date: 1 },
    });
    expect(h.fires).toHaveLength(0);
    await press(ALICE, "m:cldm");
    await h.say(dm(ALICE), ALICE, "/claude look");
    expect(h.fires).toHaveLength(0);
    await press(ALICE, "m:cldm");
    await h.say(dm(ALICE), ALICE, "/claude look");
    expect(h.fires).toHaveLength(1);
  });

  it("tells the user, not the chat, why it could not start", async () => {
    h.fireAnswer = () => new Response("{}", { status: 401 });
    await h.say(dm(ALICE), ALICE, "/claude look");
    expect(lastTo(ALICE.id)).toContain("token was refused");
    expect(h.telegram.called("setMessageReaction")).toHaveLength(0);
  });
});

describe("the routine screen", () => {
  it("tells whether the test session answered", async () => {
    let screen = await press(ALICE, "m:cl");
    expect(String(screen!.text)).toContain("no answer yet");
    await h.tool(alice, "send_message", { text: "ok", session: "cse_01TestSession0000000001" });
    screen = await press(ALICE, "m:cl");
    expect(String(screen!.text)).toContain("it works");
  });

  it("forgets the old test when the routine is set again", async () => {
    await h.tool(alice, "send_message", { text: "ok", session: "cse_01TestSession0000000001" });
    // Within the minute, the new routine's test start is held back: no status rather than a stale one.
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    const screen = await press(ALICE, "m:cl");
    expect(String(screen!.text)).not.toContain("it works");
    expect(String(screen!.text)).not.toContain("no answer yet");
  });
});

describe("in a group", () => {
  beforeEach(async () => {
    await h.addBot(TEAM, ALICE);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    await press(ALICE, `m:gc:${TEAM.id}`);
  });

  it("starts for the holder's mention and reply, and tells them quietly", async () => {
    await h.say(TEAM, ALICE, "lunch?");
    expect(h.fires).toHaveLength(0);
    await h.say(TEAM, ALICE, `${BOT} fix the login page`);
    expect(h.fires).toHaveLength(1);
    expect(payload()).toContain(`chat: ${TEAM.id}`);
    const notice = h.telegram.called("sendMessage").at(-1)!.params;
    expect(notice.chat_id).toBe(ALICE.id);
    expect(notice.disable_notification).toBe(true);
    expect(String(notice.text)).toContain(
      "Claude started in «Team chat»: «@test_mcp_bot fix the login page»",
    );
  });

  it("ignores other members until the holder lets them in, then limits them", async () => {
    h.telegram.members.set(`${TEAM.id}:${BOB.id}`, "member");
    await h.say(TEAM, BOB, `${BOT} delete everything`);
    expect(h.fires).toHaveLength(0);

    const warning = await press(ALICE, `m:go:${TEAM.id}`);
    expect(String(warning!.text)).toContain("a guard of instructions, not of access");
    expect(
      (h.db.raw.query("SELECT others FROM claude_chats").get() as { others: number }).others,
    ).toBe(0);
    await press(ALICE, `m:goy:${TEAM.id}`);

    await h.say(TEAM, BOB, `${BOT} what is our deadline?`);
    expect(h.fires).toHaveLength(1);
    expect(payload()).toContain("by: other");
    expect(lastTo(ALICE.id)).toContain("for Bob");

    for (let i = 0; i < 6; i++) await h.say(TEAM, BOB, `${BOT} again ${i}`);
    expect(h.fires).toHaveLength(5);
  });

  it("keeps the chat for whoever turned it on first, until they leave", async () => {
    await signIn(BOB);
    h.telegram.members.set(`${TEAM.id}:${BOB.id}`, "member");
    await h.say(TEAM, BOB, "/connect@test_mcp_bot");
    h.fires.length = 0;

    const held = await press(BOB, `m:g:${TEAM.id}`);
    expect(String(held!.text)).toContain("Claude answers here for @alice");
    await press(BOB, `m:gc:${TEAM.id}`);
    const claim = () =>
      (
        h.db.raw.query("SELECT user_id FROM claude_chats WHERE chat_id = ?").get(TEAM.id) as {
          user_id: number;
        } | null
      )?.user_id;
    expect(claim()).toBe(ALICE.id);

    // Alice's tag counts as someone else's for Bob: nothing, as he has not turned it on.
    await h.say(TEAM, BOB, `${BOT} hi`);
    expect(h.fires).toHaveLength(0);

    // Telegram now says Alice is gone: the chat passes to Bob when he asks.
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "left");
    await press(BOB, `m:gc:${TEAM.id}`);
    expect(claim()).toBe(BOB.id);
  });

  it("lets go when the holder leaves, revokes the group or turns it off", async () => {
    const claims = () =>
      (
        h.db.raw.query("SELECT COUNT(*) AS n FROM claude_chats WHERE chat_id < 0").get() as {
          n: number;
        }
      ).n;
    await press(ALICE, `m:gc:${TEAM.id}`);
    expect(claims()).toBe(0);
    await press(ALICE, `m:gc:${TEAM.id}`);
    expect(claims()).toBe(1);
    await h.update({
      message: {
        message_id: 5000,
        date: Math.floor(Date.now() / 1000),
        chat: TEAM,
        from: { ...ALICE, is_bot: false },
        left_chat_member: { ...ALICE, is_bot: false },
      },
    });
    expect(claims()).toBe(0);
  });

  it("a burst of others' tags still starts five, and their failures reach the holder once", async () => {
    h.telegram.members.set(`${TEAM.id}:${BOB.id}`, "member");
    await press(ALICE, `m:goy:${TEAM.id}`);
    await Promise.all(Array.from({ length: 8 }, (_, i) => h.say(TEAM, BOB, `${BOT} go ${i}`)));
    expect(h.fires).toHaveLength(5);

    h.db.raw.exec("DELETE FROM fires");
    h.fires.length = 0;
    h.fireAnswer = () => new Response("{}", { status: 401 });
    const before = h.telegram
      .called("sendMessage")
      .filter((c) => c.params.chat_id === ALICE.id).length;
    for (let i = 0; i < 3; i++) await h.say(TEAM, BOB, `${BOT} again ${i}`);
    const notices = h.telegram
      .called("sendMessage")
      .filter((c) => c.params.chat_id === ALICE.id)
      .slice(before);
    expect(notices).toHaveLength(1);
    expect(String(notices[0].params.text)).toContain("token was refused");
  });

  it("a bare /claude in the group starts nothing", async () => {
    await h.say(TEAM, ALICE, "/claude@test_mcp_bot");
    expect(h.fires).toHaveLength(0);
  });

  it("removing the routine lets go of every chat", async () => {
    await press(ALICE, "m:cldely");
    expect(h.db.raw.query("SELECT * FROM claude_chats").get()).toBeNull();
    await h.say(TEAM, ALICE, `${BOT} hi`);
    expect(h.fires).toHaveLength(0);
  });

  it("marks the group in the list, and warns when the bot sees only mentions", async () => {
    let list = await press(ALICE, "m:groups");
    expect(String(list!.text)).toContain("🤖 <b>Team chat</b>");
    await press(ALICE, `m:goy:${TEAM.id}`);
    list = await press(ALICE, "m:groups");
    expect(String(list!.text)).toContain("🤖⚠️ <b>Team chat</b>");

    expect(String((await press(ALICE, `m:g:${TEAM.id}`))!.text)).not.toContain("privacy mode");
    h.telegram.privacyOn = true;
    resetBotIdentity();
    expect(String((await press(ALICE, `m:g:${TEAM.id}`))!.text)).toContain("privacy mode is on");
  });

  it("needs the routine first", async () => {
    await press(ALICE, `m:gc:${TEAM.id}`);
    await press(ALICE, "m:cldely");
    const response = await h.update({
      callback_query: {
        id: "q2",
        from: { ...ALICE, is_bot: false },
        data: `m:gc:${TEAM.id}`,
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    expect((await response.json<{ text?: string }>()).text).toContain(
      "Set up 🤖 Claude on tag first",
    );
    expect(h.db.raw.query("SELECT * FROM claude_chats WHERE chat_id < 0").get()).toBeNull();
  });
});
