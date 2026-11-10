import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const BOB = { id: 222, first_name: "Bob", username: "bob", language_code: "ru" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });

const KEY = `sk-proj-${"a".repeat(48)}`;
const SECRET = `whsec_${btoa("a signing secret of 32 bytes!!!!")}`;

let h: Harness;

beforeEach(async () => {
  h = new Harness();
  for (const user of [ALICE, BOB]) {
    await h.say(dm(user), user, "/start");
    await h.connect(user);
  }
});
afterEach(() => h.restore());

const sent = () => h.telegram.called("sendMessage").map((call) => call.params);
const sentTexts = () => sent().map((params) => String(params.text));

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

/** The user's key and secret set; the webhook's path, from the menu. */
async function setUp(user: typeof ALICE, secret: string | null = SECRET): Promise<string> {
  await h.say(dm(user), user, KEY);
  if (secret) await h.say(dm(user), user, secret);
  const screen = await press(user, "m:oawh");
  return /\/openai\/webhook\/[\w-]+/.exec(String(screen!.text))![0];
}

/** The Worker's id of a session by OpenAI's. */
const ours = (external: string) =>
  (
    h.db.raw.query("SELECT id FROM agent_sessions WHERE external_id = ?").get(external) as {
      id: string;
    }
  ).id;

async function sign(secret: string, id: string, timestamp: number, body: string) {
  const raw = Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

let eventIds = 0;

async function deliver(
  path: string,
  type: string,
  session: string,
  options: { secret?: string; at?: number; signature?: string } = {},
) {
  const id = `evt_${++eventIds}`;
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id,
    object: "event",
    created_at: at,
    type,
    data: { id: session, object: "agent.session" },
  });
  const signature = options.signature ?? (await sign(options.secret ?? SECRET, id, at, body));
  return h.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(at),
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}

