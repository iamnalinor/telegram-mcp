/**
 * Codex: the Codex CLI on the user's own machine, run by their relay
 * (src/relay.ts) installed for Codex, signed in to ChatGPT there. The Worker gives each session its id (`cx_…`) and queues its start;
 * the relay tells the thread's id once Codex has one (`agent_sessions`
 * `external_id`), and messages for the session wait for it, then go in one at
 * a time. Each run reaches the bot's tools with a token of its own, bound to
 * its session and handed out with its job (src/relay.ts): what it says it is
 * counts only as that session.
 *
 * Settings, kept encrypted like OpenAI's though none is secret: the model
 * (null: Codex's own default), the sandbox policy and the working directory.
 * A sandboxed run goes inside bubblewrap on the relay (src/relayScript.ts):
 * it sees its own directory, the system's programs and the Codex login, not
 * the user's files. Otherwise Codex has the machine, from the working
 * directory. Policy `others` (the default) sandboxes whatever a third party
 * stands behind — their message, their scene's wake, a session their words
 * went into — `all` everything, `none` nothing.
 *
 * A sandboxed thread lives in the sandbox, apart from the user's own: each
 * session is one or the other for good (`agent_sessions.sandboxed`). A message
 * that would run on the other side than its session starts a new session that
 * carries on — so a third party's word never goes into a thread of the
 * user's. A relay that cannot sandbox (no working bubblewrap) is not given
 * sandboxed runs: they fail, and nothing runs unsandboxed in their place.
 *
 * A start that fails tells the user once, and the messages queued behind it
 * fail with it: nothing falls back to another provider.
 */

import { bytesToHex, decrypt, encrypt, randomId } from "../crypto";
import { codexRelayState, enqueue, relaySandboxes } from "../relay";
import type { RelayJob, Store } from "../store";
import { payloadOf } from "./claude";
import { MODELS } from "./openai";
import { assistantPrompt, CODEX_PREAMBLE } from "./prompt";
import type { AgentContext, Provider, StartRequest } from "./types";

/** Models the menu offers; none chosen, Codex picks its own. */
export const CODEX_MODELS = MODELS;

export const SANDBOX_POLICIES = ["all", "others", "none"] as const;
export type SandboxPolicy = (typeof SANDBOX_POLICIES)[number];

export interface CodexConfig {
  model: string | null;
  sandbox: SandboxPolicy;
  /** Where an unsandboxed run starts; null: the relay's home directory. */
  workdir: string | null;
}

export const CODEX_DEFAULTS: CodexConfig = { model: null, sandbox: "others", workdir: null };

const sealedFor = (userId: number) => `agent:codex:${userId}`;

/** The user's Codex settings, or why there are none to use. */
export async function loadCodex(
  store: Store,
  key: CryptoKey,
  userId: number,
): Promise<CodexConfig | "none" | "broken"> {
  const sealed = await store.getAgentConfig(userId, "codex");
  if (!sealed) return "none";
  const plain = await decrypt(key, sealed, sealedFor(userId));
  if (!plain) return "broken";
  try {
    return { ...CODEX_DEFAULTS, ...(JSON.parse(plain) as Partial<CodexConfig>) };
  } catch {
    return "broken";
  }
}

export async function saveCodex(
  store: Store,
  key: CryptoKey,
  userId: number,
  config: CodexConfig,
): Promise<void> {
  await store.setAgentConfig(
    userId,
    "codex",
    await encrypt(key, JSON.stringify(config), sealedFor(userId)),
  );
}

