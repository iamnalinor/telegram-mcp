/**
 * Task sessions: an OpenAI chat session (src/agents/openai.ts) hands real
 * work to a second session with a machine of its own and a stronger model.
 * Only a chat session's own token offers the tool: Claude sessions have
 * subagents, and a task does not start tasks.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CAPPED, startTask } from "../agents/openai";
import { providerOf } from "../agents/types";
import { text, ToolError, toolError, type ToolContext } from "./common";
import { originOf } from "./sessions";

const BRIEF_LIMIT = 8000;
/** Each task is a costly session on the user's key: a runaway chat must not start dozens. */
const TASKS_PER_HOUR = 10;

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  const from = ctx.session;
  if (!from || providerOf(from) !== "openai") return;
  server.registerTool(
    "start_task",
    {
      title: "Start a task session",
      description:
        "Hand real work — research, code, many steps — to a new task session on a stronger model, with a " +
        "machine of its own. It sees only your brief, so make it stand on its own: the chat and message the " +
        "work is for, who asked and what they want, what you know so far, and that the usual rules hold for " +
        "whoever asked. It sends its result itself, as a reply to that message. Returns its session id: " +
        "message_session reaches it while it runs. Each task costs the user real money.",
      inputSchema: z.object({
        brief: z.string().min(1).max(BRIEF_LIMIT).describe("What to do, standing on its own."),
        chat: z
          .number()
          .int()
          .optional()
          .describe("The chat id of the message the work is for, as in your payload."),
        topic: z.number().int().positive().optional().describe("Its forum topic, if any."),
        message: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("That message's id: the task replies to it."),
      }),
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const own = await ctx.store.getAgentSession(ctx.userId, from);
        if (own?.kind !== "chat") {
          throw new ToolError("Only a chat session can start a task: do the work yourself.");
        }
        const result = await startTask(ctx, ctx.userId, ctx.user, {
          from,
          // Whom this session acts for is the bot's to say, not the brief's: the task inherits it.
          origin: await originOf(ctx, from, undefined),
          brief: args.brief,
          chat: args.chat ?? null,
          topic: args.topic ?? null,
          message: args.message ?? null,
          cap: TASKS_PER_HOUR,
        });
        if (result === CAPPED) {
          throw new ToolError(
            `${TASKS_PER_HOUR} tasks were started in the last hour: no more for now. Tell whoever asked.`,
          );
        }
        if (!result.ok) {
          throw new ToolError(
            `Not started (${result.reason}): OpenAI's API did not take it. Do it yourself if you can, ` +
              "or tell whoever asked.",
          );
        }
        return text(
          `Started task session ${result.sessionId}. It sends its result itself; message_session ` +
            "reaches it while it runs.",
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}
