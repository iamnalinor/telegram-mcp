/**
 * MCP tool surface.
 *
 * A fresh server is built per request, for that request's user, so nothing is
 * shared between users. Tools live in src/tools/: sending, changing what was
 * sent, and reading. The instructions in src/prompts.ts tell the model when
 * to reach for each.
 */

import { McpServer } from "@modelcontextprotocol/server";

import { instructions } from "./prompts";
import type { ToolContext } from "./tools/common";
import { registerEditTools } from "./tools/edit";
import { registerReadTools } from "./tools/read";
import { registerSendTools } from "./tools/send";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "telegram", title: "Telegram", version: "1.0.0" },
    {
      instructions: instructions({
        retentionDays: ctx.config.retentionDays,
        botUsername: ctx.bot.username,
      }),
    },
  );
  registerSendTools(server, ctx);
  registerEditTools(server, ctx);
  registerReadTools(server, ctx);
  return server;
}
