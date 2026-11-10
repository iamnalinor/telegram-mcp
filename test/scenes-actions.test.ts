import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import { PRESETS } from "../src/scenes/guide";
import { Harness, TgError } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", language_code: "en" };
const CAROL = { id: 333, first_name: "Carol", language_code: "en" };
const DAN = { id: 444, first_name: "Dan", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

type Who = typeof ALICE | typeof BOB;

const ACTIONS = {
  title: "Actions",
  state: { rolled: null, n: 0, votes: [] },
  views: {
    main: {
      text: "n = {n}",
      buttons: [
        [
          { text: "post", press: "post" },
          { text: "many", press: "many" },
          { text: "view", press: "view" },
          { text: "whisper", press: "whisper" },
        ],
        [
          { text: "poll", press: "poll" },
          { text: "close", press: "close" },
          { text: "dice", press: "dice" },
          { text: "tag", press: "tag" },
        ],
      ],
    },
    extra: { text: "extra {n}", buttons: [[{ text: "+", press: "add" }]] },
  },
  rules: [
    { on: "press:post", do: ["post('Hello **' + user.name + '**')"] },
    {
      on: "press:many",
      do: ["post('a')", "post('b')", "post('c')", "post('d')", "post('e')", "post('f')"],
    },
    { on: "press:view", do: ["post('extra')"] },
    { on: "press:add", do: ["n += 1"] },
    { on: "press:whisper", do: ["whisper('psst ' + user.name)", "toast('sent')"] },
    { on: "press:poll", do: ["poll('Lunch?', ['Yes', 'No'])"] },
    { on: "press:close", do: ["close_poll()"] },
    { on: "vote", do: ["votes += event.options"] },
    { on: "press:dice", do: ["dice('🎲')"] },
    { on: "dice", do: ["rolled = event.value", "dice('🎲')"] },
    { on: "press:tag", do: ["tag(user, 'player')", "n += 1"] },
  ],
};

let h: Harness;
let alice: string;

beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
  await h.addBot(TEAM, ALICE);
  h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
  h.fires.length = 0;
});
afterEach(() => h.restore());

