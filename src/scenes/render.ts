/**
 * A scene's screen from its state: the message text and the keyboard.
 *
 * Interpolated values never become markup. For an ordinary message the
 * template is filled with placeholders, the definition's own Markdown is
 * converted to Telegram HTML, and only then are the values put in, escaped
 * for HTML; a rich message gets them backslash-escaped. A member called
 * "**x**" or "<b>" reads as exactly that.
 */

import { escapeHtml } from "../bot/texts";
import { escapeMarkdown, markdownToHtml } from "../markdown";
import {
  DefinitionError,
  PRESS_NAME,
  STYLES,
  type ButtonStyle,
  type Compiled,
  type CompiledButton,
} from "./definition";
import type { Actor } from "./engine";
import {
  evaluate,
  LangError,
  isMap,
  renderTemplate,
  truthy,
  type Budget,
  type Scope,
  type Template,
  type Value,
} from "./lang";

export interface RenderedButton {
  text: string;
  press?: string;
  arg?: Value;
  url?: string;
  style?: ButtonStyle;
}

export interface Rendered {
  /** What is sent: Telegram HTML for markdown, Markdown for a rich message. */
  text: string;
  /** The text with values as they are, for the bot's record of the message. */
  plain: string;
  format: "markdown" | "rich";
  rows: RenderedButton[][];
  /** Where in the view each button comes from, e.g. "buttons[2]", "buttons[0][1]" or "buttons[1].row[0]". */
  places: string[][];
}

/** A screen's work on top of the event's: it renders every live message. */
const RENDER_STEPS = 4000;
const BUTTON_TEXT = 64;
const PER_VIEW = 100;
const PER_ROW = 8;
/** A value's stand-in while the Markdown around it is converted. */
const MARK = "\u0001";
const END = "\u0002";

function cut(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length > length ? `${chars.slice(0, length - 1).join("")}…` : text;
}

function safeUrl(url: string): string | null {
  return /^(https?:\/\/|tg:\/\/)\S+$/i.test(url.trim()) ? url.trim() : null;
}

/**
 * A screen Telegram would refuse: text over the message's limit, a button's
 * data over 64 bytes, more than 100 buttons. The event that led to it is
 * refused, so the state that cannot be shown is never written.
 */
export class RenderError extends LangError {
  constructor(
    message: string,
    /** Where in the view, e.g. "buttons[0][1]" or "text". */
    readonly place: string,
  ) {
    super(message, 0);
  }
}

/** What Telegram takes: a message's text after parsing, a rich message's source. */
const TEXT_LIMIT = { markdown: 4096, rich: 32_768 };
const CALLBACK_BYTES = 64;
/** Room the check leaves for a scene's id in callback data. */
const ID_ROOM = 999_999_999;

