import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import { Harness, TgError } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const ELSEWHERE = { id: -1005550001111, title: "Friends", type: "supergroup" };
const BOT = "@test_mcp_bot";

const TRIGGER = "trig_01F9YA8ci7HHDqR8LkjEAqLv";
const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

let h: Harness;
let alice: string;
let queries = 0;

beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.say(dm(ALICE), ALICE, `${TRIGGER} ${TOKEN}`);
  h.fires.length = 0;
  h.telegram.handlers.set("answerGuestQuery", () => ({ inline_message_id: "inline-1" }));
  h.telegram.handlers.set("editMessageMedia", () => true);
  h.telegram.handlers.set("editMessageCaption", () => true);
});
afterEach(() => h.restore());

const call = (from: typeof ALICE, text: string) =>
  h.update({
    guest_message: {
      message_id: 5000 + ++queries,
      date: Math.floor(Date.now() / 1000),
      chat: ELSEWHERE,
      from: { ...from, is_bot: false },
      text,
      guest_query_id: `gq-${queries}`,
    },
  });

/** A press on the bot's message for the call, as Telegram sends it for an inline message. */
async function pressInline(
  who: typeof ALICE,
  data: string,
  inline = "inline-1",
): Promise<{ method: string; text?: string; show_alert?: boolean }> {
  const response = await h.update({
    callback_query: {
      id: `q${Math.random()}`,
      from: { ...who, is_bot: false },
      inline_message_id: inline,
      chat_instance: "ci-1",
      data,
    },
  });
  return response.json();
}

const last = (method: string) => h.telegram.called(method).at(-1)!.params;

/** The callback data of a button on the bot's message as it was last drawn by `method`. */
const dataOf = (method: string, row: number, column: number) =>
  (last(method).reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[
    row
  ][column].callback_data;

const count = (sql: string) => (h.db.raw.query(sql).get() as { n: number }).n;

describe("answer_guest: buttons", () => {
  it("puts buttons on the bot's message and records who pressed them", async () => {
    await call(ALICE, `${BOT} lunch?`);
    const answered = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "Pizza or sushi?",
      buttons: [
        [{ text: "Pizza" }, { text: "Sushi", data: "fish", style: "primary" }],
        [
          { text: "Menu", url: "https://example.com/menu" },
          { text: "Copy", copy: "LUNCH-42" },
        ],
      ],
    });
    expect(answered.isError).toBe(false);
    const [pizza, sushi] = [dataOf("editMessageText", 0, 0), dataOf("editMessageText", 0, 1)];
    // Each press names the keyboard it was on: g:<revision>:<row>.<column>.
    expect(pizza).toMatch(/^g:[0-9a-z]+:0\.0$/);
    expect(sushi).toBe(pizza.replace(/0\.0$/, "0.1"));
    expect(last("editMessageText")).toMatchObject({
      inline_message_id: "inline-1",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Pizza", callback_data: pizza },
            { text: "Sushi", callback_data: sushi, style: "primary" },
          ],
          [
            { text: "Menu", url: "https://example.com/menu" },
            { text: "Copy", copy_text: { text: "LUNCH-42" } },
          ],
        ],
      },
    });

    const reply = await pressInline(BOB, sushi);
    expect(reply.method).toBe("answerCallbackQuery");
    expect(reply.text).toContain("Sushi");
    // A press on a message nobody knows changes nothing.
    expect((await pressInline(BOB, pizza, "inline-unknown")).text).toBeTruthy();

    const read = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(read).toContain('"@bob" (id 222) pressed "Sushi" (data: fish)');
    expect(read).toMatch(/<tg-[\w-]+>[\s\S]*pressed "Sushi"[\s\S]*<\/tg-[\w-]+>/);
  });

  it("keeps the buttons the next answer leaves out off the message", async () => {
    await call(ALICE, `${BOT} hi`);
    await h.tool(alice, "answer_guest", { call: 1, text: "a", buttons: [[{ text: "X" }]] });
    const old = dataOf("editMessageText", 0, 0);
    await h.tool(alice, "answer_guest", { call: 1, text: "b" });
    expect(last("editMessageText").reply_markup).toEqual({ inline_keyboard: [] });
    // The old keyboard is forgotten: a press on it is not recorded.
    await pressInline(BOB, old);
    expect((await h.tool(alice, "get_guest_call", { call: 1 })).text).not.toContain("pressed");
  });

  it("refuses a button with two kinds", async () => {
    await call(ALICE, `${BOT} hi`);
    const bad = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "a",
      buttons: [[{ text: "X", url: "https://example.com", copy: "y" }]],
    });
    expect(bad.isError).toBe(true);
  });
});

