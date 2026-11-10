/**
 * Worker entrypoint.
 *
 * Routes:
 *   GET  /                 in a browser: setup status page (also registers the webhook)
 *   POST /                 MCP over HTTP, behind a bearer token
 *   /.well-known/oauth-*, /register, /authorize, /auth/telegram, /token — OAuth, see src/oauth.ts
 *   POST /telegram         the bot's webhook, see src/bot/webhook.ts
 *   PUT  /upload/<signed>  one-time file upload, see src/files.ts
 *   GET  /file/<signed>    attachment download
 *   GET  /health           liveness
 *   /relay/…               the user's relay to Claude Code sessions, see src/relay.ts
 *   POST /openai/webhook/<path>  OpenAI's events about the user's sessions, see src/bot/openaiWebhook.ts
 *
 * Scheduled: daily, delete messages past retention and re-check the webhook;
 * every few minutes, fail relay jobs nobody picked up (src/relay.ts).
 */

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";

import { escapeHtml } from "./bot/texts";
import { ensureWebhook, WEBHOOK_PATH } from "./bot/setup";
import { handleWebhook } from "./bot/webhook";
import { handleOpenAIWebhook, OPENAI_WEBHOOK_PATH } from "./bot/openaiWebhook";
import { base, botContext, toolContext, type Base } from "./context";
import { nowSeconds } from "./crypto";
import { isAllowed, type Env } from "./env";
import { handleDownload, handleUpload } from "./files";
import { allow, tokenKey, tooManyRequests } from "./limits";
import { createServer } from "./mcp";
import { handleRelay, sweepRelays } from "./relay";
import {
  authorizeMcpRequest,
  handleOAuthRequest,
  isOAuthPath,
  page,
  publicOrigin,
  type McpAuth,
} from "./oauth";
import { botIdentity } from "./telegram/api";
import type { WebhookInfo } from "./telegram/types";
import type { ToolContext } from "./tools/common";
import { drawFinished, endScene } from "./bot/scenes";
import { stillMember } from "./bot/triggers";
import { fallBack } from "./bot/fallback";

/**
 * One handler per isolate — it outlives requests. The server inside is built
 * per request from that request's own context, carried in authInfo.extra, so
 * users never share state.
 */
const handler: McpHttpHandler = createMcpHandler((ctx) => {
  const toolCtx = ctx.authInfo?.extra?.toolContext as ToolContext | undefined;
  if (!toolCtx) throw new Error("The MCP handler was reached without an authenticated user.");
  return createServer(toolCtx);
});

async function oauthDeps(core: Base, env: Env) {
  const me = await botIdentity(core.api);
  return { env, config: core.config, store: core.store, botUsername: me.username ?? "" };
}

async function statusPage(request: Request, core: Base): Promise<Response> {
  const origin = publicOrigin(request);
  const me = await botIdentity(core.api);
  let webhook: string;
  try {
    const bound = await ensureWebhook(core.api, core.config, core.store, origin);
    const info = await core.api.call<WebhookInfo>("getWebhookInfo");
    webhook =
      bound !== origin
        ? `bound to ${bound}, not this address`
        : info.url === `${origin}${WEBHOOK_PATH}`
          ? info.last_error_message
            ? "registered (Telegram reported a delivery error recently)"
            : "registered"
          : `points elsewhere (${info.url || "none"})`;
  } catch (error) {
    webhook = `could not register: ${error instanceof Error ? error.message : String(error)}`;
  }
  const host = new URL(origin).host;
  const bot = escapeHtml(me.username ?? "");
  const row = (label: string, value: string) =>
    `<div><span>${label}</span><span>${value}</span></div>`;
  return page(
    "Telegram MCP",
    `<h1>@${bot}</h1>
<p>Add this URL as a custom connector in Claude or ChatGPT:</p>
<p><code>${escapeHtml(origin)}/</code></p>
<div class="rows">
${row("Webhook", escapeHtml(webhook))}
${row("Privacy mode", me.can_read_all_group_messages ? "off" : "on — @BotFather → /setprivacy → Disable, then re-add the bot to groups")}
${row("Login domain", `@BotFather → /setdomain → <code>${escapeHtml(host)}</code>`)}
${row("Your Telegram ID", `send /start to <a href="https://t.me/${bot}">the bot</a>`)}
</div>`,
  );
}

async function handleMcp(
  request: Request,
  env: Env,
  core: Base,
  defer: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const deps = await oauthDeps(core, env);
  const authInfo = await authorizeMcpRequest(request, deps);
  if (authInfo instanceof Response) return authInfo;

  // Metered per user, never per IP: Claude's and ChatGPT's calls come from shared addresses.
  if (!(await allow(env.MCP_LIMIT, await tokenKey(authInfo.token)))) {
    return tooManyRequests("Too many requests for this user. Wait a minute and try again.");
  }

  const { userId, username, name, client, session } = authInfo.extra as unknown as McpAuth;
  const toolCtx = await toolContext(core, publicOrigin(request), userId, {
    username,
    name,
    client,
    session,
  });
  // A scene's held-back redraw finishes after the answer is sent.
  toolCtx.defer = defer;
  return handler.fetch(request, {
    authInfo: { ...authInfo, extra: { ...authInfo.extra, toolContext: toolCtx } },
  });
}

/** Scenes ended per daily run: each may be an edit, and a Worker run makes only so many calls. */
const IDLE_SCENES_PER_RUN = 30;

