import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming, startScene } from "../src/bot/scenes";
import { loadConfig } from "../src/env";
import { compile } from "../src/scenes/definition";
import { Store } from "../src/store";
import { TelegramApi } from "../src/telegram/api";
import { Harness, TgError } from "./harness";
import { TICTACTOE, TRIAGE } from "./scenes-fixtures";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", language_code: "en" };
const CAROL = { id: 333, first_name: "Carol", language_code: "ru" };
const TEAM = { id: -1001234567890, title: "Team chat", type: "supergroup" };

let h: Harness;
beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.addBot(TEAM, ALICE);
});
afterEach(() => h.restore());

/** A scene in the team chat owned by Alice; returns its id and its message's id. */
async function scene(definition: unknown): Promise<{ id: number; message: number }> {
  const store = new Store(h.db.asD1());
  const { compiled, state } = compile(definition);
  const { id, message } = await startScene(
    {
      api: new TelegramApi("1:x"),
      store,
      bot: { id: 123456, username: "test_mcp_bot", canReadAll: true },
      config: await loadConfig(h.env),
    },
    {
      chatId: TEAM.id,
      threadId: null,
      owner: ALICE.id,
      session: null,
      agent: null,
      compiled,
      state,
    },
  );
  return { id, message: message.message_id };
}

type Who = { id: number; first_name: string; language_code?: string };

async function press(
  who: Who,
  at: { id: number; message: number },
  name: string,
  arg?: unknown,
  data?: string,
): Promise<{ text?: string; show_alert?: boolean; method: string }> {
  const response = await h.update({
    callback_query: {
      id: `q${Math.random()}`,
      from: { ...who, is_bot: false },
      data: data ?? `s:${at.id}:${name}${arg === undefined ? "" : `:${JSON.stringify(arg)}`}`,
      message: { message_id: at.message, date: 1, chat: TEAM },
    },
  });
  return response.json();
}

const row = (id: number) =>
  h.db.raw.query("SELECT * FROM scenes WHERE id = ?").get(id) as {
    state: string;
    version: number;
    status: string;
    dirty: number;
    quiet_until: number;
  };
const state = (id: number) => JSON.parse(row(id).state) as Record<string, unknown>;
const edits = (message: number) =>
  h.telegram.called("editMessageText").filter((call) => call.params.message_id === message);

const COUNTER = {
  title: "Counter",
  state: { n: 0, same: 1, pad: "p".repeat(3000) },
  view: {
    text: "n = {n}",
    buttons: [
      [
        { text: "+1", press: "add" },
        { text: "same", press: "same" },
        { text: "never", press: "never" },
        { text: "bad", press: "bad" },
        { text: "grow", press: "grow" },
        { text: "hi", press: "hi" },
        { text: "pop", press: "pop" },
      ],
    ],
  },
  rules: [
    { on: "press:add", do: ["n += 1"] },
    { on: "press:same", do: ["same = 1"] },
    { on: "press:never", when: "false", do: ["n = 0"] },
    { on: "press:bad", do: ["n = n * 'x'"] },
    { on: "press:grow", do: ["n = pad + pad + pad"] },
    { on: "press:hi", do: ["toast('hi ' + user.name)"] },
    { on: "press:pop", do: ["alert('boo')", "finish()"] },
  ],
};

