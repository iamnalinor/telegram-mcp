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
    expect(last("editMessageText")).toMatchObject({
      inline_message_id: "inline-1",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Pizza", callback_data: "cb:0.0" },
            { text: "Sushi", callback_data: "cb:0.1", style: "primary" },
          ],
          [
            { text: "Menu", url: "https://example.com/menu" },
            { text: "Copy", copy_text: { text: "LUNCH-42" } },
          ],
        ],
      },
    });

    const reply = await pressInline(BOB, "cb:0.1");
    expect(reply.method).toBe("answerCallbackQuery");
    expect(reply.text).toContain("Sushi");
    // A press on a message nobody knows changes nothing.
    expect((await pressInline(BOB, "cb:0.0", "inline-unknown")).text).toBeTruthy();

    const read = (await h.tool(alice, "get_guest_call", { call: 1 })).text;
    expect(read).toContain('"@bob" (id 222) pressed "Sushi" (data: fish)');
    expect(read).toMatch(/<tg-[\w-]+>[\s\S]*pressed "Sushi"[\s\S]*<\/tg-[\w-]+>/);
  });

  it("keeps the buttons the next answer leaves out off the message", async () => {
    await call(ALICE, `${BOT} hi`);
    await h.tool(alice, "answer_guest", { call: 1, text: "a", buttons: [[{ text: "X" }]] });
    await h.tool(alice, "answer_guest", { call: 1, text: "b" });
    expect(last("editMessageText").reply_markup).toEqual({ inline_keyboard: [] });
    // The old keyboard is forgotten: a press on it is not recorded.
    await pressInline(BOB, "cb:0.0");
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
    expect(last("editMessageMedia")).toMatchObject({
      inline_message_id: "inline-1",
      media: {
        type: "photo",
        media: "https://example.com/cat.jpg",
        caption: "A <b>cat</b>",
        parse_mode: "HTML",
        has_spoiler: true,
      },
      reply_markup: { inline_keyboard: [[{ text: "More", callback_data: "cb:0.0" }]] },
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
