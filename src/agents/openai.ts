/**
 * OpenAI: the Worker runs Agents API sessions itself with the user's API key.
 * No relay: a message for a session is posted to it as an event, which starts
 * a new turn if it is idle or steers the one running.
 *
 * A chat session talks: `chatModel`, no environment of its own, this MCP and
 * web search. Real work goes to a task session the chat session starts with
 * start_task (src/tools/tasks.ts): `taskModel`, a hosted environment. Both
 * get ids from the Worker (`oa_…`), mapped to OpenAI's own in
 * `agent_sessions`, and an MCP token bound to that id (src/oauth.ts
 * `mintSessionToken`), so their calls are filed under it whatever they pass.
 *
 * The key is kept encrypted with the models, like the routine's token. A
 * session that fails on OpenAI's side says nothing in Telegram; OpenAI's
 * webhooks (src/bot/openaiWebhook.ts) tell the bot, when the user set them up.
 */

import { bytesToHex, decrypt, encrypt, nowSeconds, randomId, sha256 } from "../crypto";
import { Fence } from "../format";
import { mintSessionToken } from "../oauth";
import type { UserRef } from "../prompts";
import type { Store } from "../store";
import { payloadOf } from "./claude";
import { assistantPrompt, OPENAI_PREAMBLE, taskPrompt } from "./prompt";
import type { AgentContext, Provider, StartFailure, StartResult } from "./types";

const API = "https://api.openai.com/v1/agents/sessions";

/** Models the menu offers; the first two are the defaults for chat and for tasks. */
export const MODELS = ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"] as const;

export interface OpenAIConfig {
  key: string;
  chatModel: string;
  taskModel: string;
  /** What OpenAI signs its webhooks with (`whsec_…`), once the user sent it. */
  webhookSecret?: string;
  /** The webhooks' address under /openai/webhook/: random, the same for every key. */
  webhookPath?: string;
}

/** What `agent_configs.hook` holds for a webhook path: the path itself never is. */
export async function hookHash(path: string): Promise<string> {
  return bytesToHex(await sha256(`openai-webhook:${path}`));
}

const sealedFor = (userId: number) => `agent:openai:${userId}`;

/** The user's OpenAI settings, or why there are none to use. */
export async function loadOpenAI(
  store: Store,
  key: CryptoKey,
  userId: number,
): Promise<OpenAIConfig | "none" | "broken"> {
  const sealed = await store.getAgentConfig(userId, "openai");
  if (!sealed) return "none";
  const plain = await decrypt(key, sealed, sealedFor(userId));
  if (!plain) return "broken";
  try {
    const saved = JSON.parse(plain) as Partial<OpenAIConfig> & { key: string };
    return {
      ...saved,
      chatModel: saved.chatModel ?? MODELS[0],
      taskModel: saved.taskModel ?? MODELS[1],
    };
  } catch {
    return "broken";
  }
}

export async function saveOpenAI(
  store: Store,
  key: CryptoKey,
  userId: number,
  config: OpenAIConfig,
): Promise<OpenAIConfig> {
  // The first save gives the webhooks their address, kept from then on.
  const saved = { ...config, webhookPath: config.webhookPath ?? randomId(24) };
  await store.setAgentConfig(
    userId,
    "openai",
    await encrypt(key, JSON.stringify(saved), sealedFor(userId)),
    await hookHash(saved.webhookPath),
  );
  return saved;
}

type Answer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: StartFailure; retryAfter?: number; detail: string };

/** One call to the Agents API. The body carries a token: it is never logged, the answer may be. */
async function call(
  key: string,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "openai-beta": "agents=v1",
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, reason: "other", detail: String(error) };
  }
  const text = await response.text();
  if (response.ok) {
    try {
      return { ok: true, data: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: true, data: {} };
    }
  }
  const detail = `${response.status} ${text.slice(0, 300)}`;
  if (response.status === 401 || response.status === 403)
    return { ok: false, reason: "token", detail };
  if (response.status === 404) return { ok: false, reason: "missing", detail };
  if (response.status === 429) {
    if (/insufficient_quota/.test(text)) return { ok: false, reason: "quota", detail };
    const retryAfter = Number(response.headers.get("retry-after")) || undefined;
    return { ok: false, reason: "limit", retryAfter, detail };
  }
  return { ok: false, reason: "other", detail };
}

/**
 * This MCP, signed in as the session, and web search. The MCP is reached at
 * the origin the bot is bound to (src/bot/setup.ts), not whichever host a
 * request came in on.
 */
function tools(origin: string, token: string) {
  return [
    {
      type: "mcp",
      server_label: "telegram",
      transport: { type: "http", server_url: `${origin}/`, authorization: `Bearer ${token}` },
      required: true,
    },
    { type: "web_search" },
  ];
}

/** A message into a session: a new turn if it is idle, a correction if it runs. */
function inputEvent(text: string) {
  return {
    type: "agent.session.input.message",
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
  };
}

function failed(holder: number, answer: Extract<Answer, { ok: false }>) {
  console.error(JSON.stringify({ event: "openai_failed", user: holder, detail: answer.detail }));
}

