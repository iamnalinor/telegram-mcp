import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

const BOARD = {
  title: "Board",
  state: { votes: [], totals: null, said: [], moods: {} },
  view: { text: "{len(said)} said", buttons: [[{ text: "x", press: "x" }]] },
  rules: [
    { on: "vote", do: ["votes += {who: user.name, options: event.options}"] },
    { on: "poll", do: ["totals = event.counts"] },
    { on: "reply", when: "event.text == 'no'", say: "Not that" },
    { on: "reply", when: "event.text != 'skip'", do: ["said += event.text"] },
    { on: "reaction", do: ["moods[user.id] = event.emoji"] },
  ],
};

let h: Harness;
let alice: string;
let scene: number;
let message: number;

beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
  await h.addBot(TEAM, ALICE);
  h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
  // Claude answers in the group, for Alice and for the others too.
  await h.update({
    callback_query: {
      id: "c",
      from: { ...ALICE, is_bot: false },
      data: `m:gc:${TEAM.id}`,
      message: { message_id: 77, date: 1, chat: dm(ALICE) },
    },
  });
  h.db.raw.exec(`UPDATE claude_chats SET others = 1 WHERE chat_id = ${TEAM.id}`);
  const created = await h.tool(alice, "create_scene", { chat: TEAM.id, definition: BOARD });
  scene = Number(/Scene (\d+)/.exec(created.text)![1]);
  message = Number(/as #(\d+)/.exec(created.text)![1]);
  h.db.raw
    .query("INSERT INTO scene_links (kind, key, scene_id) VALUES ('poll', 'P1', ?)")
    .run(scene);
  h.fires.length = 0;
});
afterEach(() => h.restore());

const state = () =>
  JSON.parse(
    (h.db.raw.query("SELECT state FROM scenes WHERE id = ?").get(scene) as { state: string }).state,
  ) as Record<string, unknown>;

const replyTo = (who: typeof BOB, text: string) =>
  h.say(TEAM, who, text, {
    reply_to_message: {
      message_id: message,
      date: 1,
      chat: TEAM,
      from: { id: 123456, is_bot: true, first_name: "Test" },
      text: "0 said",
    },
  });

describe("other sources", () => {
  it("a vote in the scene's poll runs the rule", async () => {
    await h.update({
      poll_answer: { poll_id: "P1", user: { ...BOB, is_bot: false }, option_ids: [0, 2] },
    });
    expect(state().votes).toEqual([{ who: "Bob", options: [0, 2] }]);
    // A poll that is not the scene's is nobody's business.
    await h.update({
      poll_answer: { poll_id: "P2", user: { ...BOB, is_bot: false }, option_ids: [1] },
    });
    expect(state().votes).toHaveLength(1);
  });

  const errors = () =>
    (
      h.db.raw
        .query("SELECT data FROM scene_events WHERE scene_id = ? AND name = 'error'")
        .all(scene) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as { action: string; description: string });

  it("a vote the scene could not take leaves an error for the session", async () => {
    h.db.raw
      .query("UPDATE scenes SET state = ? WHERE id = ?")
      .run(JSON.stringify({ votes: ["x".repeat(8170)], totals: null, said: [], moods: {} }), scene);
    await h.update({
      poll_answer: { poll_id: "P1", user: { ...BOB, is_bot: false }, option_ids: [0] },
    });
    expect(state().votes).toHaveLength(1);
    const [error, ...more] = errors();
    expect(more).toEqual([]);
    expect(error.action).toBe("vote");
    expect(error.description).toContain("over 8192 bytes");
  });

  it("a vote refused for being too fast leaves an error too", async () => {
    h.env.SCENE_LIMIT = {
      limit: () => Promise.resolve({ success: false }),
    };
    await h.update({
      poll_answer: { poll_id: "P1", user: { ...BOB, is_bot: false }, option_ids: [0] },
    });
    expect(state().votes).toEqual([]);
    const [error, ...more] = errors();
    expect(more).toEqual([]);
    expect(error.action).toBe("vote");
    expect(error.description).toContain("too fast");
  });

  it("an anonymous vote is ignored", async () => {
    await h.update({ poll_answer: { poll_id: "P1", voter_chat: TEAM, option_ids: [1] } });
    expect(state().votes).toEqual([]);
  });

  it("poll totals reach the scene", async () => {
    await h.update({
      poll: {
        id: "P1",
        question: "?",
        options: [
          { text: "a", voter_count: 2 },
          { text: "b", voter_count: 5 },
        ],
        total_voter_count: 7,
        is_closed: false,
      },
    });
    expect(state().totals).toEqual([2, 5]);
  });

  it("a typed reply is an event and starts no session", async () => {
    await replyTo(ALICE, "first");
    await replyTo(BOB, "second");
    expect(state().said).toEqual(["first", "second"]);
    expect(h.fires).toHaveLength(0);
    // It is still stored like any message.
    expect(
      h.db.raw.query("SELECT COUNT(*) AS n FROM messages WHERE text = 'second'").get(),
    ).toEqual({ n: 1 });
  });

  it("a refused reply gets a 👎 and starts no session", async () => {
    await replyTo(ALICE, "no");
    const reaction = h.telegram.called("setMessageReaction").at(-1)!.params;
    expect(reaction.reaction).toEqual([{ type: "emoji", emoji: "👎" }]);
    expect(h.fires).toHaveLength(0);
  });

  it("a reply no rule takes goes on to Claude", async () => {
    await replyTo(ALICE, "skip");
    expect(state().said).toEqual([]);
    expect(h.fires).toHaveLength(1);
  });

  it("a reaction is an event", async () => {
    await h.update({
      message_reaction: {
        chat: TEAM,
        message_id: message,
        user: { ...BOB, is_bot: false },
        date: 1,
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });
    expect(state().moods).toEqual({ "222": "🔥" });
  });

  it("asks Telegram for poll updates", async () => {
    await h.fetch("/", { headers: { accept: "text/html" } });
    const registered = h.telegram.called("setWebhook").at(-1)!.params.allowed_updates as string[];
    expect(registered).toContain("poll_answer");
    expect(registered).toContain("poll");
  });
});