/** Telegram HTML as a reader sees it: tags gone, entities back to characters. */
function visible(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

export function render(
  compiled: Compiled,
  view: string,
  state: Record<string, Value>,
  env: { owner: Actor; now: number; sceneId?: number },
): Rendered {
  const screen = compiled.views[view] ?? compiled.views.main;
  if (!screen) throw new DefinitionError(`there is no view "${view}"`, "views");
  const budget: Budget = { steps: RENDER_STEPS };
  const scope: Scope = {
    state,
    lets: compiled.lets,
    vars: { user: null, arg: null, event: null, now: env.now, owner: { ...env.owner } },
  };

  const values: string[] = [];
  const marked = renderTemplate(screen.text, scope, budget, (value) => {
    values.push(value.replaceAll(MARK, "").replaceAll(END, ""));
    return `${MARK}${values.length - 1}${END}`;
  });
  const fill = (text: string, escape: (value: string) => string) =>
    text.replace(new RegExp(`${MARK}(\\d+)${END}`, "g"), (_, n: string) =>
      escape(values[Number(n)]),
    );
  const text =
    screen.format === "rich"
      ? // A newline in a value would end a table row or open a block.
        fill(marked, (value) => escapeMarkdown(value.replace(/\s*\n\s*/g, " ")))
      : fill(
          // Inside a link's address a value is percent-encoded, so it cannot leave the href.
          markdownToHtml(marked).replace(
            /href="([^"]*)"/g,
            (_, href: string) =>
              `href="${fill(href, (value) => escapeHtml(encodeURIComponent(value)))}"`,
          ),
          (value) => escapeHtml(value).replaceAll('"', "&quot;"),
        );
  const length = Array.from(screen.format === "rich" ? text : visible(text)).length;
  if (length > TEXT_LIMIT[screen.format]) {
    throw new RenderError(
      `the text would be ${length} characters; a message holds ${TEXT_LIMIT[screen.format]}`,
      "text",
    );
  }

  const rows: RenderedButton[][] = [];
  const places: string[][] = [];
  let count = 0;
  let dropped = 0;
  const push = (row: RenderedButton[], place: (c: number) => string, rowPlace: string) => {
    const shown = row.slice(0, Math.max(0, PER_VIEW - count));
    dropped += row.length - shown.length;
    if (dropped) throw new RenderError(`a view shows at most ${PER_VIEW} buttons`, "buttons");
    // Only what is shown counts: a row may define more and let show pick.
    if (shown.length > PER_ROW) {
      throw new RenderError(
        `a row shows at most ${PER_ROW} buttons; this one would show ${shown.length}`,
        rowPlace,
      );
    }
    for (const [c, button] of shown.entries()) {
      if (button.press && bytes(callbackData(env.sceneId ?? ID_ROOM, button)) > CALLBACK_BYTES) {
        throw new RenderError(
          `the button's argument is too long: name and argument together leave ${CALLBACK_BYTES} bytes`,
          place(c),
        );
      }
    }
    if (!shown.length) return;
    count += shown.length;
    rows.push(shown);
    places.push(shown.map((_, c) => place(c)));
  };
  /** The button's colour: a literal as it is, a template filled in for this button. */
  const styleOf = (button: CompiledButton, inner: Scope, place: string): ButtonStyle | null => {
    if (button.style === undefined) return null;
    if (typeof button.style === "string") return button.style;
    const value = plainText(button.style, inner, budget).trim();
    if (!value) return null;
    if (!(STYLES as readonly string[]).includes(value)) {
      throw new RenderError(
        // The value itself may come from members: it is not echoed back.
        `style must come out as ${STYLES.join(", ")} or empty`,
        `${place}.style`,
      );
    }
    return value as ButtonStyle;
  };
  const one = (button: CompiledButton, inner: Scope, place: string): RenderedButton | null => {
    if (button.show && !truthy(evaluate(button.show, inner, budget))) return null;
    const label = cut(plainText(button.text, inner, budget), BUTTON_TEXT) || "·";
    if (button.url) {
      const url = safeUrl(plainText(button.url, inner, budget));
      return url ? { text: label, url } : null;
    }
    const style = styleOf(button, inner, place);
    return {
      text: label,
      press: button.press,
      ...(button.arg ? { arg: evaluate(button.arg, inner, budget) } : {}),
      ...(style ? { style } : {}),
    };
  };
  const within = (it: Value, i: number, key: string | null): Scope => ({
    ...scope,
    vars: { ...scope.vars, it, i, key },
  });
  const elements = (value: Value): [string | null, Value][] =>
    Array.isArray(value)
      ? value.map((item) => [null, item])
      : isMap(value)
        ? Object.entries(value)
        : [];

  for (const [r, row] of screen.rows.entries()) {
    if (row.kind === "row") {
      const shown = row.buttons
        .map((button, c) => ({ button: one(button, scope, `buttons[${r}][${c}]`), c }))
        .filter((entry): entry is { button: RenderedButton; c: number } => entry.button !== null);
      push(
        shown.map((entry) => entry.button),
        (c) => `buttons[${r}][${shown[c].c}]`,
        `buttons[${r}]`,
      );
      continue;
    }
    const items = elements(evaluate(row.over, scope, budget));
    if (row.kind === "each") {
      for (const [i, [key, item]] of items.entries()) {
        const inner = within(item, i, key);
        // Hidden buttons drop out of the row: a place counts in the template's own row.
        const shown = row.row
          .map((button, c) => ({ button: one(button, inner, `buttons[${r}].row[${c}]`), c }))
          .filter((entry): entry is { button: RenderedButton; c: number } => entry.button !== null);
        push(
          shown.map((entry) => entry.button),
          (c) => `buttons[${r}].row[${shown[c].c}]`,
          `buttons[${r}]`,
        );
      }
      continue;
    }
    const size = row.kind === "grid" ? row.width : row.perRow;
    let current: RenderedButton[] = [];
    for (const [i, [key, item]] of items.entries()) {
      const shown = one(row.button, within(item, i, key), `buttons[${r}]`);
      // A grid keeps its geometry: a hidden cell still takes its place, as a blank.
      if (shown) current.push(shown);
      else if (row.kind === "grid") current.push({ text: " ", press: row.button.press, arg: i });
      if (current.length === size) {
        push(current, () => `buttons[${r}]`, `buttons[${r}]`);
        current = [];
      }
    }
    push(current, () => `buttons[${r}]`, `buttons[${r}]`);
  }
  return {
    text,
    plain: fill(marked, (value) => value),
    format: screen.format,
    rows,
    places,
  };
}

/** A button's text or URL: plain, nothing escaped (Telegram shows it as is). */
function plainText(template: Template, scope: Scope, budget: Budget): string {
  return renderTemplate(template, scope, budget, (value) => value);
}

/** `s:<scene>:<press>` or `s:<scene>:<press>:<JSON arg>`. */
export function callbackData(sceneId: number, button: RenderedButton): string {
  const base = `s:${sceneId}:${button.press ?? ""}`;
  return button.arg === undefined ? base : `${base}:${JSON.stringify(button.arg)}`;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function finite(value: Value): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (isMap(value)) return Object.values(value).every(finite);
  return true;
}

export function parseCallback(
  data: string,
): { sceneId: number; press: string; arg: Value | undefined } | null {
  if (bytes(data) > CALLBACK_BYTES) return null;
  const match = /^s:(\d{1,15}):([^:]{1,16})(?::(.*))?$/s.exec(data);
  if (!match || !PRESS_NAME.test(match[2])) return null;
  let arg: Value | undefined;
  if (match[3] !== undefined) {
    try {
      arg = JSON.parse(match[3]) as Value;
    } catch {
      return null;
    }
    // JSON.parse reads 1e999 as Infinity, which no button could carry.
    if (!finite(arg)) return null;
  }
  return { sceneId: Number(match[1]), press: match[2], arg };
}