describe("answer_guest: media", () => {
  it("turns the message into a photo by URL, then edits only its caption", async () => {
    await call(ALICE, `${BOT} show me a cat`);
    const answered = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "A **cat**",
      media: { type: "photo", url: "https://example.com/cat.jpg", spoiler: true },
      buttons: [[{ text: "More" }]],
    });
    expect(answered.isError).toBe(false);
    const more = dataOf("editMessageMedia", 0, 0);
    expect(more).toMatch(/^g:[0-9a-z]+:0\.0$/);
    expect(last("editMessageMedia")).toMatchObject({
      inline_message_id: "inline-1",
      media: {
        type: "photo",
        media: "https://example.com/cat.jpg",
        caption: "A <b>cat</b>",
        parse_mode: "HTML",
        has_spoiler: true,
      },
      reply_markup: {
        inline_keyboard: [[{ text: "More", callback_data: more }]],
      },
    });

    // Text alone now goes to the caption: a media message has no text to edit.
    const again = await h.tool(alice, "answer_guest", { call: 1, text: "Still a cat" });
    expect(again.isError).toBe(false);
    expect(last("editMessageCaption")).toMatchObject({
      inline_message_id: "inline-1",
      caption: "Still a cat",
    });
    expect((await h.tool(alice, "get_guest_call", { call: 1 })).text).toContain("photo");
  });

  it("refuses what a caption cannot carry", async () => {
    await call(ALICE, `${BOT} hi`);
    const media = { type: "document", url: "https://example.com/a.pdf" };
    expect(
      (await h.tool(alice, "answer_guest", { call: 1, text: "x", format: "rich", media })).isError,
    ).toBe(true);
    expect(
      (await h.tool(alice, "answer_guest", { call: 1, text: "x".repeat(1025), media })).isError,
    ).toBe(true);
    expect(h.telegram.called("editMessageMedia")).toHaveLength(0);
  });

  it("says what Telegram refused", async () => {
    await call(ALICE, `${BOT} hi`);
    h.telegram.handlers.set("editMessageMedia", () => {
      throw new TgError(400, "Bad Request: wrong file identifier/HTTP URL specified");
    });
    const failed = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "x",
      media: { type: "video", url: "https://example.com/v.mp4" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("wrong file identifier");
  });
});

const COUNTER = {
  title: "Counter",
  state: { n: 0 },
  view: {
    text: "Count: {n}",
    buttons: [
      [
        { text: "+1", press: "add" },
        { text: "post", press: "post" },
        { text: "psst", press: "psst" },
        { text: "stop", press: "stop" },
      ],
    ],
  },
  rules: [
    { on: "press:add", do: ["n += 1"] },
    { on: "press:post", do: ["post('hello')"] },
    { on: "press:psst", do: ["whisper('only you')"] },
    { on: "press:stop", do: ["finish()"] },
  ],
};

