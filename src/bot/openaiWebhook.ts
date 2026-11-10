/**
 * OpenAI's webhooks for Agents API sessions: `POST /openai/webhook/<path>`,
 * the path random per user (src/agents/openai.ts). The user pastes the URL
 * into OpenAI's dashboard and sends the bot the signing secret; from then on
 * a session that fails, or stops to wait for an action the bot cannot take,
 * is told in the private chat. Every other event is acknowledged and dropped.
 *
 * Signed as Standard Webhooks: HMAC-SHA256 over `<id>.<timestamp>.<body>`
 * with the secret after `whsec_`, base64. A request that fails any check gets
 * a bare 400; one for a session the bot does not know of, a 200.
 */

import { hookHash, loadOpenAI } from "../agents/openai";
import { bytesToBase64, hmac, hmacKey, nowSeconds, timingSafeEqual } from "../crypto";
import { isAllowed } from "../env";
import { messageLink } from "../links";
import { isGuestKey, type Store } from "../store";
import type { Config } from "../env";
import type { BotContext } from "./context";
import { texts } from "./texts";

export const OPENAI_WEBHOOK_PATH = "/openai/webhook/";

/** How far the signed time may be from ours, either way. */
const TOLERANCE_SECONDS = 300;
/** Events are a few hundred bytes; anything far larger is not one. */
const MAX_BODY = 64 * 1024;

const rejected = () => new Response(null, { status: 400 });
const ignored = () => new Response(null, { status: 200 });

/** Whether the request carries a valid signature by `secret`, made within the window. */
async function verifyWebhook(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds() - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  if (!raw.length) return false;
  const expected = bytesToBase64(await hmac(await hmacKey(raw), `${id}.${timestamp}.${body}`));
  // Several signatures while a secret is rotated: any one valid will do.
  let valid = false;
  for (const entry of signatures.split(" ")) {
    const [version, signature] = entry.split(",", 2);
    if (version === "v1" && signature && timingSafeEqual(signature, expected)) valid = true;
  }
  return valid;
}

interface Event {
  type?: unknown;
  data?: { id?: unknown };
}

export async function handleOpenAIWebhook(
  request: Request,
  pathname: string,
  core: { store: Store; config: Config },
  botFor: () => Promise<BotContext>,
): Promise<Response> {
  const path = pathname.slice(OPENAI_WEBHOOK_PATH.length);
  if (request.method !== "POST" || !/^[\w-]{16,64}$/.test(path)) return rejected();
  const owner = await core.store.agentByHook(await hookHash(path));
  if (owner?.provider !== "openai" || !isAllowed(core.config, owner.user_id)) return rejected();
  const config = await loadOpenAI(core.store, core.config.secretKey, owner.user_id);
  if (
    typeof config === "string" ||
    !config.webhookSecret ||
    !timingSafeEqual(config.webhookPath ?? "", path)
  ) {
    return rejected();
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return rejected();
  const body = await request.text();
  if (body.length > MAX_BODY) return rejected();
  if (!(await verifyWebhook(config.webhookSecret, request.headers, body))) return rejected();

  let event: Event | null;
  try {
    event = JSON.parse(body) as Event | null;
  } catch {
    return rejected();
  }
  const what =
    event?.type === "agent.session.failed"
      ? "failed"
      : event?.type === "agent.session.action_required"
        ? "action"
        : null;
  const external = event?.data?.id;
  if (!what || typeof external !== "string") return ignored();
  // Only the user's own sessions: a secret of theirs cannot speak for anyone else's.
  const session = await core.store.agentSessionByExternal(owner.user_id, "openai", external);
  // OpenAI retries until it hears 200: each thing is said once.
  if (!session || !(await core.store.tellOnce(session.id, what))) return ignored();

  const ctx = await botFor();
  await tell(ctx, owner.user_id, session.id, what).catch((error: unknown) =>
    console.error(
      JSON.stringify({
        event: "openai_webhook_tell_failed",
        user: owner.user_id,
        error: String(error),
      }),
    ),
  );
  return ignored();
}

/** The user hears of it in the private chat, as a reply to the message that started it if it was there. */
async function tell(
  ctx: BotContext,
  userId: number,
  session: string,
  what: "failed" | "action",
): Promise<void> {
  const t = texts((await ctx.store.getUser(userId))?.language);
  const fire = await ctx.store.firstFireOf(userId, session);
  let from: { chat: string; link: string | null } | null = null;
  if (fire && fire.chat_id !== userId && !isGuestKey(fire.chat_id)) {
    const chat = await ctx.store.getChat(fire.chat_id);
    if (chat) {
      from = {
        chat: chat.title ?? String(chat.chat_id),
        link: messageLink(chat, fire.message_id, null, ctx.bot.username),
      };
    }
  }
  await ctx.api.call("sendMessage", {
    chat_id: userId,
    text: what === "failed" ? t.agentFailed(session, from) : t.agentStuck(session, from),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(fire?.chat_id === userId
      ? { reply_parameters: { message_id: fire.message_id, allow_sending_without_reply: true } }
      : {}),
  });
}
