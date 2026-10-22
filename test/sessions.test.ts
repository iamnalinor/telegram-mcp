import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { Harness } from "./harness";

const ALICE = { id: 111, first_name: "Alice", username: "alice", language_code: "en" };
const dm = (user: { id: number }) => ({ id: user.id, type: "private" });

const SUFFIX = "01Svopn2AB4YoGuZVfSMUKGR";

let h: Harness;
let alice: string;
beforeEach(async () => {
  h = new Harness();
  await h.say(dm(ALICE), ALICE, "/start");
  alice = (await h.connect(ALICE)).access_token;
});
afterEach(() => h.restore());

type Row = { message_id: number; session_id: string | null; awaited_until: number | null };

const sent = () =>
  h.db.raw
    .query("SELECT message_id, session_id, awaited_until FROM messages WHERE outgoing = 1")
    .all() as Row[];

describe("the sending session", () => {
  it("is stored with the message, cse_ and session_ spelled the same", async () => {
    await h.tool(alice, "send_message", { text: "one", session: `cse_${SUFFIX}` });
    await h.tool(alice, "send_message", { text: "two", session: `session_${SUFFIX}` });
    await h.tool(alice, "send_message", { text: "three" });
    expect(sent().map((row) => row.session_id)).toEqual([
      `session_${SUFFIX}`,
      `session_${SUFFIX}`,
      null,
    ]);
  });

  it("refuses something that is not a session id", async () => {
    const result = await h.tool(alice, "send_message", { text: "x", session: "../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(sent()).toHaveLength(0);
  });

  it("goes along with a file sent through an upload link", async () => {
    const result = await h.tool(alice, "create_upload_url", {
      filename: "a.txt",
      session: `cse_${SUFFIX}`,
    });
    const url = /https:\/\/\S+\/upload\/\S+/.exec(result.text)![0];
    const put = await h.fetch(new URL(url).pathname, {
      method: "PUT",
      headers: { "content-length": "1" },
      body: new Uint8Array([1]),
    });
    expect(put.status).toBe(200);
    expect(sent()[0].session_id).toBe(`session_${SUFFIX}`);
  });

  it("goes along with a copied message", async () => {
    await h.say(dm(ALICE), ALICE, "keep this");
    const original = h.db.raw
      .query("SELECT message_id FROM messages WHERE outgoing = 0 AND text = 'keep this'")
      .get() as { message_id: number };
    await h.tool(alice, "forward_message", {
      message_id: original.message_id,
      session: `session_${SUFFIX}`,
    });
    expect(sent()[0].session_id).toBe(`session_${SUFFIX}`);
  });
});

describe("waiting for an answer", () => {
  it("marks the question as awaited until the wait ends, once per call", async () => {
    const before = Math.floor(Date.now() / 1000);
    await h.tool(alice, "ask_user", { question: "Ready?", wait_seconds: 0 });
    expect(sent()[0].awaited_until).toBeNull();

    await h.tool(alice, "wait_for_reply", { wait_seconds: 1 });
    const until = sent()[0].awaited_until!;
    expect(until).toBeGreaterThanOrEqual(before + 1);
    expect(until).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 1);
  });
});
