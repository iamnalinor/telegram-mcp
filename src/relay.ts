/**
 * The relay: a machine of the user's, signed in to Claude Code, that passes
 * messages into cloud sessions with `claude -p --cloud <session>`. The bot
 * cannot do that itself — only a full Claude sign-in may write to a session —
 * so it queues the message and the relay picks it up. The same machine runs
 * Codex for the user, if it has it: each job names its runner.
 *
 *   GET  /relay/install.sh           the installer, see src/relayScript.ts
 *   GET  /relay/jobs?wait=25&runners=claude,codex&busy=codex
 *                                    the relay asks for work it can run (Bearer:
 *                                    its token; no runners: Claude only), less
 *                                    what it has no room for now; the answer
 *                                    waits up to that long for a job; a Codex
 *                                    job comes with its run's own MCP token,
 *                                    bound to its session (src/oauth.ts)
 *   POST /relay/jobs/<id>/started    a Codex start tells its thread's id: {thread}
 *   POST /relay/jobs/<id>            …and the relay reports how it went: {ok, error}
 *
 * Without a relay none of this is used and everything works as before: a
 * reply to a session's message starts a new session that carries on.
 *
 * This is the transport: the queue and its endpoints. What a session is told
 * is in src/agents/envelopes.ts; what happens to a job that could not be
 * passed on, in src/bot/fallback.ts.
 */

import type { BotContext } from "./bot/context";
import { texts } from "./bot/texts";
import { nowSeconds, randomId, sha256Base64Url } from "./crypto";
import type { UserRef } from "./prompts";
import { mintSessionToken } from "./oauth";
import { installScript } from "./relayScript";
import { type RelayJob, type RelayRow, type Runner, type Store } from "./store";

/** What becomes of a job the relay could not pass on. */
export type FallBack = (
  ctx: BotContext,
  job: RelayJob,
  why: "login" | "offline" | "failed",
) => Promise<void>;

/** Heard from within this long: online. The relay asks every few seconds. */
const ONLINE_SECONDS = 120;
/** A job nobody took within this long fails, and a reply starts a session instead. */
const JOB_EXPIRY_SECONDS = 330;
/**
 * Codex runs on the machine for long. A job of its fails when no relay that
 * runs Codex called in for this long; one waiting behind a running start, when
 * it waited this long all the same; one taken and never reported, after the
 * relay's own 50 min timeout and then some.
 */
const CODEX_QUEUED_SECONDS = 180;
const CODEX_HELD_SECONDS = 75 * 60;
const CODEX_TAKEN_SECONDS = 60 * 60;
/** One at a time: the relay calls in between jobs, so a slow one does not make it look gone. */
const JOBS_PER_POLL = 1;
/**
 * Long poll: how long a request may wait for work, and how often it looks.
 * D1 allows 50 queries per request on the free plan; this makes about 15.
 */
const MAX_WAIT_SECONDS = 25;
const WAIT_STEP_MS = 2000;
/** Past the relay's own 300 s timeout per job: a taken job never reported is lost. */
const TAKEN_EXPIRY_SECONDS = 420;
/**
 * Stale jobs one sweep handles: each may start a session, a dozen D1 queries
 * and a fetch or two, and a cron run has 50 queries on the free plan. The
 * rest wait for the next sweep, a few minutes on, as they were.
 */
const SWEEP_LIMIT = 3;
const ERROR_LIMIT = 500;

export type RelayState = "none" | "online" | "offline" | "login";

/** What a relay can run, as it says when it asks for work. */
export type RunnerKind = "claude" | "codex";

const RUNS: Record<RunnerKind, readonly Runner[]> = {
  claude: ["claude-continue"],
  codex: ["codex-start", "codex-resume"],
};

/** What the relay said it can run; one too old to say runs Claude only. */
export function relayRuns(row: RelayRow | null): RunnerKind[] {
  const said = (row?.runners ?? "claude").split(",");
  return (Object.keys(RUNS) as RunnerKind[]).filter((kind) => said.includes(kind));
}

/** The relay's state for Claude's sessions: its sign-in counts. */
export function relayState(row: RelayRow | null, now = nowSeconds()): RelayState {
  if (!row) return "none";
  if (row.login_failed_at) return "login";
  return row.last_seen !== null && row.last_seen >= now - ONLINE_SECONDS ? "online" : "offline";
}

export type CodexRelayState = "none" | "online" | "offline" | "nocodex";

/** The relay's state for Codex: Claude's sign-in does not matter, Codex being there does. */
export function codexRelayState(row: RelayRow | null, now = nowSeconds()): CodexRelayState {
  if (!row) return "none";
  if (row.last_seen === null || row.last_seen < now - ONLINE_SECONDS) return "offline";
  return relayRuns(row).includes("codex") ? "online" : "nocodex";
}

