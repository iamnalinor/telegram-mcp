import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };
const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
const SESSION = "session_01Svopn2AB4YoGuZVfSMUKGR";

/** A game with a button that calls the assistant: the rest of it must not need one. */
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

beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.addBot(TEAM, ALICE);
  h.fires.length = 0;
});
afterEach(() => h.restore());

async function create(extra: Record<string, unknown> = {}) {
  const result = await h.tool(alice, "create_scene", { chat: TEAM.id, definition: GAME, ...extra });
  return {
    id: Number(/Scene (\d+)/.exec(result.text)![1]),
    message: Number(/as #(\d+)/.exec(result.text)![1]),
    text: result.text,
  };
}

async function press(
  who: typeof ALICE,
  at: { id: number; message: number },
  name: string,
  chat: { id: number; type: string } = TEAM,
) {
  const response = await h.update({
    callback_query: {
      id: `q${Math.random()}`,
      from: { ...who, is_bot: false },
      data: `s:${at.id}:${name}`,
      message: { message_id: at.message, date: 1, chat },
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

/** Open a saved scene's card and press its ▶, as the user would. */
async function startSaved(id: number, page = 0) {
  const card = await menu(`m:st:${id}:${page}`);
  const go = card.buttons.find((b) => b.callback_data?.startsWith("m:sgo:"));
  if (!go) throw new Error(`no ▶ on the card: ${card.text}`);
  return menu(go.callback_data!);
}

const sceneRow = (id: number) =>
  h.db.raw.query("SELECT * FROM scenes WHERE id = ?").get(id) as {
    status: string;
    state: string;
    owner: number;
    chat_id: number;
    session_id: string | null;
    template_id: number | null;
    messages: string;
  } | null;
const templateId = (name: string) =>
  (
    h.db.raw.query("SELECT id FROM scene_templates WHERE name = ?").get(name) as {
      id: number;
    } | null
  )?.id ?? null;

describe("a scene without an assistant to wake", () => {
  it("runs a waking rule all the same, and says nobody was woken", async () => {
    const at = await create();
    expect(at.text).toContain("wake() rules still run");
    const answer = await press(ALICE, at, "hint");
    expect(answer.text).toBe("No assistant is connected, so nobody was woken.");
    expect(JSON.parse(sceneRow(at.id)!.state)).toEqual({ n: 0, asked: 1 });
    const events = h.db.raw.query("SELECT name, woke FROM scene_events").all();
    expect(events).toEqual([{ name: "hint", woke: 0 }]);
    expect(h.fires).toHaveLength(0);
    expect(h.db.raw.query("SELECT COUNT(*) AS n FROM fires").get()).toEqual({ n: 0 });
  });

  it("answers in the presser's language, after the rule's own words", async () => {
    const at = await create({
      definition: {
        ...GAME,
        rules: [{ on: "press:hint", do: ["toast('Asked')", "wake('hint')"] }],
      },
    });
    const answer = await press({ ...ALICE, language_code: "ru" }, at, "hint");
    expect(answer.text).toBe("Asked\nАссистент не подключён — будить некого.");
  });

  it("an act from a client that names no session runs without waking", async () => {
    const at = await create();
    const result = await h.tool(alice, "update_scene", { scene: at.id, act: { name: "hint" } });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("act:hint applied.");
    expect(result.text).toContain("nobody was woken");
    expect(JSON.parse(sceneRow(at.id)!.state)).toEqual({ n: 0, asked: 1 });
  });

  it("an act without a session on a scene that has one is still refused", async () => {
    const at = await create({ session: SESSION });
    const result = await h.tool(alice, "update_scene", { scene: at.id, act: { name: "hint" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("runs only from that session");
  });

  it("with a routine set up, the wake still starts a session", async () => {
    await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
    h.fires.length = 0;
    const at = await create();
    expect((await press(ALICE, at, "hint")).text).toBeUndefined();
    expect(h.fires).toHaveLength(1);
  });

  it("a third party's wake where the chat does not allow them is still refused", async () => {
    const at = await create();
    expect((await press(BOB, at, "hint")).text).toBe("This button is only for @alice.");
    expect(JSON.parse(sceneRow(at.id)!.state)).toEqual({ n: 0, asked: 0 });
  });

  it("/disconnect signs assistants out but leaves the user's scenes running", async () => {
    const at = await create();
    const reply = (await h.say(dm(ALICE), ALICE, "/disconnect"))._reply as { text: string };
    expect(reply.text).toContain("Your scenes keep running");
    expect(sceneRow(at.id)!.status).toBe("active");
    expect((await press(BOB, at, "guess")).text).toBe("Guess 1");
  });
});

describe("the 🎬 Scenes menu", () => {
  it("is on the main screen, and lists running and saved scenes", async () => {
    const main = await menu("m:main");
    expect(main.buttons.find((b) => b.callback_data === "m:scn")!.text).toBe("🎬 Scenes");

    const empty = await menu("m:scn");
    expect(empty.text).toContain("None running.");
    expect(empty.text).toContain("No saved scenes yet");

    const at = await create();
    const hub = await menu("m:scn");
    expect(hub.text).toContain("▶ Guess — Team chat");
    expect(hub.buttons.map((b) => b.callback_data)).toContain(`m:sv:${at.id}`);
    expect(hub.buttons.find((b) => b.callback_data === "m:sl:0")!.text).toBe("📚 Saved scenes (1)");

    const saved = await menu("m:sl:0");
    expect(saved.text).toContain("<code>guess</code> — Guess");
    expect(saved.buttons.map((b) => b.callback_data)).toContain(`m:st:${templateId("guess")}:0`);
  });

  it("starts a saved scene in the private chat, owned by the user, with no session", async () => {
    await create();
    const id = templateId("guess")!;
    const card = await menu(`m:st:${id}:0`);
    expect(card.text).toContain("Guess");
    expect(card.text).toContain("A guessing game");
    expect(card.buttons.map((b) => b.callback_data)).toEqual([
      `m:sgo:${id}:1:1:0`,
      `m:sdel:${id}:0`,
      "m:sl:0",
    ]);

    const started = await menu(`m:sgo:${id}:1:1:0`);
    expect(started.note).toBe("Started: it is in this chat now.");
    const sent = h.telegram.called("sendMessage").at(-1)!;
    expect(sent.params.chat_id).toBe(ALICE.id);
    expect(sent.params.text).toBe("Guesses: 0");
    const row = h.db.raw
      .query("SELECT id FROM scenes WHERE chat_id = ? ORDER BY id DESC")
      .get(ALICE.id) as { id: number };
    const scene = sceneRow(row.id)!;
    expect(scene).toMatchObject({ owner: ALICE.id, session_id: null, template_id: id });
    expect(
      (h.db.raw.query("SELECT uses FROM scene_templates WHERE id = ?").get(id) as { uses: number })
        .uses,
    ).toBe(2);
    expect(started.text).toContain("▶ Guess — your private chat");

    // It plays like any scene, and its waking rule runs without an assistant.
    const at = { id: row.id, message: (JSON.parse(scene.messages) as { id: number }[])[0].id };
    expect((await press(ALICE, at, "guess", dm(ALICE))).text).toBe("Guess 1");
    expect((await press(ALICE, at, "hint", dm(ALICE))).text).toBe(
      "No assistant is connected, so nobody was woken.",
    );
    expect(JSON.parse(sceneRow(row.id)!.state)).toEqual({ n: 1, asked: 1 });
  });

  it("works after every assistant signed out", async () => {
    await create();
    await h.say(dm(ALICE), ALICE, "/disconnect");
    const started = await startSaved(templateId("guess")!);
    expect(started.note).toBe("Started: it is in this chat now.");
  });

  it("stops a running scene from the list", async () => {
    const at = await create();
    const screen = await menu(`m:sv:${at.id}`);
    expect(screen.buttons.map((b) => b.callback_data)).toContain(`m:ss:${at.id}`);
    const stopped = await menu(`m:ss:${at.id}`);
    expect(stopped.note).toBe("Stopped: the buttons are gone.");
    expect(sceneRow(at.id)!.status).toBe("finished");
  });

  it("deletes a saved scene after asking; running scenes go on", async () => {
    const at = await create();
    const id = templateId("guess")!;
    const ask = await menu(`m:sdel:${id}`);
    expect(ask.text).toContain("Delete the saved scene «guess» and its earlier versions?");
    const done = await menu(`m:sdely:${id}`);
    expect(done.note).toBe("Deleted.");
    expect(templateId("guess")).toBeNull();
    expect(sceneRow(at.id)!.status).toBe("active");
  });

  it("does not reach someone else's saved scenes", async () => {
    await create();
    const id = templateId("guess")!;
    h.markConnected(BOB);
    await h.say(dm(BOB), BOB, "/start");
    const sends = h.telegram.called("sendMessage").length;
    for (const data of [`m:st:${id}`, `m:sgo:${id}`, `m:sdely:${id}`]) {
      const screen = await menu(data, BOB);
      expect(screen.note).toBe("That is gone already.");
    }
    expect(h.telegram.called("sendMessage")).toHaveLength(sends);
    expect(templateId("guess")).toBe(id);
  });

  it("refuses a saved scene that no longer compiles, and a full chat", async () => {
    await create();
    const id = templateId("guess")!;
    const card = await menu(`m:st:${id}:0`);
    const go = card.buttons.find((b) => b.callback_data?.startsWith("m:sgo:"))!.callback_data!;
    h.db.raw
      .query("UPDATE scene_templates SET definition = ? WHERE id = ?")
      .run(JSON.stringify({ title: "Broken" }), id);
    const broken = await menu(go);
    expect(broken.note).toContain("cannot start");
    // The card shown again says so, and has no ▶.
    expect(broken.text).toContain("no longer checks out");
    expect(broken.buttons.some((b) => b.callback_data?.startsWith("m:sgo:"))).toBe(false);

    h.db.raw
      .query("UPDATE scene_templates SET definition = ? WHERE id = ?")
      .run(JSON.stringify(GAME), id);
    for (let i = 0; i < 20; i++) await startSaved(id);
    const full = await startSaved(id);
    expect(full.note).toContain("20 scenes running");
  });

  it("speaks Russian", async () => {
    await create();
    const hub = await menu("m:scn", { id: ALICE.id, language_code: "ru" });
    expect(hub.text).toContain("Сцены");
    expect(hub.buttons.find((b) => b.callback_data === "m:sl:0")!.text).toBe(
      "📚 Сохранённые сцены (1)",
    );
  });
});
