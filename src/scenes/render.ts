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
import { DefinitionError, PRESS_NAME, type Compiled, type CompiledButton } from "./definition";
import type { Actor } from "./engine";
import {
  evaluate,
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
  style?: string;
}

export interface Rendered {
  /** What is sent: Telegram HTML for markdown, Markdown for a rich message. */
  text: string;
  /** The text with values as they are, for the bot's record of the message. */
  plain: string;
  format: "markdown" | "rich";
  rows: RenderedButton[][];
  /** Where in the view each button comes from, e.g. "buttons[2]" or "buttons[0][1]". */
  places: string[][];
  /** Buttons past Telegram's 100 that were left out. */
  dropped: number;
}

/** A screen's work on top of the event's: it renders every live message. */
const RENDER_STEPS = 4000;
const BUTTON_TEXT = 64;
const PER_VIEW = 100;
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

export function render(
  compiled: Compiled,
  view: string,
  state: Record<string, Value>,
  env: { owner: Actor; now: number },
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
      ? fill(marked, escapeMarkdown)
      : fill(markdownToHtml(marked), escapeHtml);

  const rows: RenderedButton[][] = [];
  const places: string[][] = [];
  let count = 0;
  let dropped = 0;
  const push = (row: RenderedButton[], place: (c: number) => string) => {
    const shown = row.slice(0, Math.max(0, PER_VIEW - count));
    dropped += row.length - shown.length;
    if (!shown.length) return;
    count += shown.length;
    rows.push(shown);
    places.push(shown.map((_, c) => place(c)));
  };
  const one = (button: CompiledButton, inner: Scope): RenderedButton | null => {
    if (button.show && !truthy(evaluate(button.show, inner, budget))) return null;
    const label = cut(plainText(button.text, inner, budget), BUTTON_TEXT) || "·";
    if (button.url) {
      const url = safeUrl(plainText(button.url, inner, budget));
      return url ? { text: label, url } : null;
    }
    return {
      text: label,
      press: button.press,
      ...(button.arg ? { arg: evaluate(button.arg, inner, budget) } : {}),
      ...(button.style ? { style: button.style } : {}),
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
        .map((button, c) => ({ button: one(button, scope), c }))
        .filter((entry): entry is { button: RenderedButton; c: number } => entry.button !== null);
      push(
        shown.map((entry) => entry.button),
        (c) => `buttons[${r}][${shown[c].c}]`,
      );
      continue;
    }
    const items = elements(evaluate(row.over, scope, budget));
    if (row.kind === "each") {
      for (const [i, [key, item]] of items.entries()) {
        const inner = within(item, i, key);
        push(
          row.row.map((b) => one(b, inner)).filter((b): b is RenderedButton => b !== null),
          () => `buttons[${r}]`,
        );
      }
      continue;
    }
    const size = row.kind === "grid" ? row.width : row.perRow;
    let current: RenderedButton[] = [];
    for (const [i, [key, item]] of items.entries()) {
      const shown = one(row.button, within(item, i, key));
      // A grid keeps its geometry: a hidden cell still takes its place, as a blank.
      if (shown) current.push(shown);
      else if (row.kind === "grid") current.push({ text: " ", press: row.button.press, arg: i });
      if (current.length === size) {
        push(current, () => `buttons[${r}]`);
        current = [];
      }
    }
    push(current, () => `buttons[${r}]`);
  }
  return {
    text,
    plain: fill(marked, (value) => value),
    format: screen.format,
    rows,
    places,
    dropped,
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

export function parseCallback(
  data: string,
): { sceneId: number; press: string; arg: Value | undefined } | null {
  const match = /^s:(\d{1,15}):([^:]{1,16})(?::(.*))?$/s.exec(data);
  if (!match || !PRESS_NAME.test(match[2])) return null;
  let arg: Value | undefined;
  if (match[3] !== undefined) {
    try {
      arg = JSON.parse(match[3]) as Value;
    } catch {
      return null;
    }
  }
  return { sceneId: Number(match[1]), press: match[2], arg };
}