/** Why a message cannot go through now, for the model and whoever asked — or null. */
export function relayProblem(state: RelayState, user: UserRef): string | null {
  const name = user.username ? `@${user.username}` : "the user";
  if (state === "online") return null;
  if (state === "none") {
    return `Messages to other sessions need the relay, and ${name} has not set one up (bot menu → 🤖 Assistant → ⚙️ Claude → 🛰 Relay).`;
  }
  if (state === "login") {
    return `The relay cannot pass messages on: its Claude sign-in expired. ${name} has to sign in again there (\`claude\`, then /login) — tell them.`;
  }
  return `The relay is offline, so messages cannot reach other sessions now. ${name} has to check the machine it runs on — tell them.`;
}

export const relayToken = () => `relay_${randomId(24)}`;
export const tokenHash = (token: string) => sha256Base64Url(`relay:${token}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queue a message for the relay. The body may name the ask, so it is made from its id. */
export async function enqueue(
  store: Store,
  job: Omit<Parameters<Store["enqueueJob"]>[0], "id" | "body">,
  body: (ask: string) => string | Promise<string>,
): Promise<string> {
  const id = `ask_${randomId(9)}`;
  await store.enqueueJob({ ...job, id, body: await body(id) });
  return id;
}

/** The relay's own HTTP endpoints. Null for any other path. */
export async function handleRelay(
  request: Request,
  pathname: string,
  store: Store,
  origin: string,
  botFor: () => Promise<BotContext>,
  fallBack: FallBack,
): Promise<Response | null> {
  if (pathname === "/relay/install.sh" && request.method === "GET") {
    return new Response(installScript(origin), {
      headers: { "content-type": "text/x-shellscript; charset=utf-8" },
    });
  }
  if (pathname !== "/relay/jobs" && !pathname.startsWith("/relay/jobs/")) return null;

  const token = /^Bearer (relay_[\w-]{20,64})$/.exec(request.headers.get("authorization") ?? "");
  const relay = token ? await store.relayByToken(await tokenHash(token[1])) : null;
  if (!relay) return new Response("unknown relay token\n", { status: 401 });
  const now = nowSeconds();

  if (pathname === "/relay/jobs" && request.method === "GET") {
    const params = new URL(request.url).searchParams;
    await store.touchRelay(relay.user_id, now);
    // What it runs; a relay too old to say runs Claude only, and stays null.
    const said = params.get("runners");
    const runners =
      said === null ? null : said.split(",").filter((kind) => Object.hasOwn(RUNS, kind));
    const stored = runners === null ? null : runners.join(",");
    if (stored !== relay.runners) await store.setRelayRunners(relay.user_id, stored);
    // A relay (re)started after a new sign-in: give it a chance before calling it broken again.
    const start = params.get("start") === "1";
    if (start && relay.login_failed_at) await store.setRelayLogin(relay.user_id, null);
    // Signed out of Claude: its jobs wait, and Codex's still go. Busy: they wait, and do not expire.
    const busy = (params.get("busy") ?? "").split(",");
    const kinds = relayRuns({ ...relay, runners: stored }).filter(
      (kind) => (kind !== "claude" || !relay.login_failed_at || start) && !busy.includes(kind),
    );
    if (!kinds.length) return Response.json([]);
    const wait = Math.min(
      MAX_WAIT_SECONDS,
      Math.max(0, Math.floor(Number(params.get("wait")) || 0)),
    );
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      // A relay that hung up (restarted, say) must not be handed a job it will never see.
      if (request.signal?.aborted) return new Response(null, { status: 499 });
      const jobs = await store.takeJobs(
        relay.user_id,
        JOBS_PER_POLL,
        kinds.flatMap((kind) => RUNS[kind]),
      );
      if (jobs.length || Date.now() + WAIT_STEP_MS > deadline) {
        const ctx = jobs.some((job) => job.runner !== "claude-continue") ? await botFor() : null;
        return Response.json(
          await Promise.all(
            jobs.map(async (job) => ({
              id: job.id,
              runner: job.runner,
              session: job.target_session,
              text: job.body,
              // As queued: a job keeps the sandbox and directory it was enqueued with.
              ...(job.params ? (JSON.parse(job.params) as object) : {}),
              ...(job.runner === "codex-resume" ? { thread: job.thread } : {}),
              // A Codex run's own MCP token, bound to its session, for as long as the run may last.
              ...(ctx && job.runner !== "claude-continue"
                ? {
                    token: (
                      await mintSessionToken(
                        ctx,
                        relay.user_id,
                        job.target_session,
                        CODEX_TAKEN_SECONDS,
                      )
                    ).token,
                  }
                : {}),
            })),
          ),
        );
      }
      await sleep(WAIT_STEP_MS);
    }
  }

  const path = /^\/relay\/jobs\/(ask_[\w-]{6,32})(\/started)?$/.exec(pathname);
  const id = path?.[1];
  if (!id || request.method !== "POST") return new Response(null, { status: 404 });
  let report: { ok?: unknown; error?: unknown; thread?: unknown };
  try {
    report = await request.json<{ ok?: unknown; error?: unknown; thread?: unknown }>();
  } catch {
    return new Response("expected JSON\n", { status: 400 });
  }
  // A report is a sign of life too: a long job must not make the relay look gone.
  await store.touchRelay(relay.user_id, now);
  const thread =
    typeof report.thread === "string" && THREAD.test(report.thread) ? report.thread : null;
  if (path?.[2]) {
    // A Codex start runs on; the thread it made can take messages once it is done.
    const job = await store.getJob(relay.user_id, id);
    if (job?.status !== "taken" || job.runner !== "codex-start" || !thread) {
      return new Response(null, { status: 404 });
    }
    await store.setAgentThread(relay.user_id, job.target_session, thread);
    return new Response(null, { status: 204 });
  }
  const job = await store.finishJob(relay.user_id, id, {
    ok: report.ok === true,
    error: report.ok === true ? null : errorOf(report.error),
  });
  if (!job) return new Response(null, { status: 404 });
  // The thread may come only with the report, if the relay could not tell it sooner.
  if (job.runner === "codex-start" && thread) {
    await store.setAgentThread(relay.user_id, job.target_session, thread);
  }
  if (job.status === "done" && job.runner === "codex-start" && !thread) {
    // Done, yet no thread was ever told: nothing can follow it.
    const session = await store.getAgentSession(relay.user_id, job.target_session);
    if (!session?.external_id) {
      await fallBack(await botFor(), { ...job, error: "Codex told no thread id" }, "failed");
    }
  } else if (job.status === "done") {
    if (job.runner === "claude-continue" && relay.login_failed_at) {
      await store.setRelayLogin(relay.user_id, null);
    }
  } else {
    const login =
      job.runner === "claude-continue" &&
      /session expired|\/login|not logged in|sign in again/i.test(job.error ?? "");
    if (login && !relay.login_failed_at) {
      await store.setRelayLogin(relay.user_id, now);
      await tellUser(await botFor(), relay.user_id, "login");
    }
    console.error(
      JSON.stringify({ event: "relay_job_failed", user: relay.user_id, error: job.error }),
    );
    await fallBack(await botFor(), job, login ? "login" : "failed");
  }
  return new Response(null, { status: 204 });
}

/** A Codex thread's id, as the relay tells it: never one a command line would take for an option. */
const THREAD = /^[A-Za-z0-9][\w-]{7,63}$/;

const errorOf = (error: unknown) =>
  (typeof error === "string" ? error : "unknown error").slice(0, ERROR_LIMIT);

/**
 * Stale jobs fail; a Telegram reply among them starts a session instead. A
 * relay gone quiet with work waiting is told to the user once — unless it is
 * signed out, which they heard about already. A few jobs a sweep, each failed
 * only as what becomes of it runs: the rest wait for the next sweep.
 */
export async function sweepRelays(
  store: Store,
  botFor: () => Promise<BotContext>,
  fallBack: FallBack,
): Promise<void> {
  const now = nowSeconds();
  const stale = await store.staleJobs(
    {
      queued: now - JOB_EXPIRY_SECONDS,
      taken: now - TAKEN_EXPIRY_SECONDS,
      codexQueued: now - CODEX_QUEUED_SECONDS,
      codexHeld: now - CODEX_HELD_SECONDS,
      codexTaken: now - CODEX_TAKEN_SECONDS,
      online: now - ONLINE_SECONDS,
    },
    SWEEP_LIMIT,
  );
  if (!stale.length) return;
  const ctx = await botFor();
  const seen = new Set<number>();
  const restarted = new Set<string>();
  const relays = new Map<number, RelayRow | null>();
  for (const found of stale) {
    const job = await store.expireJob(found);
    // Taken, reported or folded into another since it was found: it is not stale any more.
    if (!job) continue;
    // The day's messages for one session start one new session; the rest join it.
    const day = `${job.user_id}:${job.target_session}`;
    if (job.kind === "day" && restarted.has(day)) {
      if (job.chat_id !== null && job.message_id !== null) {
        await ctx.store.endFire(job.chat_id, job.message_id, { status: "joined" });
      }
      continue;
    }
    if (job.kind === "day") restarted.add(day);
    if (!relays.has(job.user_id)) relays.set(job.user_id, await store.getRelay(job.user_id));
    const row = relays.get(job.user_id) ?? null;
    // Claude's sign-in is no matter for Codex.
    const claude = job.runner === "claude-continue";
    const state = claude ? relayState(row, now) : codexRelayState(row, now);
    // A Codex job that waited out a long start, with the relay there, is no sign it went quiet.
    if (!seen.has(job.user_id) && job.taken_at === null && (claude || state !== "online")) {
      seen.add(job.user_id);
      if (state !== "login" && (await store.noteRelayOffline(job.user_id, now))) {
        await tellUser(ctx, job.user_id, "offline");
      }
    }
    await fallBack(
      ctx,
      job,
      state === "login" ? "login" : job.taken_at === null ? "offline" : "failed",
    );
  }
}

async function tellUser(ctx: BotContext, userId: number, what: "login" | "offline"): Promise<void> {
  const t = texts((await ctx.store.getUser(userId))?.language);
  await ctx.api
    .call("sendMessage", {
      chat_id: userId,
      text: what === "login" ? t.relayLoginLost : t.relayWentOffline,
      parse_mode: "HTML",
      disable_notification: true,
    })
    .catch(() => undefined);
}