/** Must match the second cron in wrangler.jsonc. */
const RELAY_SWEEP = "*/5 * * * *";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", mcp_endpoint: `${publicOrigin(request)}/` });
    }

    let core: Base;
    try {
      core = await base(env);
    } catch (error) {
      return new Response(`${error instanceof Error ? error.message : String(error)}\n`, {
        status: 500,
      });
    }

    if (pathname === WEBHOOK_PATH) {
      return handleWebhook(
        request,
        () =>
          botContext(core, publicOrigin(request), {
            defer: (promise) => ctx.waitUntil(promise),
            sceneLimit: env.SCENE_LIMIT,
          }),
        core,
      );
    }

    if (isOAuthPath(pathname)) {
      if (pathname === "/authorize") {
        // Opening the connector is a good moment to make sure the bot is listening.
        ctx.waitUntil(
          ensureWebhook(core.api, core.config, core.store, publicOrigin(request)).catch(
            (error: unknown) =>
              console.error(
                JSON.stringify({ event: "webhook_setup_failed", error: String(error) }),
              ),
          ),
        );
      }
      const response = await handleOAuthRequest(request, () => oauthDeps(core, env));
      if (response) return response;
    }

    if (pathname.startsWith("/relay/")) {
      const response = await handleRelay(
        request,
        pathname,
        core.store,
        publicOrigin(request),
        () => botContext(core, publicOrigin(request)),
        fallBack,
      );
      if (response) return response;
    }

    if (pathname.startsWith(OPENAI_WEBHOOK_PATH)) {
      return handleOpenAIWebhook(request, pathname, core, () =>
        botContext(core, publicOrigin(request)),
      );
    }

    const contextFor = (userId: number) => toolContext(core, publicOrigin(request), userId);
    if (pathname.startsWith("/upload/")) {
      return handleUpload(request, env.FILE_LIMIT, contextFor, core.config.signingKey);
    }
    if (pathname.startsWith("/file/")) {
      return handleDownload(request, env.FILE_LIMIT, contextFor, core.config.signingKey);
    }

    if (pathname === "/") {
      const browser =
        request.method === "GET" &&
        !request.headers.has("authorization") &&
        (request.headers.get("accept") ?? "").includes("text/html");
      if (browser) return statusPage(request, core);
      return handleMcp(request, env, core, (promise) => ctx.waitUntil(promise));
    }

    return new Response(null, { status: 404 });
  },

  async scheduled(event, env) {
    const core = await base(env);
    if (event.cron === RELAY_SWEEP) {
      await sweepRelays(
        core.store,
        async () => botContext(core, (await core.store.getMeta("public_origin")) ?? ""),
        fallBack,
      );
      return;
    }
    const cutoff = nowSeconds() - core.config.retentionDays * 86_400;
    const purged = await core.store.purge(cutoff);
    console.log(JSON.stringify({ event: "retention_purge", purged, cutoff }));

    // Claims of users no longer allowed go; a holder who left a group quietly
    // must not keep it from the others. Before the scenes: the ones a revoke
    // ends here are drawn below.
    for (const claim of await core.store.someClaudeChats(40)) {
      if (!isAllowed(core.config, claim.user_id)) await core.store.dropClaudeChats(claim.user_id);
      else if (
        claim.chat_id < 0 &&
        (await stillMember(core, claim.chat_id, claim.user_id)) === false
      ) {
        await core.store.revokeGrant(claim.user_id, claim.chat_id);
      }
    }

    // Scenes nobody touched within retention end (their buttons go, where Telegram
    // still lets the bot edit); finished ones go a retention later.
    // A finished scene whose last drawing Telegram held back is drawn now.
    const idle = await core.store.idleScenes(cutoff, IDLE_SCENES_PER_RUN);
    const undrawn = await core.store.undrawnScenes(IDLE_SCENES_PER_RUN);
    if (idle.length || undrawn.length) {
      const bot = await botContext(core, (await core.store.getMeta("public_origin")) ?? "");
      const failed = (scene: number) => (error: unknown) =>
        console.error(JSON.stringify({ event: "scene_end_failed", scene, error: String(error) }));
      for (const scene of idle) await endScene(bot, scene).catch(failed(scene));
      for (const scene of undrawn) await drawFinished(bot, scene).catch(failed(scene));
    }
    await core.store.dropFinishedScenes(cutoff);

    // Someone taken off ALLOWED_USER_IDS keeps no personal chats here, even if Telegram stays quiet.
    for (const userId of await core.store.businessUsers()) {
      if (!isAllowed(core.config, userId)) await core.store.dropPersonal(userId);
    }
    for (const userId of await core.store.memoryUsers()) {
      if (!isAllowed(core.config, userId)) await core.store.wipeMemory(userId);
    }
    for (const userId of await core.store.templateUsers()) {
      if (!isAllowed(core.config, userId)) await core.store.wipeTemplates(userId);
    }
    for (const userId of await core.store.routineUsers()) {
      if (!isAllowed(core.config, userId)) await core.store.deleteRoutine(userId);
    }
    for (const userId of await core.store.agentUsers()) {
      if (!isAllowed(core.config, userId)) await core.store.dropAgents(userId);
    }
    const origin = await core.store.getMeta("public_origin");
    if (origin) {
      await ensureWebhook(core.api, core.config, core.store, origin).catch((error: unknown) =>
        console.error(JSON.stringify({ event: "webhook_setup_failed", error: String(error) })),
      );
    }
  },
} satisfies ExportedHandler<Env>;
