/**
 * Claude: the user's routine starts cloud sessions (src/routine.ts), and the
 * relay, when they run one, passes messages into them (src/relay.ts).
 */

import { enqueue, relayRuns, relayState } from "../relay";
import type { RelayRow } from "../store";
import { fire, firePayload, guestPayload, loadRoutine, scenePayload } from "../routine";
import { sessionLink, type Provider, type StartRequest } from "./types";

/** What a start tells the session; OpenAI's sessions get the same, with their id added. */
export function payloadOf(request: StartRequest): string {
  switch (request.kind) {
    case "test":
      return firePayload({ chat: request.chat, message: request.message, by: "test" });
    case "message":
      return firePayload(request);
    case "guest":
      return guestPayload(request.call, request.by, request.continues);
    case "scene":
      return scenePayload(request.scene, request.seq, request.by);
  }
}

/** Whether the relay passes messages into Claude's sessions: one that runs only Codex does not. */
function reachOf(row: RelayRow | null) {
  return row && !relayRuns(row).includes("claude") ? "none" : relayState(row);
}

export const claude: Provider = {
  kind: "claude",
  // Anthropic allows a routine about 30 starts an hour.
  limits: { startsPerHour: 30 },

  async status(ctx, holder) {
    const routine = await loadRoutine(ctx.store, ctx.config.secretKey, holder);
    return {
      start: typeof routine === "string" ? routine : "set",
      reach: reachOf(await ctx.store.getRelay(holder)),
    };
  },

  async start(ctx, holder, request) {
    const routine = await loadRoutine(ctx.store, ctx.config.secretKey, holder);
    if (typeof routine === "string") return { ok: false, reason: routine, detail: routine };
    return fire(routine.triggerId, routine.token, payloadOf(request));
  },

  async deliver(ctx, holder, delivery) {
    const reach = reachOf(await ctx.store.getRelay(holder));
    if (reach !== "online") return { ok: false, reach };
    const ask = await enqueue(
      ctx.store,
      { ...delivery.job, user_id: holder, target_session: delivery.session },
      delivery.envelope,
    );
    return { ok: true, ask };
  },

  link: sessionLink,
};