/** Start a session with its own id and token; what it is told is made from that id. */
async function open(
  ctx: AgentContext,
  holder: number,
  config: OpenAIConfig,
  p: { kind: "chat" | "task"; instructions: string; input: (id: string) => string },
): Promise<StartResult> {
  const origin = await ctx.store.getMeta("public_origin");
  if (!origin)
    return { ok: false, reason: "other", detail: "the bot is not bound to an address yet" };
  const id = `oa_${bytesToHex(crypto.getRandomValues(new Uint8Array(12)))}`;
  const { token, expiresAt } = await mintSessionToken(ctx, holder, id);
  const answer = await call(
    config.key,
    "",
    {
      agent: {
        model: p.kind === "chat" ? config.chatModel : config.taskModel,
        instructions: p.instructions,
        tools: tools(origin, token),
      },
      environment: { type: p.kind === "chat" ? "none" : "openai_hosted" },
      input: p.input(id),
      metadata: { session: id, kind: p.kind },
    },
    id,
  );
  if (!answer.ok) return answer;
  const external = answer.data.id ?? answer.data.session_id;
  if (typeof external !== "string" || !external) {
    return { ok: false, reason: "other", detail: "unexpected answer: no session id" };
  }
  await ctx.store.addAgentSession({
    id,
    user_id: holder,
    provider: "openai",
    external_id: external,
    kind: p.kind,
    token_exp: expiresAt,
  });
  return { ok: true, sessionId: id, sessionUrl: null };
}

async function username(ctx: AgentContext, holder: number): Promise<string | null> {
  return (await ctx.store.getUser(holder))?.username ?? null;
}

const DAY = 86_400;

export const openai: Provider = {
  kind: "openai",
  // Every start and every delivery is a paid turn on the user's key; starts are capped like Claude's.
  limits: { startsPerHour: 30 },

  async status(ctx, holder) {
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, holder);
    return typeof config === "string"
      ? { start: config, reach: "none" }
      : { start: "set", reach: "online" };
  },

  async start(ctx, holder, request) {
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, holder);
    if (typeof config === "string") return { ok: false, reason: config, detail: config };
    const result = await open(ctx, holder, config, {
      kind: "chat",
      instructions: assistantPrompt(await username(ctx, holder), OPENAI_PREAMBLE),
      input: (id) => `${payloadOf(request)}\nsession: ${id}`,
    });
    if (!result.ok) failed(holder, result);
    return result;
  },

  async deliver(ctx, holder, delivery) {
    const row = await ctx.store.getAgentSession(holder, delivery.session);
    const config = await loadOpenAI(ctx.store, ctx.config.secretKey, holder);
    if (!row?.external_id || typeof config === "string") return { ok: false, reach: "none" };
    const path = `/${encodeURIComponent(row.external_id)}`;
    // Its token runs out within a day: a new one first, so the turn this starts can use the tools.
    if (row.token_exp === null || row.token_exp - nowSeconds() < DAY) {
      const origin = await ctx.store.getMeta("public_origin");
      if (!origin) return { ok: false, reach: "none" };
      const { token, expiresAt } = await mintSessionToken(ctx, holder, row.id);
      const updated = await call(config.key, path, { agent: { tools: tools(origin, token) } });
      if (!updated.ok) {
        failed(holder, updated);
        return { ok: false, reach: "none" };
      }
      await ctx.store.setAgentTokenExp(row.id, expiresAt);
    }
    const ask = `ask_${randomId(9)}`;
    // The id is said again: a long session may have lost its payload to compaction.
    const body = `Your session id: ${row.id}\n${await delivery.envelope(ask)}`;
    const posted = await call(config.key, `${path}/events`, inputEvent(body));
    if (!posted.ok) {
      // Gone (404) or refused: a new session takes it, told which one it continues.
      failed(holder, posted);
      return { ok: false, reach: "none" };
    }
    // Filed like a relay job already done: answer_session and the session's origin read it.
    await ctx.store.enqueueJob(
      { ...delivery.job, id: ask, user_id: holder, target_session: row.id, body },
      "done",
    );
    return { ok: true, ask };
  },

  link: () => null,
};

/**
 * A task session for a chat session of the holder's (`from`): the brief is
 * that session's words, fenced as data; the task finds who asked in Telegram.
 */
export async function startTask(
  ctx: AgentContext,
  holder: number,
  user: UserRef,
  p: {
    from: string;
    brief: string;
    chat: number | null;
    topic: number | null;
    message: number | null;
  },
): Promise<StartResult> {
  const config = await loadOpenAI(ctx.store, ctx.config.secretKey, holder);
  if (typeof config === "string") return { ok: false, reason: config, detail: config };
  const fence = new Fence(user, [p.brief]);
  const result = await open(ctx, holder, config, {
    kind: "task",
    instructions: taskPrompt(user.username, OPENAI_PREAMBLE.account),
    input: (id) =>
      `started by: ${p.from}\nsession: ${id}\n` +
      `chat: ${p.chat ?? "-"}  topic: ${p.topic ?? "-"}  message: ${p.message ?? "-"}\n` +
      `The brief from ${p.from}, passed on by the bot. ${fence.note()}\n${fence.wrap(p.brief)}`,
  });
  if (!result.ok) failed(holder, result);
  return result;
}