describe("sending a scene", () => {
  it("draws the first message with the scene's buttons and keeps it", async () => {
    const at = await scene(TICTACTOE);
    const sent = h.telegram.called("sendMessage").at(-1)!.params;
    expect(sent.chat_id).toBe(TEAM.id);
    expect(String(sent.text)).toContain("<b>Крестики-нолики</b>");
    const keyboard = (sent.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(keyboard[0][0].callback_data).toBe(`s:${at.id}:cell:0`);
    const stored = h.db.raw
      .query("SELECT outgoing, sent_by FROM messages WHERE chat_id = ? AND message_id = ?")
      .get(TEAM.id, at.message) as { outgoing: number; sent_by: number };
    expect(stored).toEqual({ outgoing: 1, sent_by: ALICE.id });
  });
});

describe("answers to a press", () => {
  // Each row of the spec's table, in English and Russian.
  const cases: [string, (lang: string) => Promise<{ text?: string }>, string, string][] = [
    [
      "no rule",
      async (lang) => press({ ...BOB, language_code: lang }, await scene(COUNTER), "never"),
      "Not now.",
      "Сейчас нельзя.",
    ],
    [
      "only for the owner",
      async (lang) =>
        press({ ...BOB, language_code: lang }, await scene(TRIAGE), "mark", [0, "fix"]),
      "This button is only for @alice.",
      "Эта кнопка только для @alice.",
    ],
    [
      "nobody to wake",
      async (lang) => {
        const at = await scene(TRIAGE);
        for (const i of [0, 1, 2]) await press(ALICE, at, "mark", [i, "fix"]);
        return press({ ...ALICE, language_code: lang }, at, "done");
      },
      "Nobody to answer right now: no assistant is connected.",
      "Сейчас некому ответить: ассистент не подключён.",
    ],
    [
      "out of date",
      async (lang) => press({ ...BOB, language_code: lang }, await scene(COUNTER), "add", 5),
      "This button is out of date.",
      "Кнопка устарела.",
    ],
    [
      "over",
      async (lang) => {
        const at = await scene(COUNTER);
        await press(BOB, at, "pop");
        return press({ ...BOB, language_code: lang }, at, "add");
      },
      "This scene is over.",
      "Сцена завершена.",
    ],
    [
      "full",
      async (lang) => press({ ...BOB, language_code: lang }, await scene(COUNTER), "grow"),
      "The scene is full: nothing more fits.",
      "Сцена заполнена: больше не помещается.",
    ],
    [
      "failed",
      async (lang) => press({ ...BOB, language_code: lang }, await scene(COUNTER), "bad"),
      "That did not work. Try again.",
      "Не получилось, попробуй ещё раз.",
    ],
  ];
  for (const [name, act, en, ru] of cases) {
    it(`${name}, in both languages`, async () => {
      expect((await act("en")).text).toBe(en);
      expect((await act("ru")).text).toBe(ru);
    });
  }

  it("a rule that applied answers with its toast or alert, or with nothing", async () => {
    const at = await scene(COUNTER);
    const plain = await press(BOB, at, "add");
    expect(plain.method).toBe("answerCallbackQuery");
    expect(plain.text).toBeUndefined();
    expect((await press(BOB, at, "hi")).text).toBe("hi Bob");
    expect(await press(BOB, at, "pop")).toMatchObject({ text: "boo", show_alert: true });
    expect(h.telegram.called("answerCallbackQuery")).toHaveLength(0);
  });

  it("a refusal says the rule's own words", async () => {
    const at = await scene(TICTACTOE);
    await press(BOB, at, "cell", 0);
    expect((await press(CAROL, at, "cell", 0)).text).toBe("Занято");
  });

  it("too many presses at once: not so fast, in both languages", async () => {
    h.restore();
    h = new Harness({
      SCENE_LIMIT: { limit: () => Promise.resolve({ success: false }) } as unknown as RateLimit,
    });
    await h.addBot(TEAM, ALICE);
    const at = await scene(COUNTER);
    expect((await press(BOB, at, "add")).text).toBe("Not so fast.");
    expect((await press(CAROL, at, "add")).text).toBe("Не так быстро.");
    expect(state(at.id).n).toBe(0);
  });
});

describe("what a press may not do", () => {
  it("a forged callback for a button that is not shown changes nothing", async () => {
    const at = await scene(TICTACTOE);
    const before = row(at.id).version;
    for (const data of [
      `s:${at.id}:cell:9`,
      `s:${at.id}:cell:"0"`,
      `s:${at.id}:win`,
      `s:${at.id + 1}:cell:0`,
      `s:${at.id}:cell:{oops`,
    ]) {
      const answer = await press(BOB, at, "", undefined, data);
      expect(String(answer.text)).toMatch(/out of date|over/);
    }
    expect(row(at.id).version).toBe(before);
  });

  it("a press on a keyboard from before the state changed is out of date", async () => {
    const at = await scene({
      title: "steps",
      state: { step: 1 },
      view: {
        text: "step {step}",
        buttons: [
          [{ text: "one", press: "one", show: "step == 1" }],
          [{ text: "two", press: "two", show: "step == 2" }],
        ],
      },
      rules: [
        { on: "press:one", do: ["step = 2"] },
        { on: "press:two", do: ["step = 3"] },
      ],
    });
    await press(BOB, at, "one");
    expect(state(at.id).step).toBe(2);
    expect((await press(BOB, at, "one")).text).toBe("This button is out of date.");
    expect(state(at.id).step).toBe(2);
  });

  it("a press on another message of the chat is out of date", async () => {
    const at = await scene(COUNTER);
    expect((await press(BOB, { id: at.id, message: at.message + 50 }, "add")).text).toBe(
      "This button is out of date.",
    );
  });

  it("a press that changes nothing writes no row", async () => {
    const at = await scene(COUNTER);
    const before = row(at.id).version;
    await press(BOB, at, "same");
    await press(BOB, at, "hi");
    expect(row(at.id).version).toBe(before);
  });
});

describe("concurrency and edits", () => {
  it("two presses on the same version both land", async () => {
    const at = await scene(COUNTER);
    const answers = await Promise.all([press(BOB, at, "add"), press(CAROL, at, "add")]);
    const failed = answers.filter((a) => a.text === "That did not work. Try again.").length;
    // Never a lost write: every press that was not refused is counted.
    expect(state(at.id).n).toBe(2 - failed);
    expect(failed).toBe(0);
  });

  it("a burst of five presses edits at most twice and ends with the final state drawn", async () => {
    sceneTiming.redrawDelayMs = 1200;
    const at = await scene(COUNTER);
    h.db.raw.exec(`UPDATE scenes SET edited_at = 0 WHERE id = ${at.id}`);
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        new Promise((resolve) => setTimeout(resolve, i * 60)).then(() => press(BOB, at, "add")),
      ),
    );
    await Promise.allSettled(h.waits);
    expect(state(at.id).n).toBe(5);
    const made = edits(at.message);
    expect(made.length).toBeLessThanOrEqual(2);
    expect(String(made.at(-1)!.params.text)).toBe("n = 5");
  });

  it("429 on an edit keeps the state and redraws on the next press", async () => {
    const at = await scene(COUNTER);
    h.db.raw.exec(`UPDATE scenes SET edited_at = 0 WHERE id = ${at.id}`);
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(429, "Too Many Requests: retry after 7", { retry_after: 7 });
    });
    await press(BOB, at, "add");
    expect(state(at.id).n).toBe(1);
    expect(row(at.id).dirty).toBe(1);
    expect(row(at.id).quiet_until).toBeGreaterThan(Date.now() + 5000);

    h.telegram.handlers.set("editMessageText", () => true);
    h.db.raw.exec(`UPDATE scenes SET quiet_until = 0, edited_at = 0 WHERE id = ${at.id}`);
    await press(BOB, at, "add");
    expect(String(edits(at.message).at(-1)!.params.text)).toBe("n = 2");
  });

  it("a deleted message finishes the scene", async () => {
    const at = await scene(COUNTER);
    h.db.raw.exec(`UPDATE scenes SET edited_at = 0 WHERE id = ${at.id}`);
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(400, "Bad Request: message to edit not found");
    });
    await press(BOB, at, "add");
    expect(row(at.id).status).toBe("finished");
    expect((await press(BOB, at, "add")).text).toBe("This scene is over.");
  });

  it("finishing removes the keyboard", async () => {
    const at = await scene(COUNTER);
    h.db.raw.exec(`UPDATE scenes SET edited_at = 0 WHERE id = ${at.id}`);
    await press(BOB, at, "pop");
    expect(edits(at.message).at(-1)!.params.reply_markup).toEqual({ inline_keyboard: [] });
  });
});