async function create(definition: unknown) {
  const result = await h.tool(alice, "create_scene", { chat: TEAM.id, definition });
  if (result.isError) throw new Error(result.text);
  return {
    id: Number(/Scene (\d+)/.exec(result.text)![1]),
    message: Number(/as #(\d+)/.exec(result.text)![1]),
  };
}

let queries = 0;
async function press(who: Who, at: { id: number; message: number }, name: string, arg?: unknown) {
  const id = `q${++queries}`;
  const response = await h.update({
    callback_query: {
      id,
      from: { ...who, is_bot: false },
      data: `s:${at.id}:${name}${arg === undefined ? "" : `:${JSON.stringify(arg)}`}`,
      message: { message_id: at.message, date: 1, chat: TEAM },
    },
  });
  return { id, ...(await response.json<{ text?: string; show_alert?: boolean }>()) };
}

const state = (id: number) =>
  JSON.parse(
    (h.db.raw.query("SELECT state FROM scenes WHERE id = ?").get(id) as { state: string }).state,
  ) as Record<string, unknown>;
const errors = (id: number) =>
  (
    h.db.raw
      .query("SELECT data FROM scene_events WHERE scene_id = ? AND name = 'error'")
      .all(id) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as { action: string; description: string });

describe("actions", () => {
  it("post sends a reply to the scene, as written", async () => {
    const at = await create(ACTIONS);
    await press(BOB, at, "post");
    const sent = h.telegram.called("sendMessage").at(-1)!.params;
    expect(sent.text).toBe("Hello **Bob**");
    expect(sent.parse_mode).toBeUndefined();
    expect(sent.reply_parameters).toMatchObject({ message_id: at.message });
  });

  it("post over the limit is dropped and recorded", async () => {
    const at = await create(ACTIONS);
    const before = h.telegram.called("sendMessage").length;
    await press(BOB, at, "many");
    expect(h.telegram.called("sendMessage").length - before).toBe(5);
    expect(errors(at.id)).toEqual([{ action: "post", description: "at most 5 posts a minute" }]);
  });

  it("post of a view adds a live message that follows the state", async () => {
    const at = await create(ACTIONS);
    await press(BOB, at, "view");
    const extra = h.telegram.called("sendMessage").at(-1)!;
    expect(extra.params.text).toBe("extra 0");
    const messages = JSON.parse(
      (h.db.raw.query("SELECT messages FROM scenes").get() as { messages: string }).messages,
    ) as { id: number; view: string }[];
    expect(messages.map((m) => m.view)).toEqual(["main", "extra"]);
    h.db.raw.exec("UPDATE scenes SET edited_at = 0");
    await press(BOB, { id: at.id, message: messages[1].id }, "add");
    const edits = h.telegram.called("editMessageText");
    expect(edits.map((e) => e.params.text)).toContain("extra 1");
    expect(edits.map((e) => e.params.text)).toContain("n = 1");
  });

  it("whisper carries the callback id and the press is still answered", async () => {
    const at = await create(ACTIONS);
    const answer = await press(BOB, at, "whisper");
    expect(answer.text).toBe("sent");
    const sent = h.telegram.called("sendMessage").at(-1)!.params;
    expect(sent.text).toBe("psst Bob");
    expect(sent.ephemeral_message_parameters).toEqual({ callback_query_id: answer.id });
    // Not kept: nobody else will ever see it.
    expect(
      h.db.raw.query("SELECT COUNT(*) AS n FROM messages WHERE text = 'psst Bob'").get(),
    ).toEqual({ n: 0 });
  });

  it("poll sends one non-anonymous poll whose votes come back; close_poll stops it", async () => {
    const at = await create(ACTIONS);
    await press(BOB, at, "poll");
    const poll = h.telegram.called("sendPoll").at(-1)!.params;
    expect(poll).toMatchObject({
      chat_id: TEAM.id,
      question: "Lunch?",
      options: [{ text: "Yes" }, { text: "No" }],
      is_anonymous: false,
    });
    await press(BOB, at, "poll");
    expect(h.telegram.called("sendPoll")).toHaveLength(1);
    expect(errors(at.id).map((e) => e.action)).toEqual(["poll"]);

    const link = h.db.raw.query("SELECT key FROM scene_links WHERE kind = 'poll'").get() as {
      key: string;
    };
    await h.update({
      poll_answer: { poll_id: link.key, user: { ...CAROL, is_bot: false }, option_ids: [1] },
    });
    expect(state(at.id).votes).toEqual([[1]]); // += appends the list as one item

    await press(BOB, at, "close");
    expect(h.telegram.called("stopPoll")).toHaveLength(1);
    await press(BOB, at, "poll");
    expect(h.telegram.called("sendPoll")).toHaveLength(2);
  });

  it("dice comes back as an event, and a die does not throw another", async () => {
    h.telegram.diceValue = 6;
    const at = await create(ACTIONS);
    await press(BOB, at, "dice");
    expect(h.telegram.called("sendDice")).toHaveLength(1);
    expect(h.telegram.called("sendDice")[0].params.emoji).toBe("🎲");
    expect(state(at.id).rolled).toBe(6);
    expect(errors(at.id).map((e) => e.description)).toEqual(["a dice event cannot throw dice"]);
  });

  it("tag sets the presser's tag", async () => {
    const at = await create(ACTIONS);
    await press(BOB, at, "tag");
    expect(h.telegram.called("setChatMemberTag").at(-1)!.params).toEqual({
      chat_id: TEAM.id,
      user_id: BOB.id,
      tag: "player",
    });
  });

  it("a refused tag is recorded, the state stays", async () => {
    h.telegram.handlers.set("setChatMemberTag", () => {
      throw new TgError(400, "Bad Request: not enough rights");
    });
    const at = await create(ACTIONS);
    await press(BOB, at, "tag");
    expect(state(at.id).n).toBe(1);
    expect(errors(at.id)).toEqual([
      { action: "tag", description: "Bad Request: not enough rights" },
    ]);
  });
});

describe("games from the presets", () => {
  it("quiz: three players, scores, table", async () => {
    h.telegram.handlers.set("sendRichMessage", (params) => ({
      message_id: 900,
      date: 1,
      chat: { id: params.chat_id, type: "supergroup" },
      from: { id: 123456, is_bot: true, first_name: "Test" },
      rich_message: { blocks: [] },
    }));
    const at = await create(PRESETS.quiz);
    expect(h.telegram.called("sendRichMessage")).toHaveLength(1);
    const answers: [Who, number[]][] = [
      [BOB, [1, 1, 0]],
      [CAROL, [1, 0, 2]],
      [DAN, [0, 2, 2]],
    ];
    for (let q = 0; q < 3; q++) {
      for (const [who, picks] of answers) {
        expect((await press(who, at, "answer", picks[q])).text).toBe("Got it");
      }
      expect((await press(BOB, at, "answer", 0)).text).toBe("You have answered");
      expect((await press(BOB, at, "next")).text).toBe("This button is only for @alice.");
      await press(ALICE, at, "next");
    }
    const final = state(at.id);
    expect(final.scores).toEqual({ "222": 3, "333": 1, "444": 0 });
    const row = h.db.raw.query("SELECT status FROM scenes").get() as { status: string };
    expect(row.status).toBe("finished");
    const drawn = h.db.raw
      .query("SELECT text FROM messages WHERE chat_id = ? AND message_id = ?")
      .get(TEAM.id, at.message) as { text: string };
    expect(drawn.text).toContain("| 1 | Bob | 3 |");
    expect(drawn.text).toContain("| 2 | Carol | 1 |");
    const logged = h.db.raw.query("SELECT name FROM scene_events").all() as { name: string }[];
    expect(logged.map((e) => e.name)).toEqual(["over"]);
  });

  it("mafia: join, deal, roles, a night that wakes the host, a day vote", async () => {
    // Every player's tap may end the night and wake the host: others must be allowed.
    await h.update({
      callback_query: {
        id: "c",
        from: { ...ALICE, is_bot: false },
        data: `m:gc:${TEAM.id}`,
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    h.db.raw.exec(`UPDATE claude_chats SET others = 1 WHERE chat_id = ${TEAM.id}`);
    const at = await create(PRESETS.mafia);
    const players: Who[] = [ALICE, BOB, CAROL, DAN];

    expect((await press(ALICE, at, "start")).text).toBe("Four players at least");
    for (const who of players) await press(who, at, "join");
    expect((await press(BOB, at, "join")).text).toBe("You are in");
    await press(ALICE, at, "start");

    const dealt = state(at.id).roles as Record<string, string>;
    expect(Object.values(dealt).sort()).toEqual(["civ", "cop", "doc", "mafia"]);
    const holder = (role: string) => players.find((p) => dealt[String(p.id)] === role)!;
    for (const who of players) {
      const answer = await press(who, at, "role");
      expect(answer).toMatchObject({ text: `You are ${dealt[String(who.id)]}`, show_alert: true });
    }

    const mafia = holder("mafia");
    const civ = holder("civ");
    const night: [Who, string][] = [
      [mafia, String(civ.id)],
      [holder("doc"), String(holder("doc").id)],
      [holder("cop"), String(mafia.id)],
      [civ, String(mafia.id)],
    ];
    const said: Record<string, string> = {};
    for (const [who, target] of night) said[who.id] = (await press(who, at, "pick", target)).text!;
    expect(said[holder("cop").id]).toBe("Yes, mafia");
    expect(said[civ.id]).toBe("You are asleep");

    let now = state(at.id);
    expect(now.phase).toBe("day");
    expect(now.out).toBe(String(civ.id));
    expect(now.alive).toHaveLength(3);
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0].body.text).toStartWith(`scene: ${at.id}`);
    // The one who was killed is out of the game.
    expect((await press(civ, at, "role")).text).toBe("You are civ");
    expect((await press(civ, at, "pick", String(mafia.id))).text).toBe("You are out of the game");

    for (const who of players.filter((p) => p !== civ)) {
      await press(who, at, "pick", who === mafia ? String(holder("doc").id) : String(mafia.id));
    }
    now = state(at.id);
    expect(now.out).toBe(String(mafia.id));
    expect(now.phase).toBe("night");
    expect(now.day).toBe(2);
    expect(h.fires).toHaveLength(2);
    const woke = h.db.raw
      .query("SELECT name FROM scene_events WHERE woke = 1 ORDER BY seq")
      .all() as { name: string }[];
    expect(woke.map((e) => e.name)).toEqual(["night_over", "day_over"]);
  });
});
