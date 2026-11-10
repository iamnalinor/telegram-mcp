/**
 * The review of the scenes' bot layer, storage and concurrency (section A):
 * each finding's scenario, and the missing tests it listed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import worker from "../src/index";
import { Store } from "../src/store";
import { Harness, TgError } from "./harness";
import { TICTACTOE } from "./scenes-fixtures";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", language_code: "en" };
const CAROL = { id: 333, first_name: "Carol", language_code: "ru" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
const BOT = "@test_mcp_bot";

const COUNTER = {
  title: "Counter",
  state: { n: 0 },
  let: { pad: "'" + "y".repeat(40) + "'" },
  views: {
    main: {
      text: "n = {n}",
      buttons: [
        [
          { text: "+1", press: "add" },
          { text: "log", press: "log" },
          { text: "pop", press: "pop" },
          { text: "view", press: "view" },
        ],
        [
          { text: "long", press: "long" },
          { text: "roll", press: "roll" },
          { text: "poll", press: "poll" },
          { text: "close", press: "close" },
        ],
      ],
    },
    extra: { text: "extra {n}" },
  },
  rules: [
    { on: "press:add", do: ["n += 1"] },
    { on: "press:log", do: ["log('seen')"] },
    { on: "press:pop", do: ["finish()"] },
    { on: "press:view", do: ["post('extra')"] },
    { on: "press:long", say: "x".repeat(190) + "{pad}" },
    { on: "press:roll", do: ["dice()", "post('rolled')"] },
    { on: "dice", do: ["post('extra')"] },
    { on: "press:poll", do: ["poll('Lunch?', ['Yes', 'No'])"] },
    { on: "press:close", do: ["close_poll()"] },
    { on: "vote", do: ["n += 100"] },
    { on: "poll", do: ["n += 1"] },
  ],
};

let h: Harness;
let alice: string;
const restores: (() => void)[] = [];

async function setUp(vars = {}) {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness(vars);
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.addBot(TEAM, ALICE);
}
beforeEach(() => setUp());
afterEach(() => {
  while (restores.length) restores.pop()!();
  h.restore();
});

/** Replace a Store method for this test; the original comes back afterwards. */
function hook<K extends keyof Store>(name: K, replace: (original: Store[K]) => Store[K]) {
  const proto = Store.prototype as unknown as Record<string, unknown>;
  const original = proto[name] as Store[K];
  proto[name] = replace(original);
  restores.push(() => (proto[name] = original));
}

async function create(definition: unknown = COUNTER) {
  const result = await h.tool(alice, "create_scene", { chat: TEAM.id, definition });
  if (result.isError) throw new Error(result.text);
  const id = Number(/Scene (\d+)/.exec(result.text)![1]);
  // Past the first second: presses draw at once unless a test says otherwise.
  h.db.raw.exec(`UPDATE scenes SET edited_at = 0 WHERE id = ${id}`);
  return { id, message: Number(/as #(\d+)/.exec(result.text)![1]) };
}

let queries = 0;
async function press(
  who: { id: number; first_name: string; language_code?: string },
  at: { id: number; message: number },
  name: string,
  queryId = `q${++queries}`,
) {
  const response = await h.update({
    callback_query: {
      id: queryId,
      from: { ...who, is_bot: false },
      data: `s:${at.id}:${name}`,
      message: { message_id: at.message, date: 1, chat: TEAM },
    },
  });
  return response.json<{ text?: string; show_alert?: boolean }>();
}

const row = (id: number) =>
  h.db.raw.query("SELECT * FROM scenes WHERE id = ?").get(id) as {
    state: string;
    version: number;
    status: string;
    messages: string;
    poll: string | null;
    dirty: number;
  };
const n = (id: number) => (JSON.parse(row(id).state) as { n: number }).n;
const live = (id: number) =>
  (JSON.parse(row(id).messages) as { id: number; view: string }[]).map((m) => m.view);
const events = (id: number, name?: string) =>
  h.db.raw
    .query(
      `SELECT name, data FROM scene_events WHERE scene_id = ? ${name ? "AND name = ?" : ""} ORDER BY seq`,
    )
    .all(...(name ? [id, name] : [id])) as { name: string; data: string | null }[];
const errorTexts = (id: number) =>
  events(id, "error").map((e) => (JSON.parse(e.data!) as { description: string }).description);
const edits = (message: number) =>
  h.telegram.called("editMessageText").filter((call) => call.params.message_id === message);

async function daily() {
  await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now(), noRetry() {} }, h.env);
}

