/**
 * The slice of Bot API types this connector reads. Hand-written rather than
 * pulled from a package: Telegram adds fields all the time, and every field
 * here is optional unless the API guarantees it, so a new one never breaks us.
 */

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  can_read_all_group_messages?: boolean;
  /** Only in getMe: guest mode is on in @BotFather. */
  supports_guest_queries?: boolean;
}

type ChatType = "private" | "group" | "supergroup" | "channel";

interface Chat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

/** getChat's answer. `has_visible_history` is only filled in for administrators. */
export interface ChatFullInfo extends Chat {
  has_visible_history?: boolean;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: User;
  url?: string;
}

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface FileBase {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface MessageOrigin {
  type: "user" | "hidden_user" | "chat" | "channel";
  sender_user?: User;
  sender_user_name?: string;
  sender_chat?: Chat;
  chat?: Chat;
}

interface ChatShared {
  request_id: number;
  chat_id: number;
  title?: string;
  username?: string;
}

interface ChecklistTask {
  id: number;
  text: string;
  /** Set once the task is done. */
  completion_date?: number;
}

interface Checklist {
  title: string;
  tasks: ChecklistTask[];
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: User;
  sender_chat?: Chat;
  date: number;
  edit_date?: number;
  chat: Chat;
  forward_origin?: MessageOrigin;
  /** Sent through an inline bot: the sender picked its result, did not write it. */
  via_bot?: User;
  /** Service message: a member left or was removed. */
  left_chat_member?: User;
  reply_to_message?: Message;
  /** Shared by the photos and files sent together as one album. */
  media_group_id?: string;
  /** The part of the replied-to message the sender highlighted. */
  quote?: { text: string };
  /** A reply to a message in another chat. */
  external_reply?: { origin?: MessageOrigin; chat?: Chat; message_id?: number };
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  caption_entities?: MessageEntity[];
  document?: FileBase;
  photo?: PhotoSize[];
  video?: FileBase;
  audio?: FileBase & { title?: string; performer?: string };
  voice?: FileBase;
  video_note?: FileBase;
  animation?: FileBase;
  sticker?: FileBase & { emoji?: string };
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name: string; last_name?: string };
  poll?: { question: string; options: { text: string }[] };
  checklist?: Checklist;
  /**
   * Service messages: tasks of a checklist were ticked or unticked, or added.
   * `checklist_message` is the checklist as it now is (without its own reply).
   * Telegram has no separate update for checklists; these and edited_message are all there is.
   * Bots send checklists only for a business account, so no scene can own one.
   */
  checklist_tasks_done?: {
    checklist_message?: Message;
    marked_as_done_task_ids?: number[];
    marked_as_not_done_task_ids?: number[];
  };
  checklist_tasks_added?: { checklist_message?: Message; tasks: ChecklistTask[] };
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string };
  dice?: { emoji: string; value: number };
  game?: { title: string; description: string };
  invoice?: { title: string; description: string };
  /** A forwarded story: only who posted it comes along. */
  story?: { chat: Chat; id: number };
  giveaway?: { winner_count: number; prize_description?: string };
  paid_media?: { star_count: number };
  /** Service message; an old pinned message comes with date 0 and nothing else. */
  pinned_message?: Pick<Message, "message_id" | "date" | "chat">;
  chat_shared?: ChatShared;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  migrate_to_chat_id?: number;
  new_chat_title?: string;
  reply_markup?: InlineKeyboardMarkup;
  /** A message with structured formatting; its content is in blocks, not in `text`. */
  rich_message?: { blocks?: unknown[] };
  /** An HTML widget drawn inside the message. */
  widget?: { id?: string; chat_data?: string; public_data?: string };
  live_photo?: FileBase;
  /** On a guest message: what answerGuestQuery takes to reply in a chat the bot is not in. */
  guest_query_id?: string;
  /** On a message only one member sees: its id among such messages; it has no ordinary id. */
  ephemeral_message_id?: number;
  /** Set on messages of a chat managed through a business connection. */
  business_connection_id?: string;
  /** On the account owner's outgoing messages: the bot that sent it on their behalf. */
  sender_business_bot?: User;
}

/** What the account owner let the bot do, in Telegram's settings. Absent fields are false. */
export interface BusinessBotRights {
  can_reply?: boolean;
  can_read_messages?: boolean;
  can_delete_sent_messages?: boolean;
  can_delete_all_messages?: boolean;
}

export interface BusinessConnection {
  id: string;
  user: User;
  user_chat_id: number;
  date: number;
  rights?: BusinessBotRights;
  is_enabled: boolean;
}

export interface BusinessMessagesDeleted {
  business_connection_id: string;
  chat: Chat;
  message_ids: number[];
}

type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export interface ChatMember {
  status: ChatMemberStatus;
  user: User;
  /** Only for "restricted": whether they are still in the chat. */
  is_member?: boolean;
}

export interface ChatMemberUpdated {
  chat: Chat;
  from: User;
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
}

export interface CallbackQuery {
  id: string;
  from: User;
  message?: Message;
  data?: string;
}

interface ReactionType {
  type: "emoji" | "custom_emoji" | "paid";
  emoji?: string;
}

export interface MessageReactionUpdated {
  chat: Chat;
  message_id: number;
  user?: User;
  date: number;
  new_reaction: ReactionType[];
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  my_chat_member?: ChatMemberUpdated;
  chat_member?: ChatMemberUpdated;
  callback_query?: CallbackQuery;
  message_reaction?: MessageReactionUpdated;
  business_connection?: BusinessConnection;
  business_message?: Message;
  edited_business_message?: Message;
  deleted_business_messages?: BusinessMessagesDeleted;
  /** The bot was called in a chat it is not a member of (guest mode). */
  guest_message?: Message;
  widget_query?: WidgetQuery;
  /** New state of a poll the bot sent. */
  poll?: Poll;
  /** A vote in a non-anonymous poll the bot sent. */
  poll_answer?: PollAnswer;
}

export interface Poll {
  id: string;
  question: string;
  options: { text: string; voter_count: number }[];
  total_voter_count: number;
  is_closed: boolean;
}

export interface PollAnswer {
  poll_id: string;
  /** Set instead of `user` when the voter is anonymous (a chat). */
  voter_chat?: Chat;
  user?: User;
  option_ids: number[];
}

/** A tap inside a widget the bot sent: its script asked the bot something. */
export interface WidgetQuery {
  id: string;
  from: User;
  chat?: Chat;
  message_id?: number;
  data: string;
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "primary" | "success" | "danger";
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface WebhookInfo {
  url: string;
  allowed_updates?: string[];
  pending_update_count: number;
  last_error_message?: string;
}

export function isMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member !== false;
  return true;
}

export function displayName(user: Pick<User, "first_name" | "last_name">): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}
