/**
 * Who may read and write which chat.
 *
 * A user always has their own private chat with the bot. Groups need a grant
 * — made when the user adds the bot, or by /connect — and a grant only ever
 * belongs to one user: two people on one group have two grants, and revoking
 * one leaves the other alone. Messages are stored once per chat regardless.
 *
 * A grant is not forever. People leave groups, and a bot that is not an admin
 * is never told. So a grant older than `REVALIDATE_SECONDS` is checked against
 * getChatMember before it is used, and dropped if the user is gone. That is at
 * most one Bot API call per group per user per interval.
 */

import { nowSeconds } from "./crypto";
import { chatLink } from "./links";
import type { GrantRow, GrantWithChat, Scope, Store } from "./store";
import { TelegramError, type TelegramApi } from "./telegram/api";
import { isMember, type ChatMember } from "./telegram/types";

const REVALIDATE_SECONDS = 60 * 60;

export interface ChatView extends Scope {
  kind: "dm" | "group";
  type: string;
  title: string;
  username: string | null;
  is_forum: boolean;
  /** `added_bot` or `connect`; absent for the DM. */
  source?: GrantRow["source"];
  link: string | null;
}

/** A refusal the model should read and relay — not a crash. */
export class AccessError extends Error {}

/** Telegram says this user is not, or no longer, in the chat. */
function isGoneError(error: TelegramError): boolean {
  return /user not found|participant_id_invalid|member not found|user_not_participant/i.test(
    error.description,
  );
}

/** Telegram says the bot can no longer see the chat at all. */
export function isChatGoneError(error: TelegramError): boolean {
  return (
    error.code === 403 ||
    /chat not found|bot was kicked|bot is not a member|group chat was upgraded/i.test(
      error.description,
    )
  );
}

export class Access {
  constructor(
    private readonly store: Store,
    private readonly api: TelegramApi,
    readonly userId: number,
    private readonly botUsername: string,
  ) {}

  dm(): ChatView {
    return {
      kind: "dm",
      chat_id: this.userId,
      visible_from: 0,
      type: "private",
      title: "Private chat with the bot",
      username: null,
      is_forum: false,
      link: chatLink({ chat_id: this.userId, type: "private" }, this.botUsername),
    };
  }

  private view(grant: GrantWithChat): ChatView {
    return {
      kind: "group",
      chat_id: grant.chat_id,
      visible_from: grant.visible_from,
      type: grant.type,
      title: grant.title ?? grant.username ?? String(grant.chat_id),
      username: grant.username,
      is_forum: grant.is_forum === 1,
      source: grant.source,
      link: chatLink(grant, this.botUsername),
    };
  }

  /**
   * Check a grant against Telegram when it is due. Resolves to false when the
   * grant has been dropped. A Telegram outage keeps the grant: refusing the
   * user their own group over a hiccup is the worse failure.
   */
  private async revalidate(grant: GrantRow): Promise<boolean> {
    if (nowSeconds() - grant.verified_at < REVALIDATE_SECONDS) return true;

    let member: ChatMember;
    try {
      member = await this.api.call<ChatMember>("getChatMember", {
        chat_id: grant.chat_id,
        user_id: grant.user_id,
      });
    } catch (error) {
      if (!(error instanceof TelegramError)) return true;
      if (isChatGoneError(error)) {
        await this.store.deleteChat(grant.chat_id);
        return false;
      }
      if (isGoneError(error)) {
        await this.drop(grant.chat_id);
        return false;
      }
      return true;
    }

    if (!isMember(member)) {
      await this.drop(grant.chat_id);
      return false;
    }
    await this.store.touchGrant(grant.user_id, grant.chat_id);
    return true;
  }

  /** Remove this user's grant; the last grant on a chat takes the chat's history with it. */
  async drop(chatId: number): Promise<void> {
    await this.store.revokeGrant(this.userId, chatId);
  }

  async groups(): Promise<ChatView[]> {
    const grants = await this.store.listGrants(this.userId);
    const valid = await Promise.all(grants.map((grant) => this.revalidate(grant)));
    return grants.filter((_, index) => valid[index]).map((grant) => this.view(grant));
  }

  async all(): Promise<ChatView[]> {
    return [this.dm(), ...(await this.groups())];
  }

  /**
   * Resolve what the model passed as `chat`: nothing or "me" for the DM, a
   * numeric id, an @username, or a title. Only chats this user may access
   * are candidates, so a guess can never reach someone else's group.
   */
  async resolve(arg: string | number | undefined | null): Promise<ChatView> {
    const raw = arg === undefined || arg === null ? "" : String(arg).trim();
    const lowered = raw.toLowerCase();
    if (!raw || ["me", "dm", "private", "self"].includes(lowered) || raw === String(this.userId)) {
      return this.dm();
    }

    const groups = await this.groups();
    const describe = () =>
      groups.length
        ? `Available: "me" (the private chat), ${groups.map((g) => `${g.chat_id} "${g.title}"`).join(", ")}.`
        : 'Only "me" (the private chat) is available: the user has connected no groups. ' +
          "They can add the bot to a group, or send /connect there.";

    if (/^-?\d+$/.test(raw)) {
      const found = groups.find((group) => group.chat_id === Number(raw));
      if (found) return found;
      throw new AccessError(`Chat ${raw} is not one this user has connected. ${describe()}`);
    }

    const handle = lowered.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
    const byUsername = groups.find((group) => group.username?.toLowerCase() === handle);
    if (byUsername) return byUsername;

    const byTitle = groups.filter((group) => group.title.toLowerCase() === lowered);
    if (byTitle.length === 1) return byTitle[0];

    const partial = groups.filter((group) => group.title.toLowerCase().includes(lowered));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1 || byTitle.length > 1) {
      throw new AccessError(`"${raw}" matches several chats; pass the numeric id. ${describe()}`);
    }
    throw new AccessError(`No connected chat matches "${raw}". ${describe()}`);
  }
}
