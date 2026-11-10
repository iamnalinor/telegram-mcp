/**
 * Saved scenes: each user's library of scene definitions. create_scene saves
 * every new definition by itself, under a name from its title, so a later
 * session finds what earlier ones built and starts it again, changes it, or
 * copies it rather than writing a scene from nothing. Definitions are kept as
 * written; a change keeps the versions before it. A library is its owner's:
 * no one else's session sees or touches it.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { sha256Base64Url } from "../crypto";
import { Fence, formatTime } from "../format";
import { compile, DefinitionError, type Compiled } from "../scenes/definition";
import type { SceneTemplateRow } from "../store";
import { text, ToolError, toolError, type ToolContext } from "./common";

/** Saved scenes a user keeps; create_scene makes room by dropping an auto-saved one. */
const TEMPLATES_PER_USER = 100;
/** Letters with their marks (Devanagari, Thai, a dotted İ), digits, - and _. */
const NAME = /^[\p{L}\p{M}\p{N}_-]{1,40}$/u;
const NAME_RULE = "A name is 1–40 lowercase letters, digits, - or _.";
const SLUG_GRAPHEMES = 32;
const BRIEF_KEPT = 300;
const BRIEF_SHOWN = 160;

export const nameArg = z.string().min(1).max(40).describe("The saved scene's name.");

const quoted = (name: string) => JSON.stringify(name);
const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;

const normal = (value: string) => value.toLowerCase().normalize("NFKC");

/** A name as the user's library keys it, or a refusal. */
export function savedName(name: string): string {
  const key = normal(name);
  if (!NAME.test(key)) throw new ToolError(NAME_RULE);
  return key;
}

/** A name from a title, in whatever script it is written: "Кто идёт?" → "кто-идёт". */
function slug(title: string): string {
  const dashed = normal(title)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^[-\p{M}]+|-+$/gu, "");
  // Cut between characters, never between a letter and its marks.
  const graphemes = Array.from(new Intl.Segmenter().segment(dashed), (part) => part.segment);
  const name = graphemes.slice(0, SLUG_GRAPHEMES).join("").replace(/-+$/, "");
  return NAME.test(name) ? name : "scene";
}

function clip(value: string | null, length: number): string | null {
  if (value === null) return null;
  const chars = Array.from(value);
  return chars.length > length ? `${chars.slice(0, length - 1).join("")}…` : value;
}

/**
 * The user's saved scene names, fenced: they are made from titles sessions
 * wrote, which may quote Telegram content.
 */
async function fencedNames(ctx: ToolContext, head: string): Promise<string | null> {
  const names = (await ctx.store.listTemplates(ctx.userId)).map((t) => t.name);
  if (!names.length) return null;
  const list = names.join(", ");
  const fence = new Fence(ctx.user, [list]);
  return `${head} — names made from titles sessions wrote. ${fence.note()}\n${fence.wrap(list)}`;
}

export async function noSuchSaved(ctx: ToolContext, name: string): Promise<ToolError> {
  const names = await fencedNames(ctx, "There are these");
  return new ToolError(`No saved scene ${quoted(name)}. ${names ?? "There are none yet."}`);
}

/** scene_guide's tail: the user's saved scenes, beside the presets. */
export async function savedForGuide(ctx: ToolContext): Promise<string> {
  const names = await fencedNames(ctx, "Your saved scenes (list_saved_scenes)");
  return names ? `\n\n${names}` : "";
}

/** Check a definition the way create_scene would; its mistakes come back to the model. */
function checked(definition: unknown, describe: (error: DefinitionError) => string): Compiled {
  try {
    return compile(definition).compiled;
  } catch (error) {
    if (error instanceof DefinitionError) throw new ToolError(describe(error));
    throw error;
  }
}

/** A definition but for what a start from a saved scene may change: its title and state. */
function shapeOf(definition: Record<string, unknown>): Promise<string> {
  const rest = Object.fromEntries(
    Object.entries(definition).filter(([key]) => key !== "title" && key !== "state"),
  );
  return sha256Base64Url(JSON.stringify(rest));
}