describe("scenes in a chat the bot is not in", () => {
  it("runs a scene on the bot's message for the call", async () => {
    await call(ALICE, `${BOT} let's count`);
    const created = await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("Scene 1");
    const drawn = last("editMessageText");
    expect(drawn.inline_message_id).toBe("inline-1");
    expect(String(drawn.text)).toContain("Count: 0");
    const keyboard = drawn.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const data = keyboard.inline_keyboard[0].map((button) => button.callback_data);

    // Anyone in that chat may press; the scene redraws the same inline message.
    const reply = await pressInline(BOB, data[0]);
    expect(reply.method).toBe("answerCallbackQuery");
    const row = h.db.raw.query("SELECT state FROM scenes WHERE id = 1").get() as { state: string };
    expect(JSON.parse(row.state)).toEqual({ n: 1 });
    await Bun.sleep(1200);
    await pressInline(BOB, data[0]);
    expect(String(last("editMessageText").text)).toContain("Count: 2");
    expect(last("editMessageText").inline_message_id).toBe("inline-1");

    // A press from another inline message does not reach the scene.
    await pressInline(BOB, data[0], "inline-other");
    const after = h.db.raw.query("SELECT state FROM scenes WHERE id = 1").get() as {
      state: string;
    };
    expect(JSON.parse(after.state)).toEqual({ n: 2 });

    // No second message there: a post is refused and shows in get_scene.
    await pressInline(BOB, data[1]);
    expect(h.telegram.called("sendMessage").filter((c) => c.params.text === "hello")).toHaveLength(
      0,
    );
    expect((await h.tool(alice, "get_scene", { scene: 1 })).text).toContain("only its one message");

    // A whisper is an ephemeral reply to the press, with no chat named.
    await pressInline(BOB, data[2]);
    const whisper = last("sendMessage");
    expect(whisper.text).toBe("only you");
    expect(whisper.chat_id).toBeUndefined();
    const ephemeral = whisper.ephemeral_message_parameters as { callback_query_id?: string };
    expect(ephemeral.callback_query_id).toMatch(/^q/);

    // While it runs, answer_guest leaves the message to it.
    const blocked = await h.tool(alice, "answer_guest", { call: 1, text: "hi" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("scene 1");
    expect((await h.tool(alice, "get_guest_call", { call: 1 })).text).toContain("scene 1");

    await Bun.sleep(1100);
    await pressInline(BOB, data[3]);
    expect(last("editMessageText").reply_markup).toEqual({ inline_keyboard: [] });
    // Once it is over, the message is answer_guest's again.
    expect((await h.tool(alice, "answer_guest", { call: 1, text: "done" })).isError).toBe(false);
  });

  it("refuses a second scene on the same call, and a call with a chat", async () => {
    await call(ALICE, `${BOT} go`);
    expect(
      (await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1, chat: "me" }))
        .isError,
    ).toBe(true);
    expect(
      (await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 })).isError,
    ).toBe(false);
    const again = await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("scene 1");
  });

  it("finishes when the message is gone", async () => {
    await call(ALICE, `${BOT} go`);
    await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    const data = (
      last("editMessageText").reply_markup as { inline_keyboard: { callback_data: string }[][] }
    ).inline_keyboard[0][0].callback_data;
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(400, "Bad Request: message to edit not found");
    });
    await Bun.sleep(1100);
    await pressInline(BOB, data);
    const row = h.db.raw.query("SELECT status FROM scenes WHERE id = 1").get() as {
      status: string;
    };
    expect(row.status).toBe("finished");
  });
});

