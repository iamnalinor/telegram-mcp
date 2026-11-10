/**
 * The review of scenes without an assistant: who acts on a scene with no
 * session, what "nobody to wake" may cover, the panic button, and the menu's
 * pages, cards and double taps.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import { Harness, TgError } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
const SESSION = "session_01Svopn2AB4YoGuZVfSMUKGR";

const GAME = {
  title: "Guess",
  brief: "A guessing game; when woken, give a hint.",
  state: { n: 0, asked: 0 },
  view: {
    text: "Guesses: {n}",
    buttons: [
      [
        { text: "Guess", press: "guess" },
        { text: "Hint", press: "hint" },
      ],
    ],
  },
  rules: [
    { on: "press:guess", do: ["n += 1", "toast('Guess ' + n)"] },
    { on: "press:hint", do: ["asked += 1", "wake('hint')"] },
    { on: "act:hint", do: ["asked += 1", "wake('hint')"] },
  ],
};

type Keyboard = { inline_keyboard: { text: string; callback_data?: string }[][] };

let h: Harness;
let alice: string;
let sessions = 0;

async function setUp(routine: boolean) {
  sceneTiming.redrawDelayMs = 20;
  sessions = 0;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  if (routine) await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
  await h.addBot(TEAM, ALICE);
  h.fireAnswer = () => {
    const id = `01Session${String(++sessions).padStart(15, "0")}`;
    return Response.json({ claude_code_session_id: `cse_${id}` });
  };
  h.fires.length = 0;
}
afterEach(() => h.restore());

async function create(extra: Record<string, unknown> = {}, chat: number = TEAM.id) {
  const result = await h.tool(alice, "create_scene", { chat, definition: GAME, ...extra });
  if (result.isError) throw new Error(result.text);
  return {
    id: Number(/Scene (\d+)/.exec(result.text)![1]),
    message: Number(/as #(\d+)/.exec(result.text)![1]),
    chat,
    text: result.text,
  };
}

async function press(
  who: typeof ALICE,
  at: { id: number; message: number; chat: number },
  name: string,
) {
  const response = await h.update({
    callback_query: {
      id: `q${Math.random()}`,
      from: { ...who, is_bot: false },
      data: `s:${at.id}:${name}`,
      message: {
        message_id: at.message,
        date: 1,
        chat: { id: at.chat, type: at.chat > 0 ? "private" : "supergroup" },
      },
    },
  });
  return response.json<{ text?: string }>();
}

async function menu(data: string, who: { id: number; language_code?: string } = ALICE) {
  const before = h.telegram.called("editMessageText").length;
  const response = await h.update({
    callback_query: {
      id: `m${Math.random()}`,
      from: { ...ALICE, ...who, is_bot: false },
      data,
      message: { message_id: 77, date: 1, chat: dm(who) },
    },
  });
  const edits = h.telegram
    .called("editMessageText")
    .filter((call) => call.params.message_id === 77);
  const screen = h.telegram.called("editMessageText").length > before ? edits.at(-1) : undefined;
  return {
    text: (screen?.params.text as string | undefined) ?? "",
    buttons: ((screen?.params.reply_markup as Keyboard | undefined)?.inline_keyboard ?? []).flat(),
    note: (await response.json<{ text?: string }>()).text,
  };
}

const data = (screen: { buttons: { callback_data?: string }[] }) =>
  screen.buttons.map((b) => b.callback_data);
const startOf = (card: { buttons: { callback_data?: string }[] }) =>
  card.buttons.find((b) => b.callback_data?.startsWith("m:sgo:"))?.callback_data;

const state = (id: number) =>
  JSON.parse(
    (h.db.raw.query("SELECT state FROM scenes WHERE id = ?").get(id) as { state: string }).state,
  ) as Record<string, unknown>;
const count = (sql: string) => (h.db.raw.query(sql).get() as { n: number }).n;
const templateId = (name: string) =>
  (h.db.raw.query("SELECT id FROM scene_templates WHERE name = ?").get(name) as { id: number }).id;
const privateScenes = () =>
  count(`SELECT COUNT(*) AS n FROM scenes WHERE chat_id = ${ALICE.id} AND status = 'active'`);

async function relayOnline(): Promise<string> {
  await menu("m:rlnew");
  const text = String(
    h.telegram
      .called("sendMessage")
      .filter((c) => String(c.params.text).includes("RELAY_TOKEN"))
      .at(-1)!.params.text,
  );
  const token = /RELAY_TOKEN=(relay_[\w-]+)/.exec(text)![1];
  await h.fetch("/relay/jobs", { headers: { authorization: `Bearer ${token}` } });
  return token;
}

describe("act on a scene with no session", () => {
  beforeEach(() => setUp(true));

  it("runs from a session that names itself, and wakes nobody even with a routine set up", async () => {
    const at = await create();
    const result = await h.tool(alice, "update_scene", {
      scene: at.id,
      act: { name: "hint" },
      session: SESSION,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("act:hint applied. Its wake() was only logged: nobody was woken");
    expect(state(at.id)).toEqual({ n: 0, asked: 1 });
    expect(h.fires).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM fires")).toBe(0);
  });

  it("runs on a scene the user started from the menu", async () => {
    await create();
    const started = await menu(startOf(await menu(`m:st:${templateId("guess")}:0`))!);
    expect(started.note).toBe("Started: it is in this chat now.");
    const id = (
      h.db.raw.query("SELECT id FROM scenes WHERE chat_id = ?").get(ALICE.id) as { id: number }
    ).id;
    const result = await h.tool(alice, "update_scene", {
      scene: id,
      act: { name: "hint" },
      session: SESSION,
    });
    expect(result.isError).toBe(false);
    expect(state(id)).toEqual({ n: 0, asked: 1 });
    expect(h.fires).toHaveLength(0);
  });

  it("from another session than the scene's own is still refused", async () => {
    const at = await create({ session: SESSION });
    const result = await h.tool(alice, "update_scene", {
      scene: at.id,
      act: { name: "hint" },
      session: "session_01ZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("runs only from that session");
    expect(state(at.id)).toEqual({ n: 0, asked: 0 });
  });
});

describe("nobody to wake, or nobody reachable now", () => {
  it("with nothing set up, the rule runs unwoken", async () => {
    await setUp(false);
    const at = await create();
    expect((await press(ALICE, at, "hint")).text).toBe(
      "No assistant is connected, so nobody was woken.",
    );
    expect(state(at.id)).toEqual({ n: 0, asked: 1 });
  });

  it("with the scene's session behind a relay that went offline, the press is refused", async () => {
    await setUp(false);
    await relayOnline();
    const at = await create({ session: SESSION });
    expect(at.text).toContain("Wakes you: press:hint");
    h.db.raw.exec("UPDATE relays SET last_seen = 0");
    const report = await h.tool(alice, "create_scene", {
      chat: TEAM.id,
      definition: GAME,
      session: SESSION,
      dry_run: true,
    });
    expect(report.text).toContain("your session cannot be reached");
    const answer = await press(ALICE, at, "hint");
    expect(answer.text).toBe("Nobody can answer right now. Try again later.");
    expect(state(at.id)).toEqual({ n: 0, asked: 0 });
    // Back online: the same press goes through.
    await relayOnline();
    expect((await press(ALICE, at, "hint")).text).toBeUndefined();
    expect(state(at.id)).toEqual({ n: 0, asked: 1 });
  });

  it("with a routine that no longer reads, the press is refused, in Russian too", async () => {
    await setUp(true);
    const at = await create();
    h.db.raw.exec("UPDATE routines SET token_enc = 'garbage'");
    expect((await press(ALICE, at, "hint")).text).toBe(
      "Nobody can answer right now. Try again later.",
    );
    expect((await press({ ...ALICE, language_code: "ru" }, at, "hint")).text).toBe(
      "Сейчас некому ответить. Попробуй позже.",
    );
    expect(state(at.id)).toEqual({ n: 0, asked: 0 });
    expect(h.fires).toHaveLength(0);
  });

  it("an unwoken wake runs even with the scene's limits used up", async () => {
    await setUp(true);
    const at = await create();
    h.db.raw.exec(`UPDATE scenes SET wake_limit = 1 WHERE id = ${at.id}`);
    expect((await press(ALICE, at, "hint")).text).toBeUndefined();
    expect(h.fires).toHaveLength(1);
    expect((await press(ALICE, at, "hint")).text).toContain("The assistant is resting");
    expect(state(at.id)).toMatchObject({ asked: 1 });
    // Nothing set up any more: nothing to protect, the rule runs.
    h.db.raw.exec("DELETE FROM routines");
    for (let i = 0; i < 2; i++) {
      expect((await press(ALICE, at, "hint")).text).toBe(
        "No assistant is connected, so nobody was woken.",
      );
    }
    expect(state(at.id)).toMatchObject({ asked: 3 });
    expect(h.fires).toHaveLength(1);
    // The one start, and the note that the limit held one back; the unwoken ones claim nothing.
    expect(count("SELECT COUNT(*) AS n FROM fires WHERE status <> 'limited'")).toBe(1);
  });
});

describe("stopping every scene", () => {
  beforeEach(() => setUp(false));

  it("asks first, then ends the scenes in every chat and takes their buttons off", async () => {
    const team = await create();
    const own = await create({}, ALICE.id);
    const hub = await menu("m:scn");
    expect(hub.buttons.find((b) => b.callback_data === "m:scx")!.text).toBe("■ Stop all scenes");

    const ask = await menu("m:scx");
    expect(ask.text).toContain("Stop all 2 running scenes, in every chat?");
    expect(data(ask)).toEqual(["m:scxy", "m:scn"]);
    const cancelled = await menu("m:scn");
    expect(cancelled.text).toContain("Running: 2");

    const edits = h.telegram.called("editMessageText").length;
    const done = await menu("m:scxy");
    expect(done.note).toBe("Stopped 2 scenes.");
    expect(done.text).toContain("None running.");
    expect(data(done)).not.toContain("m:scx");
    const status = h.db.raw
      .query("SELECT status FROM scenes WHERE id IN (?, ?)")
      .all(team.id, own.id) as { status: string }[];
    expect(status.map((row) => row.status)).toEqual(["finished", "finished"]);
    const bare = h.telegram
      .called("editMessageText")
      .slice(edits)
      .filter(
        (call) => call.params.message_id === team.message || call.params.message_id === own.message,
      );
    expect(bare.map((call) => call.params.reply_markup)).toEqual([
      { inline_keyboard: [] },
      { inline_keyboard: [] },
    ]);
    expect((await press(BOB, team, "guess")).text).toBe("This scene is over.");
  });

  it("with nothing running, says so", async () => {
    expect((await menu("m:scx")).note).toBe("Nothing was running.");
  });

  it("/disconnect says scenes keep running, and offers the button", async () => {
    await create();
    const reply = (await h.say(dm(ALICE), ALICE, "/disconnect"))._reply as {
      text: string;
      reply_markup?: Keyboard;
    };
    expect(reply.text).toContain("Your scenes keep running: they need no assistant.");
    expect(reply.text).toContain("■ Stop all scenes");
    expect(reply.reply_markup!.inline_keyboard.flat()).toEqual([
      { text: "■ Stop all scenes", callback_data: "m:scx" },
    ]);
    // Nothing running: no button.
    await menu("m:scxy");
    const again = (await h.say(dm(ALICE), ALICE, "/disconnect"))._reply as {
      reply_markup?: Keyboard;
    };
    expect(again.reply_markup).toBeUndefined();
  });

  it("the sign-out-everywhere question names it, in both languages", async () => {
    const en = await menu("m:out");
    expect(en.text).toContain("Your scenes keep running after this");
    expect(data(en)).toContain("m:scx");
    const ru = await menu("m:out", { id: ALICE.id, language_code: "ru" });
    expect(ru.text).toContain("Сцены после этого продолжат идти");
    expect(ru.buttons.find((b) => b.callback_data === "m:scx")!.text).toBe(
      "■ Остановить все сцены",
    );
  });
});

describe("the hub with many scenes", () => {
  beforeEach(() => setUp(false));

  it("pages more than 20 running scenes, and always fits a message", async () => {
    const long = "W".repeat(97);
    h.db.raw.exec(`UPDATE chats SET title = '${"T".repeat(128)}' WHERE chat_id = ${TEAM.id}`);
    for (let i = 0; i < 20; i++) await create({ definition: { ...GAME, title: `${long}${i}` } });
    for (let i = 0; i < 5; i++) await create({}, ALICE.id);

    const first = await menu("m:scn");
    expect(first.text).toContain("Running: 25</b> · page 1 of 3");
    expect(first.buttons.filter((b) => b.callback_data?.startsWith("m:sv:"))).toHaveLength(10);
    expect(data(first)).toContain("m:scn:1");
    expect(data(first)).not.toContain("m:scn:-1");
    expect(first.text.length).toBeLessThan(4096);
    expect(first.text).toContain("W…");
    expect(first.text).not.toContain(long);

    const last = await menu("m:scn:2");
    expect(last.text).toContain("page 3 of 3");
    expect(last.buttons.filter((b) => b.callback_data?.startsWith("m:sv:"))).toHaveLength(5);
    expect(data(last)).toContain("m:scn:1");
    expect(data(last)).not.toContain("m:scn:3");
    // A page past the end shows the last one.
    expect((await menu("m:scn:99")).text).toContain("page 3 of 3");
  });
});

describe("saved scenes in the menu", () => {
  beforeEach(() => setUp(false));

  it("pages more than 10 saved scenes; a card goes back to its page, and so does a delete", async () => {
    for (let i = 0; i < 12; i++) {
      const saved = await h.tool(alice, "save_scene", {
        name: `game-${String(i).padStart(2, "0")}`,
        definition: { ...GAME, title: `Game ${i}` },
      });
      expect(saved.text).toContain("Saved");
    }
    const first = await menu("m:sl:0");
    expect(first.buttons.filter((b) => b.callback_data?.startsWith("m:st:"))).toHaveLength(10);
    expect(data(first)).toContain("m:sl:1");
    const second = await menu("m:sl:1");
    const cards = second.buttons.filter((b) => b.callback_data?.startsWith("m:st:"));
    expect(cards).toHaveLength(2);
    expect(cards.every((b) => b.callback_data!.endsWith(":1"))).toBe(true);

    const card = await menu(cards[0].callback_data!);
    expect(data(card)).toContain("m:sl:1");
    const id = /^m:st:(\d+):1$/.exec(cards[0].callback_data!)![1];
    const ask = await menu(`m:sdel:${id}:1`);
    expect(data(ask)).toEqual([`m:sdely:${id}:1`, `m:st:${id}:1`]);
    const done = await menu(`m:sdely:${id}:1`);
    expect(done.note).toBe("Deleted.");
    expect(data(done)).toContain("m:sl:0");
    expect(done.buttons.filter((b) => b.callback_data?.startsWith("m:st:"))).toHaveLength(1);

    // The last one on that page: back to the page before.
    const lastId = /^m:st:(\d+):1$/.exec(
      done.buttons.find((b) => b.callback_data?.startsWith("m:st:"))!.callback_data!,
    )![1];
    const after = await menu(`m:sdely:${lastId}:1`);
    expect(after.buttons.filter((b) => b.callback_data?.startsWith("m:st:"))).toHaveLength(10);
    expect(data(after)).not.toContain("m:sl:1");
  });

  it("the card says what the scene holds: buttons, links, what it sends and wakes on", async () => {
    await create();
    const card = await menu(`m:st:${templateId("guess")}:0`);
    expect(card.text).toContain("Buttons: 2. Rules that send messages: 0.");
    expect(card.text).toContain("Wakes the assistant on: press:hint, act:hint.");

    await h.tool(alice, "save_scene", {
      name: "links",
      definition: {
        title: "Links",
        state: {},
        view: {
          text: "Read",
          buttons: [
            [
              { text: "Site", url: "https://example.com" },
              { text: "Post", press: "p" },
            ],
          ],
        },
        rules: [{ on: "press:p", do: ["post('hello')"] }],
      },
    });
    const links = await menu(`m:st:${templateId("links")}:0`);
    expect(links.text).toContain("Buttons: 2 (links: 1). Rules that send messages: 1.");
    expect(links.text).toContain("Never wakes the assistant.");
    const ru = await menu(`m:st:${templateId("links")}:0`, { id: ALICE.id, language_code: "ru" });
    expect(ru.text).toContain("Кнопок: 2 (ссылок: 1). Правил, которые шлют сообщения: 1.");
  });

  it("▶ starts only the version the card showed", async () => {
    await create();
    const id = templateId("guess");
    const go = startOf(await menu(`m:st:${id}:0`))!;
    expect(go).toBe(`m:sgo:${id}:1:1:0`);
    await h.tool(alice, "save_scene", {
      name: "guess",
      definition: { ...GAME, title: "Guess harder" },
      version: 1,
    });
    const refused = await menu(go);
    expect(refused.note).toBe(
      "This saved scene changed since you opened it. Here it is as it is now: check it, then start it again.",
    );
    expect(refused.text).toContain("Guess harder");
    expect(refused.text).toContain("version 2");
    expect(privateScenes()).toBe(0);
    const started = await menu(startOf(refused)!);
    expect(started.note).toBe("Started: it is in this chat now.");
    expect(privateScenes()).toBe(1);
    // A ▶ from before cards named their version is out of date too.
    expect((await menu(`m:sgo:${id}`)).note).toContain("changed since you opened it");
    expect(privateScenes()).toBe(1);
  });

  it("a double tap on ▶ starts one scene", async () => {
    await create();
    const id = templateId("guess");
    const go = startOf(await menu(`m:st:${id}:0`))!;
    const [one, two] = await Promise.all([menu(go), menu(go)]);
    expect([one.note, two.note].sort()).toEqual([
      "It has been started since this card was shown (a second tap?). Press ▶ again for another one.",
      "Started: it is in this chat now.",
    ]);
    expect(privateScenes()).toBe(1);
    // In turn, too: the second press shows the card again, whose ▶ starts another.
    const again = await menu(go);
    expect(again.note).toContain("a second tap?");
    expect(again.text).toContain("started 2 times");
    expect((await menu(startOf(again)!)).note).toBe("Started: it is in this chat now.");
    expect(privateScenes()).toBe(2);
  });

  it("a start Telegram refuses counts no use and leaves the card's ▶ working", async () => {
    await create();
    const id = templateId("guess");
    const go = startOf(await menu(`m:st:${id}:0`))!;
    h.telegram.handlers.set("sendMessage", () => {
      throw new TgError(403, "Forbidden: bot was blocked by the user");
    });
    const refused = await menu(go);
    expect(refused.note).toBe("Telegram did not take the message. Try again later.");
    expect(privateScenes()).toBe(0);
    expect(
      (h.db.raw.query("SELECT uses FROM scene_templates WHERE id = ?").get(id) as { uses: number })
        .uses,
    ).toBe(1);
  });
});