/** A name not yet in the user's library, from `base`. */
async function freeName(ctx: ToolContext, base: string): Promise<string> {
  const taken = new Set((await ctx.store.listTemplates(ctx.userId)).map((t) => t.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** What create_scene saved, or found saved: the scene to link, and a line for the result. */
export interface Saved {
  template: { id: number; version: number } | null;
  note: string;
}

/**
 * Save what create_scene was given — unless the library has it already, or
 * one that differs only in title and state — and say so for the result. A
 * full library drops the auto-saved scene unused the longest; when every
 * other one was saved on purpose, this one is not kept. `saveAs` is the name
 * the model chose, checked by `checkSaveAs` beforehand.
 */
export async function autoSave(
  ctx: ToolContext,
  definition: Record<string, unknown>,
  scene: Compiled,
  saveAs: string | null,
): Promise<Saved> {
  const source = JSON.stringify(definition);
  const shape = await shapeOf(definition);
  if (saveAs === null) {
    const like = await ctx.store.templateLike(ctx.userId, shape, source);
    if (like) {
      const template = { id: like.id, version: like.version };
      if (like.definition === source) {
        return {
          template,
          note: `Same as saved scene ${quoted(like.name)}; next time pass template ${quoted(like.name)}.`,
        };
      }
      const saved = JSON.parse(like.definition) as Record<string, unknown>;
      const differ = (["title", "state"] as const).filter(
        (key) => JSON.stringify(saved[key]) !== JSON.stringify(definition[key]),
      );
      const what = differ.join(" and ");
      return {
        template,
        note:
          `Like saved scene ${quoted(like.name)} but for its ${what}, so not saved again: next time ` +
          `pass template ${quoted(like.name)} with ${what}.`,
      };
    }
  }
  const row = {
    title: scene.title,
    brief: clip(scene.brief, BRIEF_KEPT),
    definition: source,
    shape,
    kept: false,
  };
  for (let tries = 0; tries < 5; tries++) {
    const name = saveAs ?? (await freeName(ctx, slug(scene.title)));
    const id = await ctx.store.insertTemplate(ctx.userId, { ...row, name });
    if (id === null) {
      // Taken meanwhile: a chosen name is refused, a made-up one is made again.
      if (saveAs !== null) break;
      continue;
    }
    const dropped = await ctx.store.trimTemplates(ctx.userId, TEMPLATES_PER_USER);
    if (dropped.includes(name)) {
      return {
        template: null,
        note:
          `Not saved: all ${TEMPLATES_PER_USER} saved scenes were saved on purpose (save_scene). ` +
          "Delete one (delete_saved_scene) to make room.",
      };
    }
    const made = dropped.length
      ? ` (${dropped.map(quoted).join(", ")}, unused the longest, made room.)`
      : "";
    return {
      template: { id, version: 1 },
      note:
        `Saved as ${quoted(name)}: start it again with create_scene template, change it with ` +
        `save_scene.${made}`,
    };
  }
  throw new ToolError(`${quoted(saveAs ?? slug(scene.title))} is taken: choose another name.`);
}

/** create_scene's save_as: a valid name, free in the user's library. */
export async function checkSaveAs(ctx: ToolContext, name: string): Promise<string> {
  const key = savedName(name);
  if (await ctx.store.getTemplate(ctx.userId, key)) {
    throw new ToolError(
      `${quoted(key)} is taken: choose another name, or change that saved scene with save_scene.`,
    );
  }
  return key;
}

function definitionOf(row: Pick<SceneTemplateRow, "definition">): string {
  return JSON.stringify(JSON.parse(row.definition), null, 2);
}

export function registerSavedSceneTools(
  server: McpServer,
  ctx: ToolContext,
  describe: (error: DefinitionError) => string,
): void {
  server.registerTool(
    "list_saved_scenes",
    {
      title: "List saved scenes",
      description:
        "Your saved scenes: every scene create_scene made is saved, with a name. Call it before building a " +
        "scene, and judge whether one fits: start it as is (create_scene template, with state or title for " +
        "this run), change it for good (get_saved_scene, then save_scene with its version), or copy and " +
        "adapt it (save_scene, or create_scene, under a new name). Write a new one only when none is close.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const rows = await ctx.store.listTemplates(ctx.userId);
        if (!rows.length) {
          return text(
            "No saved scenes yet. Scenes you create are saved here; scene_guide has presets to start from.",
          );
        }
        const lines = rows.map(
          (row) =>
            `- ${row.name} — ${JSON.stringify(row.title)}, version ${row.version}` +
            `${row.kept ? ", saved on purpose" : ""}, used ` +
            `${times(row.uses)}, last ${formatTime(row.used)}` +
            (row.brief ? ` — ${clip(row.brief, BRIEF_SHOWN)}` : ""),
        );
        const fence = new Fence(
          ctx.user,
          rows.flatMap((row) => [row.name, row.title, row.brief ?? ""]),
        );
        return text(
          `Saved scenes: ${rows.length} of ${TEMPLATES_PER_USER}, the most recently used first. Titles and ` +
            `notes were written by sessions and may quote Telegram content.\n${fence.note()}\n` +
            fence.wrap(lines.join("\n")),
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "get_saved_scene",
    {
      title: "Read a saved scene",
      description:
        "A saved scene's definition, to start from, change or copy. version: an earlier one, while kept " +
        "(the last 20).",
      inputSchema: z.object({
        name: nameArg,
        version: z.number().int().positive().optional().describe("An earlier version."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const name = savedName(args.name);
        const row = await ctx.store.getTemplate(ctx.userId, name);
        if (!row) throw await noSuchSaved(ctx, name);
        let head = `Saved scene ${quoted(name)}, version ${row.version}, used ${times(row.uses)}.`;
        let body = definitionOf(row);
        if (args.version !== undefined && args.version !== row.version) {
          const old =
            args.version < row.version
              ? await ctx.store.templateVersion(row.id, args.version)
              : null;
          if (old === null) {
            throw new ToolError(
              `No version ${args.version} of ${quoted(name)} is kept; it is at version ${row.version}.`,
            );
          }
          head = `Saved scene ${quoted(name)} as it was at version ${args.version}; it is at version ${row.version} now.`;
          body = definitionOf({ definition: old });
        }
        const fence = new Fence(ctx.user, [body]);
        return text(
          `${head} Its text may quote Telegram content.\n${fence.note()}\n${fence.wrap(body)}`,
        );
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "save_scene",
    {
      title: "Save or change a saved scene",
      description:
        "Save a scene definition under a name, or change one you saved: pass the version you read " +
        "(get_saved_scene); the version before it is kept. new_name renames. Checked like create_scene; " +
        `nothing is sent. Up to ${TEMPLATES_PER_USER} saved scenes.`,
      inputSchema: z.object({
        name: nameArg,
        definition: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The whole definition, as for create_scene."),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("To change a saved scene: the version you read."),
        new_name: z.string().min(1).max(40).optional().describe("Rename it."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      try {
        const name = savedName(args.name);
        const existing = await ctx.store.getTemplate(ctx.userId, name);
        const newName = args.new_name === undefined ? null : savedName(args.new_name);
        if (!existing) {
          if (!args.definition || args.version !== undefined || newName !== null) {
            throw await noSuchSaved(ctx, name);
          }
          if ((await ctx.store.countTemplates(ctx.userId)) >= TEMPLATES_PER_USER) {
            throw new ToolError(
              `You have ${TEMPLATES_PER_USER} saved scenes, the most there can be: delete one ` +
                "(delete_saved_scene) first, or change one of them in place.",
            );
          }
          const scene = checked(args.definition, describe);
          const id = await ctx.store.insertTemplate(ctx.userId, {
            name,
            title: scene.title,
            brief: clip(scene.brief, BRIEF_KEPT),
            definition: JSON.stringify(args.definition),
            shape: await shapeOf(args.definition),
            kept: true,
          });
          if (id === null) throw new ToolError(`${quoted(name)} is taken: choose another name.`);
          return text(`Saved ${quoted(name)}, version 1. Start it with create_scene template.`);
        }
        if (!args.definition && newName === null) {
          throw new ToolError("Pass definition, new_name or both.");
        }
        const renaming = newName !== null && newName !== name;
        // Before anything changes: a refused rename leaves the definition as it was too.
        if (renaming && (await ctx.store.getTemplate(ctx.userId, newName))) {
          throw new ToolError(`${quoted(newName)} is taken; nothing changed.`);
        }
        const said: string[] = [];
        if (args.definition && JSON.stringify(args.definition) === existing.definition) {
          await ctx.store.keepTemplate(ctx.userId, name);
          said.push(
            `Unchanged: ${quoted(name)} is this definition already, at version ${existing.version}.`,
          );
        } else if (args.definition) {
          if (args.version === undefined) {
            throw new ToolError(
              `${quoted(name)} exists, at version ${existing.version}: to change it, read it ` +
                `(get_saved_scene) and pass version ${existing.version}; to keep both, save under a new name.`,
            );
          }
          const scene = checked(args.definition, describe);
          const changed = await ctx.store.updateTemplate(ctx.userId, name, args.version, {
            title: scene.title,
            brief: clip(scene.brief, BRIEF_KEPT),
            definition: JSON.stringify(args.definition),
            shape: await shapeOf(args.definition),
          });
          if (!changed) {
            const now = await ctx.store.getTemplate(ctx.userId, name);
            if (!now) throw await noSuchSaved(ctx, name);
            throw new ToolError(
              `${quoted(name)} is at version ${now.version} now, not ${args.version}: read it again ` +
                "(get_saved_scene) and redo your change on that.",
            );
          }
          said.push(
            `${quoted(name)} is now version ${args.version + 1}; version ${args.version} is kept ` +
              `(get_saved_scene version ${args.version}).`,
          );
        }
        if (renaming) {
          if (!(await ctx.store.renameTemplate(ctx.userId, name, newName))) {
            throw new ToolError(`${said.join(" ")} ${quoted(newName)} is taken.`.trim());
          }
          said.push(`Renamed ${quoted(name)} to ${quoted(newName)}.`);
        }
        return text(said.join(" ") || "Nothing changed.");
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );

  server.registerTool(
    "delete_saved_scene",
    {
      title: "Delete a saved scene",
      description: "Delete a saved scene and its earlier versions. Scenes running from it go on.",
      inputSchema: z.object({ name: nameArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      try {
        const name = savedName(args.name);
        if (!(await ctx.store.deleteTemplate(ctx.userId, name))) throw await noSuchSaved(ctx, name);
        return text(`Deleted ${quoted(name)}.`);
      } catch (error) {
        return toolError(error, ctx);
      }
    },
  );
}