describe("guest presses: stale keyboards and odd presses", () => {
  it("counts a press on an older keyboard for nothing once the buttons changed", async () => {
    await call(ALICE, `${BOT} vote`);
    await h.tool(alice, "answer_guest", {
      call: 1,
      text: "Ban him?",
      buttons: [[{ text: "Keep" }, { text: "Ban" }]],
    });
    const oldBan = dataOf("editMessageText", 0, 1);
    await h.tool(alice, "answer_guest", {
      call: 1,
      text: "Lunch?",
      buttons: [[{ text: "Pizza" }, { text: "Sushi" }]],
    });
    const sushi = dataOf("editMessageText", 0, 1);
    expect(sushi).not.toBe(oldBan);

    // The old "Ban" sits where "Sushi" is now: it must not count as "Sushi".
    const stale = await pressInline(BOB, oldBan);
    expect(stale.text).toContain("out of date");
    expect(count("SELECT COUNT(*) AS n FROM button_presses")).toBe(0);

    expect((await pressInline(BOB, sushi)).text).toContain("Sushi");
    const read = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(read).toContain('pressed "Sushi"');
    expect(read).not.toContain('pressed "Ban"');
  });

  it("records nothing for a guest button pressed without its inline message", async () => {
    await call(ALICE, `${BOT} hi`);
    await h.tool(alice, "answer_guest", { call: 1, text: "a", buttons: [[{ text: "X" }]] });
    const data = dataOf("editMessageText", 0, 0);
    // The same data, but as from a message in a chat: not the guest call's.
    const response = await h.update({
      callback_query: {
        id: "q-msg",
        from: { ...BOB, is_bot: false },
        message: { message_id: 1, date: 1, chat: ELSEWHERE },
        chat_instance: "ci-1",
        data,
      },
    });
    expect((await response.json<{ method: string }>()).method).toBe("answerCallbackQuery");
    // The old format on the inline message is no press either.
    await pressInline(BOB, "cb:0.0");
    expect(count("SELECT COUNT(*) AS n FROM button_presses")).toBe(0);
  });

  it("keeps at most so many presses per call, and shows the latest with the total", async () => {
    await call(ALICE, `${BOT} hi`);
    await h.tool(alice, "answer_guest", { call: 1, text: "a", buttons: [[{ text: "X" }]] });
    const key = (
      h.db.raw.query("SELECT chat_key FROM guest_calls WHERE id = 1").get() as {
        chat_key: number;
      }
    ).chat_key;
    const insert = h.db.raw.prepare(
      `INSERT INTO button_presses (chat_id, message_id, callback_id, user_id, user_name, label, data, date)
       VALUES (?, 1, ?, 222, '@bob', 'X', 'X', ?)`,
    );
    for (let i = 0; i < 200; i++) insert.run(key, `old-${i}`, 1000 + i);
    expect((await pressInline(BOB, dataOf("editMessageText", 0, 0))).method).toBe(
      "answerCallbackQuery",
    );
    expect(count("SELECT COUNT(*) AS n FROM button_presses")).toBe(200);
    const read = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(read).toContain("200 presses");
    expect(read.match(/pressed "X"/g)?.length).toBeLessThan(200);
  });
});

describe("answer_guest: what may go on a public message", () => {
  it("takes only https links and media", async () => {
    await call(ALICE, `${BOT} hi`);
    const link = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "a",
      buttons: [[{ text: "Go", url: "http://example.com" }]],
    });
    expect(link.isError).toBe(true);
    const media = await h.tool(alice, "answer_guest", {
      call: 1,
      text: "a",
      media: { type: "photo", url: "http://example.com/a.jpg" },
    });
    expect(media.isError).toBe(true);
    expect(h.telegram.called("editMessageMedia")).toHaveLength(0);
  });

  it("puts no links, copy buttons or media on a third party's call", async () => {
    await call(ALICE, `${BOT} hi`);
    h.db.raw.exec("UPDATE claude_chats SET others = 1");
    await call(BOB, `${BOT} help me`);
    const byOther = (
      h.db.raw.query("SELECT by_other FROM guest_calls WHERE id = 2").get() as {
        by_other: number;
      }
    ).by_other;
    expect(byOther).toBe(1);
    const edits = h.telegram.called("editMessageText").length;
    for (const extra of [
      { buttons: [[{ text: "Go", url: "https://example.com" }]] },
      { buttons: [[{ text: "Copy", copy: "x" }]] },
      { media: { type: "photo", url: "https://example.com/a.jpg" } },
    ]) {
      const refused = await h.tool(alice, "answer_guest", { call: 2, text: "a", ...extra });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not the user");
    }
    expect(h.telegram.called("editMessageText")).toHaveLength(edits);
    expect(h.telegram.called("editMessageMedia")).toHaveLength(0);
    // Plain buttons are fine, and the user's own call may carry links.
    expect(
      (await h.tool(alice, "answer_guest", { call: 2, text: "a", buttons: [[{ text: "Ok" }]] }))
        .isError,
    ).toBe(false);
    expect(
      (
        await h.tool(alice, "answer_guest", {
          call: 1,
          text: "a",
          buttons: [[{ text: "Go", url: "https://example.com" }]],
        })
      ).isError,
    ).toBe(false);
  });
});