/** A directory for unsandboxed runs: absolute or under ~, one line, nothing a shell would expand. */
export function workdirOf(text: string): string | null {
  const dir = text.trim();
  return dir.length <= 200 && /^(?:~|(?:~\/|\/)[^\p{Cc}$`"'\\]*)$/u.test(dir) ? dir : null;
}

/**
 * What the relay runs a job with. A sandboxed run gets its session's box on
 * the relay. Fixed when the job is queued: a job waiting in the queue keeps the
 * sandbox and directory it was enqueued with, whatever the settings say later.
 */
function paramsOf(config: CodexConfig, sandboxed: boolean): string {
  return JSON.stringify({
    model: config.model,
    sandbox: sandboxed ? "read-only" : "danger-full-access",
    cwd: sandboxed ? null : config.workdir,
  });
}

/** Whether a run is sandboxed: by the policy, and whether a third party stands behind it. */
function sandboxed(config: CodexConfig, byOther: boolean): boolean {
  return config.sandbox === "all" || (config.sandbox === "others" && byOther);
}

function byOf(request: StartRequest): "user" | "other" {
  return request.kind === "test" || request.by === "user" ? "user" : "other";
}

async function username(ctx: AgentContext, holder: number): Promise<string | null> {
  return (await ctx.store.getUser(holder))?.username ?? null;
}

export const codex: Provider = {
  kind: "codex",
  // Each start is a run on the user's machine and their ChatGPT plan's limits.
  limits: { startsPerHour: 20 },

  async status(ctx, holder) {
    const config = await loadCodex(ctx.store, ctx.config.secretKey, holder);
    const relay = codexRelayState(await ctx.store.getRelay(holder));
    return {
      start: typeof config === "string" ? config : "set",
      reach: relay === "online" ? "online" : relay === "none" ? "none" : "offline",
    };
  },

  async start(ctx, holder, request) {
    const config = await loadCodex(ctx.store, ctx.config.secretKey, holder);
    if (typeof config === "string") return { ok: false, reason: config, detail: config };
    const row = await ctx.store.getRelay(holder);
    const relay = codexRelayState(row);
    if (relay !== "online") return { ok: false, reason: "relay", detail: `relay ${relay}` };
    const by = byOf(request);
    const boxed = sandboxed(config, by === "other");
    if (boxed && !relaySandboxes(row)) {
      return { ok: false, reason: "sandbox", detail: "the relay cannot sandbox" };
    }
    const id = `cx_${bytesToHex(crypto.getRandomValues(new Uint8Array(12)))}`;
    await ctx.store.reserveAgentSession({
      id,
      user_id: holder,
      provider: "codex",
      kind: "chat",
      token_exp: null,
      signin: null,
      token_version: null,
      origin: by,
      sandboxed: boxed,
    });
    const prompt = assistantPrompt(await username(ctx, holder), CODEX_PREAMBLE);
    await ctx.store.enqueueJob({
      id: `ask_${randomId(9)}`,
      user_id: holder,
      target_session: id,
      body: `${prompt}\n\n---\n\n${payloadOf(request)}\nsession: ${id}`,
      origin: by,
      from_session: null,
      chat_id: null,
      message_id: null,
      thread_id: null,
      wants_answer: 0,
      kind: request.kind === "guest" || request.kind === "scene" ? request.kind : "reply",
      runner: "codex-start",
      params: paramsOf(config, boxed),
    });
    return { ok: true, sessionId: id, sessionUrl: null };
  },

  async deliver(ctx, holder, delivery) {
    const row = await ctx.store.getAgentSession(holder, delivery.session);
    const config = await loadCodex(ctx.store, ctx.config.secretKey, holder);
    // Its start failed: there is no thread to carry on, so a new session takes it.
    if (!row || (row.told === "failed" && !row.external_id) || typeof config === "string") {
      return { ok: false, reach: "none" };
    }
    const relay = codexRelayState(await ctx.store.getRelay(holder));
    if (relay !== "online") return { ok: false, reach: relay === "none" ? "none" : "offline" };
    // A thread a third party ever spoke into stays sandboxed: their words are in it.
    const byOther =
      delivery.job.origin !== "user" ||
      row.origin !== "user" ||
      (await ctx.store.sessionHeardOthers(holder, row.id));
    // The thread is where it started: one that needs the other side takes a new session.
    const boxed = sandboxed(config, byOther);
    if (boxed !== (row.sandboxed === 1)) return { ok: false, reach: "sandbox" };
    const ask = await enqueue(
      ctx.store,
      {
        ...delivery.job,
        user_id: holder,
        target_session: row.id,
        runner: "codex-resume",
        params: paramsOf(config, boxed),
      },
      // The id is said again: a long thread may have lost its first message to compaction.
      async (id) => `Your session id: ${row.id}\n${await delivery.envelope(id)}`,
    );
    return { ok: true, ask };
  },

  link: () => null,
};

/**
 * A Codex start that did not go through, or a message for a session whose
 * start did not: the messages queued behind it fail, the starts in the log
 * that led to it fail, and the user hears once.
 */
export async function codexStartFailed(
  store: Store,
  job: Pick<RelayJob, "user_id" | "target_session" | "error">,
): Promise<{ tell: boolean; error: string }> {
  await store.failAgentSession(job.user_id, job.target_session, "its Codex start failed");
  return {
    tell: await store.tellOnce(job.target_session, "failed"),
    error: job.error ?? "unknown error",
  };
}
