/**
 * What the model is told. Server instructions are read once per session;
 * every tool description is read on every turn, so those stay short and say
 * *when* to use the tool and which neighbour to use instead.
 *
 * The limits of the history are spelled out on purpose. A model that does
 * not know the bot only sees what it was sent, for N days, will search, find
 * nothing, and conclude something never happened.
 */

export function instructions(p: { retentionDays: number; botUsername: string }): string {
  return `A Telegram bot (@${p.botUsername}) that connects you to the user. Use it to reach them when they are away from this conversation, and to read what they — or groups they connected — sent to the bot.

When to use it
- The user says "message me / ping me / tell me in Telegram / send me the file / ask me there", or asked to be told when a long task finishes or fails: send to "me" (their private chat with the bot, the default).
- Post to a group only when the user names it. Group posts are seen by every member.
- Do not narrate progress unless asked: one message at the end beats ten. For a long task, one message you edit_message as it goes is fine.
- After sending, give the user the t.me link from the result so they can jump straight there.

Decisions while the user is away
- ask_user sends a question with answer buttons and waits for the press (or a typed reply). If it returns no answer yet, call wait_for_reply again, or continue with work that does not depend on the answer — never assume an answer.

Files
- Built a file and have a shell (Claude Code, a sandbox with network)? create_upload_url, then run the curl command it returns. No base64 needed, up to 50 MB.
- No shell: send_file with the text, or base64 for small binaries (≤1 MB).
- A file the user sent: get_file. It returns a download link (for curl) and the content itself when small.

Reading
- The bot only knows what it received: its private chat with the user, and groups from list_chats from the time the bot joined or the user connected them. Messages older than ${p.retentionDays} days are deleted and gone for good. It cannot see the user's other Telegram chats. Deleted messages may still show; edits show the latest text.
- "I sent you X in Telegram" → get_recent_messages (chat "me") first, then search_messages.
- search_messages looks at the last day unless you pass since. Widen deliberately ("3d", "7d") when the question is about older things; "${p.retentionDays}d" reads everything stored and is expensive on busy groups, so use it only when narrower windows came up empty and the user needs it.
- "Where did I tag you / what did they ask you" → search_messages with mentions_only. A mention that is a reply shows the message it replies to (↩); get_recent_messages with around_message_id walks the messages around it for context, and get_message follows the reply chain.
- Forum groups have topics (threads): list_chats names them; pass topic to read or post within one.
- If a search finds nothing, say what you searched and over which window (the result states it), rather than concluding it never happened.

Style: write normal Markdown, it is converted for Telegram. Keep messages short and scannable. Message and chat ids are for your calls; show the user links, not ids.`;
}

/** Appended to every tool that posts to a chat. */
export const GROUP_NOTE = "Group posts are visible to every member.";

/** Appended to read tools, where the model decides whether "nothing found" means anything. */
export function retentionNote(days: number): string {
  return `Only messages the bot received in the last ${days} days exist.`;
}