describe("A1: a reply to a scene that is not the scene's goes on to Claude", () => {
  beforeEach(async () => {
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    await h.update({
      callback_query: {
        id: "c",
        from: { ...ALICE, is_bot: false },
        data: `m:gc:${TEAM.id}`,
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    h.fires.length = 0;
  });

  const replyTo = (message: number, text: string) =>
    h.say(TEAM, ALICE, text, {
      reply_to_message: {
        message_id: message,
        date: 1,
        chat: TEAM,
        from: { id: 123456, is_bot: true, first_name: "Test" },
        text: "board",
      },
    });

  it("after the game is over, the owner's question reaches Claude, without a 👎", async () => {
    const at = await create(TICTACTOE);
    for (const [who, cell] of [
      [ALICE, 0],
      [BOB, 3],
      [ALICE, 1],
      [BOB, 4],
      [ALICE, 2],
    ] as const)
      await press(who, at, `cell:${cell}`);
    expect(row(at.id).status).toBe("finished");
    await replyTo(at.message, `${BOT} what was the result?`);
    expect(h.fires).toHaveLength(1);
    expect(
      h.telegram.called("setMessageReaction").map((c) => c.params.reaction),
    ).not.toContainEqual([{ type: "emoji", emoji: "👎" }]);
  });

  it("a reply refused for being too fast is not swallowed either", async () => {
    h.restore();
    await setUp({
      SCENE_LIMIT: { limit: () => Promise.resolve({ success: false }) } as unknown as RateLimit,
    });
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    h.telegram.members.set(`${TEAM.id}:${ALICE.id}`, "member");
    await h.update({
      callback_query: {
        id: "c",
        from: { ...ALICE, is_bot: false },
        data: `m:gc:${TEAM.id}`,
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    h.fires.length = 0;
    const at = await create({ ...COUNTER, rules: [{ on: "reply", do: ["n += 1"] }] });
    await replyTo(at.message, `${BOT} please check`);
    expect(h.fires).toHaveLength(1);
  });

  it("a command or a forward that replies to a scene is not the scene's", async () => {
    const at = await create({ ...COUNTER, rules: [{ on: "reply", do: ["n += 1"] }] });
    await replyTo(at.message, "/start");
    await h.say(TEAM, ALICE, "fwd", {
      forward_origin: { type: "hidden_user", date: 1, sender_user_name: "X" },
      reply_to_message: {
        message_id: at.message,
        date: 1,
        chat: TEAM,
        from: { id: 123456, is_bot: true, first_name: "T" },
      },
    });
    expect(n(at.id)).toBe(0);
  });
});

describe("A2: a scene in use is not ended as idle", () => {
  it("presses that change nothing still mark it used, once a day", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET updated = updated - 15 * 86400`);
    await press(BOB, at, "log");
    await daily();
    expect(row(at.id).status).toBe("active");
    // Within the day, no write for it.
    const version = row(at.id).version;
    const updated = (h.db.raw.query("SELECT updated FROM scenes").get() as { updated: number })
      .updated;
    await press(BOB, at, "log");
    expect(row(at.id).version).toBe(version);
    expect(
      (h.db.raw.query("SELECT updated FROM scenes").get() as { updated: number }).updated,
    ).toBe(updated);
  });
});

describe("A3: what actions keep beside the state is never overwritten", () => {
  it("two presses that add live messages at once keep both", async () => {
    const at = await create();
    await Promise.all([press(BOB, at, "view"), press(CAROL, at, "view")]);
    expect(live(at.id)).toEqual(["main", "extra", "extra"]);
    // The third would pass the cap: refused, and its message taken back.
    await press(BOB, at, "view");
    expect(live(at.id)).toHaveLength(3);
    expect(errorTexts(at.id)).toContain("a scene has at most 3 live messages");
  });

  it("a die whose rule posts a view, then a post: both kept", async () => {
    const at = await create();
    await press(BOB, at, "roll");
    expect(live(at.id)).toEqual(["main", "extra"]);
    expect(
      JSON.parse((h.db.raw.query("SELECT posts FROM scenes").get() as { posts: string }).posts),
    ).toHaveLength(3);
  });

  it("two polls at once: one opens, the other is refused", async () => {
    const at = await create();
    await Promise.all([press(BOB, at, "poll"), press(CAROL, at, "poll")]);
    expect(h.telegram.called("sendPoll")).toHaveLength(1);
    expect(typeof (JSON.parse(row(at.id).poll!) as { poll_id: unknown }).poll_id).toBe("string");
  });
});

describe("A4: failures after the commit", () => {
  it("answer as applied, and are recorded; the state stays", async () => {
    const at = await create();
    hook("updateOutgoing", () => () => Promise.reject(new Error("D1 hiccup")));
    const answer = await press(CAROL, at, "add");
    expect(answer.text).toBeUndefined();
    expect(n(at.id)).toBe(1);
    expect(errorTexts(at.id)).toEqual(["Error: D1 hiccup"]);
  });

  it("a failure before the commit answers in the presser's language", async () => {
    const at = await create();
    hook("commitScene", () => () => Promise.reject(new Error("D1 down")));
    expect((await press(CAROL, at, "add")).text).toBe("Не получилось, попробуй ещё раз.");
    expect(n(at.id)).toBe(0);
  });
});

describe("A5: a long answer", () => {
  it("is cut to Telegram's 200 characters", async () => {
    const at = await create();
    const answer = await press(BOB, at, "long");
    expect(Array.from(answer.text!)).toHaveLength(200);
    expect(answer.text!.endsWith("…")).toBe(true);
  });
});

describe("A6: a finish while Telegram asks for quiet, or while throttled", () => {
  it("is drawn once the quiet is over", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET quiet_until = ${Date.now() + 300}`);
    await press(BOB, at, "pop");
    await Promise.allSettled(h.waits);
    expect(edits(at.message).at(-1)!.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(row(at.id).dirty).toBe(0);
  });

  it("a deferred redraw of a finish removes the keyboard", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET edited_at = ${Date.now()}`);
    await press(BOB, at, "add");
    await press(BOB, at, "pop");
    await Promise.allSettled(h.waits);
    const last = edits(at.message).at(-1)!.params;
    expect(last.text).toBe("n = 1");
    expect(last.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("a long quiet is left to the daily run, which draws it", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET quiet_until = ${Date.now() + 600_000}`);
    await press(BOB, at, "pop");
    await Promise.allSettled(h.waits);
    expect(edits(at.message)).toHaveLength(0);
    expect(row(at.id)).toMatchObject({ status: "finished", dirty: 1 });
    h.db.raw.exec("UPDATE scenes SET quiet_until = 0");
    await daily();
    expect(edits(at.message).at(-1)!.params.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

describe("A7: the MCP path keeps to the edits' pace and finishes its redraw", () => {
  it("act within a second of the last edit is drawn a little later", async () => {
    const created = await h.tool(alice, "create_scene", {
      chat: TEAM.id,
      definition: { ...COUNTER, rules: [{ on: "act:set", do: ["n = arg"] }] },
    });
    const id = Number(/Scene (\d+)/.exec(created.text)![1]);
    const message = Number(/as #(\d+)/.exec(created.text)![1]);
    await h.tool(alice, "update_scene", { scene: id, act: { name: "set", arg: 7 } });
    expect(String(edits(message).at(-1)!.params.text)).toBe("n = 7");
  });

  it("state merges respect the pace too", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET edited_at = ${Date.now()}`);
    sceneTiming.redrawDelayMs = 300;
    const started = Date.now();
    await h.tool(alice, "update_scene", { scene: at.id, state: { n: 5 } });
    expect(String(edits(at.message).at(-1)!.params.text)).toBe("n = 5");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});

describe("A8: the deferred redraw's claim", () => {
  it("is taken by one of those waiting, with the edit time set", async () => {
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET dirty = 1, edited_at = 0 WHERE id = ${at.id}`);
    const store = new Store(h.db.asD1());
    const now = Date.now();
    const claims = await Promise.all([
      store.claimRedraw(at.id, now),
      store.claimRedraw(at.id, now),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      (h.db.raw.query("SELECT edited_at FROM scenes").get() as { edited_at: number }).edited_at,
    ).toBe(now);
    // Not while Telegram asks for quiet.
    h.db.raw.exec(`UPDATE scenes SET dirty = 1, quiet_until = ${now + 60_000}`);
    expect(await store.claimRedraw(at.id, now)).toBeNull();
  });
});

describe("A9: after retention", () => {
  it("the scene's message is kept, and reactions reach the scene", async () => {
    const at = await create({ ...COUNTER, rules: [{ on: "reaction", do: ["n += 1"] }] });
    h.db.raw.exec(`UPDATE messages SET date = date - 20 * 86400 WHERE message_id = ${at.message}`);
    await daily();
    expect(
      h.db.raw.query("SELECT COUNT(*) AS n FROM messages WHERE message_id = ?").get(at.message),
    ).toEqual({ n: 1 });
    // Even with the stored copy gone, the link leads the reaction to the scene.
    h.db.raw.exec(`DELETE FROM messages WHERE message_id = ${at.message}`);
    await h.update({
      message_reaction: {
        chat: TEAM,
        message_id: at.message,
        user: { ...BOB, is_bot: false },
        date: 1,
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });
    expect(n(at.id)).toBe(1);
  });
});

describe("A10: a scene's event log", () => {
  it("keeps only its latest events", async () => {
    const at = await create();
    const store = new Store(h.db.asD1());
    for (let i = 0; i < 230; i++) {
      await store.addSceneEvent(at.id, { name: "seen", user_id: 1, user_name: "x", data: null });
    }
    const counted = h.db.raw
      .query("SELECT COUNT(*) AS n, MIN(seq) AS low FROM scene_events WHERE scene_id = ?")
      .get(at.id) as { n: number; low: number };
    expect(counted).toEqual({ n: 200, low: 31 });
  });

  it("does not repeat the same failure", async () => {
    h.telegram.handlers.set("setChatMemberTag", () => {
      throw new TgError(400, "Bad Request: not enough rights");
    });
    const at = await create({ ...COUNTER, rules: [{ on: "press:add", do: ["tag(user, 'x')"] }] });
    await press(BOB, at, "add");
    await press(BOB, at, "add");
    expect(events(at.id, "error")).toHaveLength(1);
  });
});

describe("the bot layer's minor findings", () => {
  it("a redelivered update is applied once", async () => {
    const at = await create();
    await press(BOB, at, "add", "same-query");
    await press(BOB, at, "add", "same-query");
    expect(n(at.id)).toBe(1);
  });

  it("stale and forged presses count against the person's limit", async () => {
    let calls = 0;
    h.restore();
    await setUp({
      SCENE_LIMIT: {
        limit: () => Promise.resolve({ success: ++calls <= 1 }),
      } as unknown as RateLimit,
    });
    const at = await create();
    await press(BOB, at, "nothing");
    expect((await press(BOB, at, "forged")).text).toBe("Not so fast.");
  });

  it("poll totals and dice are not counted per person", async () => {
    h.restore();
    await setUp({
      SCENE_LIMIT: { limit: () => Promise.resolve({ success: false }) } as unknown as RateLimit,
    });
    const at = await create();
    h.db.raw
      .query("INSERT INTO scene_links (kind, key, scene_id) VALUES ('poll', 'P1', ?)")
      .run(at.id);
    for (let i = 0; i < 12; i++) {
      await h.update({
        poll: { id: "P1", question: "?", options: [], total_voter_count: i, is_closed: false },
      });
    }
    expect(n(at.id)).toBe(12);
  });

  it("close_poll keeps the poll when Telegram refuses; once closed, its votes no longer count", async () => {
    const at = await create();
    await press(BOB, at, "poll");
    const pollId = (JSON.parse(row(at.id).poll!) as { poll_id: string }).poll_id;
    h.telegram.handlers.set("stopPoll", () => {
      throw new TgError(400, "Bad Request: poll has already been closed");
    });
    await press(BOB, at, "close");
    expect(row(at.id).poll).not.toBeNull();
    h.telegram.handlers.set("stopPoll", () => ({ id: pollId }));
    await press(BOB, at, "close");
    expect(row(at.id).poll).toBeNull();
    await h.update({
      poll_answer: { poll_id: pollId, user: { ...BOB, is_bot: false }, option_ids: [0] },
    });
    expect(n(at.id)).toBe(0);
  });

  it("a live message other than the main one that was deleted leaves the list", async () => {
    const at = await create();
    await press(BOB, at, "view");
    const extra = (JSON.parse(row(at.id).messages) as { id: number }[])[1].id;
    h.telegram.handlers.set("editMessageText", (params) => {
      if (params.message_id === extra)
        throw new TgError(400, "Bad Request: message to edit not found");
      return true;
    });
    await press(BOB, at, "add");
    expect(live(at.id)).toEqual(["main"]);
    expect(row(at.id).status).toBe("active");
  });

  it("a rich view is edited as a rich message", async () => {
    h.telegram.handlers.set("sendRichMessage", (params) => ({
      message_id: 901,
      date: 1,
      chat: { id: params.chat_id, type: "supergroup" },
      from: { id: 123456, is_bot: true, first_name: "Test" },
    }));
    const at = await create({
      title: "r",
      state: { n: 0 },
      view: { text: "## n = {n}", format: "rich", buttons: [[{ text: "+", press: "add" }]] },
      rules: [{ on: "press:add", do: ["n += 1"] }],
    });
    await press(BOB, at, "add");
    const edit = edits(at.message).at(-1)!.params;
    expect(edit.rich_message).toEqual({ markdown: "## n = 1" });
    expect(edit.text).toBeUndefined();
  });

  it("the owner's name comes from the scene, without reading the user", async () => {
    const at = await create({
      ...COUNTER,
      rules: [{ on: "press:add", who: "owner", do: ["n += 1"] }],
    });
    let reads = 0;
    hook(
      "getUser",
      (original) =>
        function (this: Store, id: number) {
          reads++;
          return original.call(this, id);
        },
    );
    expect((await press(BOB, at, "add")).text).toBe("This button is only for @alice.");
    expect(reads).toBe(0);
  });
});

describe("races, made to happen", () => {
  /** Someone else commits between this press's read and its commit, `times` times. */
  function overtake(times: number) {
    let left = times;
    hook(
      "commitScene",
      (original) =>
        function (this: Store, id: number, version: number, patch: object) {
          if (left-- > 0) h.db.raw.exec(`UPDATE scenes SET version = version + 1 WHERE id = ${id}`);
          return original.call(this, id, version, patch);
        },
    );
  }

  it("a press that was overtaken reads again and lands", async () => {
    const at = await create();
    overtake(1);
    expect((await press(BOB, at, "add")).text).toBeUndefined();
    expect(n(at.id)).toBe(1);
  });

  it("two presses each overtaken once both land", async () => {
    const at = await create();
    overtake(2);
    await Promise.all([press(BOB, at, "add"), press(CAROL, at, "add")]);
    expect(n(at.id)).toBe(2);
  });

  it("overtaken three times: refused in the presser's language, the state intact", async () => {
    const at = await create();
    overtake(3);
    expect((await press(BOB, at, "add")).text).toBe("That did not work. Try again.");
    overtake(3);
    expect((await press(CAROL, at, "add")).text).toBe("Не получилось, попробуй ещё раз.");
    expect(n(at.id)).toBe(0);
  });
});