describe("scenes on a guest call's message: edges", () => {
  it("refuses a scene on a message that became media, and keeps its buttons", async () => {
    await call(ALICE, `${BOT} cat`);
    await h.tool(alice, "answer_guest", {
      call: 1,
      text: "cat",
      media: { type: "photo", url: "https://example.com/cat.jpg" },
      buttons: [[{ text: "More" }]],
    });
    const refused = await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("photo");
    expect(count("SELECT COUNT(*) AS n FROM scenes")).toBe(0);
    expect(
      h.db.raw.query("SELECT scene_id, buttons IS NOT NULL AS kept FROM guest_calls").get(),
    ).toEqual({ scene_id: null, kept: 1 });
  });

  it("gives the message its buttons back when Telegram refuses the scene", async () => {
    await call(ALICE, `${BOT} go`);
    await h.tool(alice, "answer_guest", { call: 1, text: "a", buttons: [[{ text: "X" }]] });
    const x = dataOf("editMessageText", 0, 0);
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(400, "Bad Request: something went wrong");
    });
    const failed = await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    expect(failed.isError).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM scenes")).toBe(0);
    expect(
      h.db.raw.query("SELECT scene_id, buttons IS NOT NULL AS kept FROM guest_calls").get(),
    ).toEqual({ scene_id: null, kept: 1 });
    expect((await pressInline(BOB, x)).text).toContain("X");
  });

  it("knows its message before the first press can come", async () => {
    await call(ALICE, `${BOT} go`);
    let seen: unknown = null;
    h.telegram.handlers.set("editMessageText", () => {
      seen = h.db.raw.query("SELECT messages FROM scenes WHERE id = 1").get();
      return true;
    });
    await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    expect(seen).toEqual({ messages: JSON.stringify([{ id: 0, view: "main" }]) });
  });

  it("lets an answer take over from a finished scene whose last drawing is owed", async () => {
    await call(ALICE, `${BOT} go`);
    await h.tool(alice, "answer_guest", { call: 1, text: "before the scene" });
    await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    // get_guest_call says what the message shows: the scene, not the old answer.
    const during = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(during).not.toContain("before the scene");
    expect(during).toContain("scene 1");

    // It ended while Telegram asked for quiet: taking its buttons off is owed.
    h.db.raw.exec("UPDATE scenes SET status = 'finished', dirty = 1");
    h.telegram.handlers.set("editMessageText", () => {
      throw new TgError(429, "Too Many Requests: retry after 5", { retry_after: 5 });
    });
    expect((await h.tool(alice, "answer_guest", { call: 1, text: "x" })).isError).toBe(true);
    // A failed answer leaves the owed drawing owed.
    expect(count("SELECT dirty AS n FROM scenes WHERE id = 1")).toBe(1);

    h.telegram.handlers.set("editMessageText", () => true);
    expect((await h.tool(alice, "answer_guest", { call: 1, text: "the answer" })).isError).toBe(
      false,
    );
    // The answer replaced the whole message: nothing owed may draw over it.
    expect(count("SELECT dirty AS n FROM scenes WHERE id = 1")).toBe(0);
    const after = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(after).toContain("the answer");
    expect(after).not.toContain("runs scene");
  });

  it("takes a scene's buttons off when the user lets the chat go", async () => {
    await call(ALICE, `${BOT} go`);
    await h.tool(alice, "create_scene", { definition: COUNTER, guest_call: 1 });
    await Bun.sleep(1100);
    await h.update({
      callback_query: {
        id: "q-menu",
        from: { ...ALICE, is_bot: false },
        data: "m:qx:1",
        message: { message_id: 77, date: 1, chat: dm(ALICE) },
      },
    });
    expect(h.db.raw.query("SELECT status, dirty FROM scenes WHERE id = 1").get()).toEqual({
      status: "finished",
      dirty: 0,
    });
    const off = h.telegram
      .called("editMessageText")
      .filter((c) => c.params.inline_message_id === "inline-1")
      .at(-1)!.params;
    expect(off.reply_markup).toEqual({ inline_keyboard: [] });
  });
});
