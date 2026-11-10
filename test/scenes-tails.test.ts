import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sceneTiming } from "../src/bot/scenes";
import worker from "../src/index";
import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });
const TEAM = { id: -1001234567890, title: "Team chat", type: "group" };
const SUPER = -1009999999999;

const COUNTER = {
  title: "Counter",
  state: { n: 0, said: [] },
  view: { text: "n = {n}", buttons: [[{ text: "+1", press: "add" }]] },
  rules: [
    { on: "press:add", do: ["n += 1"] },
    { on: "reply", do: ["said += event.text"] },
  ],
};

let h: Harness;
let alice: string;
let scene: { id: number; message: number };

beforeEach(async () => {
  sceneTiming.redrawDelayMs = 20;
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
  await h.addBot(TEAM, ALICE);
  const result = await h.tool(alice, "create_scene", { chat: TEAM.id, definition: COUNTER });
  scene = {
    id: Number(/Scene (\d+)/.exec(result.text)![1]),
    message: Number(/as #(\d+)/.exec(result.text)![1]),
  };
});
afterEach(() => h.restore());

const status = () =>
  (
    h.db.raw.query("SELECT status FROM scenes WHERE id = ?").get(scene.id) as {
      status: string;
    } | null
  )?.status ?? null;
const count = (table: string) =>
  (h.db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function daily() {
  await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now(), noRetry() {} }, h.env);
}

async function press(chatId: number) {
  const response = await h.update({
    callback_query: {
      id: `q${Math.random()}`,
      from: { ...BOB, is_bot: false },
      data: `s:${scene.id}:add`,
      message: { message_id: scene.message, date: 1, chat: { id: chatId, type: "supergroup" } },
    },
  });
  return response.json<{ text?: string }>();
}

describe("a scene's tails", () => {
  it("an idle scene is finished, then deleted, by the daily cleanup", async () => {
    await press(TEAM.id);
    h.db.raw
      .query("INSERT INTO scene_events (scene_id, seq, name, date) VALUES (?, 1, 'x', 1)")
      .run(scene.id);
    await daily();
    expect(status()).toBe("active"); // touched today

    h.db.raw.exec(`UPDATE scenes SET updated = updated - 15 * 86400`);
    await daily();
    expect(status()).toBe("finished");
    expect(h.telegram.called("editMessageText").at(-1)!.params.reply_markup).toEqual({
      inline_keyboard: [],
    });

    h.db.raw.exec(`UPDATE scenes SET updated = updated - 15 * 86400`);
    await daily();
    expect(status()).toBeNull();
    expect(count("scene_links")).toBe(0);
    expect(count("scene_events")).toBe(0);
  });

  it("a migrated group keeps its scenes", async () => {
    await h.update({
      message: {
        message_id: 900,
        date: Math.floor(Date.now() / 1000),
        chat: TEAM,
        from: { ...ALICE, is_bot: false },
        migrate_to_chat_id: SUPER,
      },
    });
    const row = h.db.raw.query("SELECT chat_id FROM scenes").get() as { chat_id: number };
    expect(row.chat_id).toBe(SUPER);
    // Presses come from the new chat now; replies find the scene by its new key.
    expect((await press(SUPER)).text).toBeUndefined();
    await h.say({ id: SUPER, type: "supergroup", title: "Team chat" }, BOB, "hello", {
      reply_to_message: {
        message_id: scene.message,
        date: 1,
        chat: { id: SUPER, type: "supergroup" },
        from: { id: 123456, is_bot: true, first_name: "Test" },
        text: "n = 1",
      },
    });
    const state = JSON.parse(
      (h.db.raw.query("SELECT state FROM scenes").get() as { state: string }).state,
    ) as { n: number; said: string[] };
    expect(state).toEqual({ n: 1, said: ["hello"] });
  });

  it("leaving a group ends the scenes there", async () => {
    await h.say(TEAM, ALICE, "", {
      left_chat_member: { ...ALICE, is_bot: false },
    });
    // Her scene ends with her access; the daily cleanup deletes it a retention later.
    expect(status()).toBe("finished");

    // The same where others keep access to the group.
    h.restore();
    h = new Harness();
    await h.say(dm(ALICE), ALICE, "/start");
    alice = (await h.connect(ALICE)).access_token;
    await h.addBot(TEAM, ALICE);
    h.markConnected(BOB);
    await h.say(TEAM, BOB, "/connect");
    const result = await h.tool(alice, "create_scene", { chat: TEAM.id, definition: COUNTER });
    scene = {
      id: Number(/Scene (\d+)/.exec(result.text)![1]),
      message: Number(/as #(\d+)/.exec(result.text)![1]),
    };
    await h.say(TEAM, ALICE, "", { left_chat_member: { ...ALICE, is_bot: false } });
    expect(status()).toBe("finished");
    expect((await press(TEAM.id)).text).toBe("This scene is over.");
  });

  it("the bot leaving the group deletes its scenes", async () => {
    await h.update({
      my_chat_member: {
        chat: TEAM,
        from: { ...ALICE, is_bot: false },
        date: 1,
        old_chat_member: { status: "member", user: { id: 123456, is_bot: true, first_name: "T" } },
        new_chat_member: { status: "left", user: { id: 123456, is_bot: true, first_name: "T" } },
      },
    });
    expect(status()).toBeNull();
    expect(count("scene_links")).toBe(0);
  });

  it("/disconnect ends the user's scenes", async () => {
    await h.say(dm(ALICE), ALICE, "/disconnect");
    expect(status()).toBe("finished");
  });

  const keyboardGone = () => {
    const edits = h.telegram
      .called("editMessageText")
      .filter((call) => call.params.message_id === scene.message);
    expect(edits.at(-1)?.params.reply_markup).toEqual({ inline_keyboard: [] });
  };

  it("/disconnect takes the buttons off the user's scenes", async () => {
    await h.say(dm(ALICE), ALICE, "/disconnect");
    keyboardGone();
  });

  it("revoking access takes the buttons off the scenes there", async () => {
    await h.update({
      callback_query: {
        id: "rv",
        from: { ...ALICE, is_bot: false },
        data: `rv:${TEAM.id}`,
        message: { message_id: 50, date: 1, chat: dm(ALICE) },
      },
    });
    expect(status()).toBe("finished");
    keyboardGone();
  });

  it("leaving the group takes the buttons off the scenes there", async () => {
    await h.say(TEAM, ALICE, "", { left_chat_member: { ...ALICE, is_bot: false } });
    keyboardGone();
  });

  it("an ended scene Telegram keeps quiet loses its buttons in the daily run", async () => {
    h.db.raw.exec(`UPDATE scenes SET quiet_until = ${Date.now() + 3_600_000}`);
    await h.say(dm(ALICE), ALICE, "/disconnect");
    expect(h.telegram.called("editMessageText")).toHaveLength(0);
    h.db.raw.exec(`UPDATE scenes SET quiet_until = 0`);
    await daily();
    keyboardGone();
  });
});