describe("OpenAI webhooks", () => {
  it("tells the user a session failed, as a reply to the message that started it", async () => {
    const path = await setUp(ALICE);
    const started = await h.say(dm(ALICE), ALICE, "look at this");
    const before = sent().length;

    const response = await deliver(path, "agent.session.failed", "sess_1");
    expect(response.status).toBe(200);
    const told = sent().slice(before);
    expect(told).toHaveLength(1);
    expect(told[0].chat_id).toBe(ALICE.id);
    expect(String(told[0].text)).toContain("An OpenAI session failed");
    // Shown short: its prefix and six characters.
    expect(String(told[0].text)).toContain(`<code>${ours("sess_1").slice(0, 9)}</code>`);
    expect(told[0].reply_parameters).toEqual({
      message_id: started.message_id,
      allow_sending_without_reply: true,
    });

    // OpenAI retries: said once.
    expect((await deliver(path, "agent.session.failed", "sess_1")).status).toBe(200);
    expect(sent()).toHaveLength(before + 1);
  });

  it("names the group a failed session started from", async () => {
    const path = await setUp(ALICE);
    const session = ours("sess_0");
    h.db.raw.exec(`INSERT INTO chats (chat_id, type, title, updated_at)
      VALUES (-1001234, 'supergroup', 'Team <ops>', 1);
      INSERT INTO fires (chat_id, message_id, user_id, by_other, status, session_id, at)
      VALUES (-1001234, 42, 111, 0, 'started', '${session}', 1);`);
    await deliver(path, "agent.session.failed", "sess_0");
    const text = sentTexts().at(-1)!;
    expect(text).toContain("«Team &lt;ops&gt;»");
    expect(text).toContain('href="https://t.me/c/1234/42"');
  });

  it("says once that a session waits for an action, and ignores the other events", async () => {
    const path = await setUp(ALICE);
    const before = sent().length;
    for (const type of [
      "agent.session.created",
      "agent.session.in_progress",
      "agent.session.idle",
    ]) {
      expect((await deliver(path, type, "sess_0")).status).toBe(200);
    }
    expect(sent()).toHaveLength(before);

    await deliver(path, "agent.session.action_required", "sess_0");
    await deliver(path, "agent.session.action_required", "sess_0");
    expect(sent()).toHaveLength(before + 1);
    expect(sentTexts().at(-1)).toContain("waiting for an action I cannot give");

    // A message went in since: the next wait is news again.
    const { access_token } = await h.connect(ALICE);
    const asked = await h.tool(access_token, "message_session", {
      to: ours("sess_0"),
      text: "go on",
      expect_answer: false,
    });
    expect(asked.isError).toBe(false);
    await deliver(path, "agent.session.action_required", "sess_0");
    expect(sent()).toHaveLength(before + 2);
    expect(sentTexts().at(-1)).toContain("waiting for an action I cannot give");

    // A failure after that is still news; nothing after a failure is.
    await deliver(path, "agent.session.failed", "sess_0");
    await deliver(path, "agent.session.action_required", "sess_0");
    expect(sent()).toHaveLength(before + 3);
    expect(sentTexts().at(-1)).toContain("An OpenAI session failed");
  });

  it("turns away bad signatures, stale times and unknown paths, saying nothing", async () => {
    const path = await setUp(ALICE);
    const before = sent().length;
    const other = `whsec_${btoa("another secret, 32 bytes long!!!")}`;
    expect((await deliver(path, "agent.session.failed", "sess_0", { secret: other })).status).toBe(
      400,
    );
    expect(
      (await deliver(path, "agent.session.failed", "sess_0", { signature: "AAAA" })).status,
    ).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect((await deliver(path, "agent.session.failed", "sess_0", { at: stale })).status).toBe(400);
    const future = Math.floor(Date.now() / 1000) + 600;
    expect((await deliver(path, "agent.session.failed", "sess_0", { at: future })).status).toBe(
      400,
    );
    const wrong = `/openai/webhook/${"x".repeat(32)}`;
    expect((await deliver(wrong, "agent.session.failed", "sess_0")).status).toBe(400);
    const response = await h.fetch(path, { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(sent()).toHaveLength(before);
    expect(h.db.raw.query("SELECT told FROM agent_sessions").all()).toEqual([{ told: null }]);
  });

  it("does not listen before the secret is sent", async () => {
    const path = await setUp(ALICE, null);
    const screen = await press(ALICE, "m:oawh");
    expect(String(screen!.text)).toContain("not set yet");
    expect((await deliver(path, "agent.session.failed", "sess_0")).status).toBe(400);
  });

  it("does not speak of another user's session", async () => {
    const alicePath = await setUp(ALICE);
    const bobSecret = `whsec_${btoa("bob's own secret of 32 bytes!!!!")}`;
    const bobPath = await setUp(BOB, bobSecret);
    expect(bobPath).not.toBe(alicePath);
    // Alice's first session is sess_0, Bob's sess_1: each path knows only its user's.
    const before = sent().length;
    const response = await deliver(bobPath, "agent.session.failed", "sess_0", {
      secret: bobSecret,
    });
    expect(response.status).toBe(200);
    expect(await deliver(alicePath, "agent.session.failed", "sess_1")).toHaveProperty(
      "status",
      200,
    );
    expect(sent()).toHaveLength(before);

    await deliver(bobPath, "agent.session.failed", "sess_1", { secret: bobSecret });
    expect(sent().at(-1)!.chat_id).toBe(BOB.id);
    expect(sentTexts().at(-1)).toContain("Сессия OpenAI упала");
  });

  it("keeps the secret encrypted and deletes its message; the menu shows it set", async () => {
    await h.say(dm(ALICE), ALICE, KEY);
    let screen = await press(ALICE, "m:oa");
    expect(String(screen!.text)).toContain("does not tell me until you set up the webhook");
    const message = await h.say(dm(ALICE), ALICE, SECRET);
    expect(h.telegram.called("deleteMessage").at(-1)!.params).toEqual({
      chat_id: ALICE.id,
      message_id: message.message_id,
    });
    expect(sentTexts().at(-1)).toContain("Saved the webhook secret");
    const stored = h.db.raw.query("SELECT config_enc, hook FROM agent_configs").get() as {
      config_enc: string;
      hook: string;
    };
    expect(stored.config_enc).not.toContain("whsec_");
    const texts = h.db.raw.query("SELECT text FROM messages").all() as { text: string }[];
    expect(texts.some((row) => row.text.includes("whsec_"))).toBe(false);

    screen = await press(ALICE, "m:oa");
    expect(String(screen!.text)).not.toContain("set up the webhook");
    screen = await press(ALICE, "m:oawh");
    expect(String(screen!.text)).toContain("The secret is set");
    // Only a hash of the path is kept in the clear.
    const path = /\/openai\/webhook\/([\w-]+)/.exec(String(screen!.text))![1];
    expect(stored.hook).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.hook).not.toContain(path);
  });
});
