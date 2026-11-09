/**
 * The reducer: state and an event in, the new state and a list of effects
 * out. No I/O — the bot layer (src/bot/scenes.ts) loads, commits and carries
 * the effects out. Rules are tried top to bottom and the first whose `on` and
 * `when` hold is the one; a rule without `do` refuses with its `say`.
 */

import type { Compiled, CompiledStmt } from "./definition";
import {
  assign,
  equal,
  evaluate,
  isMap,
  LangError,
  renderTemplate,
  str,
  truthy,
  type Budget,
  type Scope,
  type Value,
} from "./lang";

export interface Actor {
  id: number;
  name: string;
}

export interface SceneEvent {
  /** press:<name>, act:<name>, vote, poll, reply, reaction or dice. */
  on: string;
  user: Actor;
  arg?: Value;
  event?: Record<string, Value>;
  now: number;
  owner: Actor;
}

export type Effect =
  | { kind: "toast" | "alert" | "whisper"; text: string }
  | { kind: "post"; text?: string; view?: string }
  | { kind: "show"; view: string }
  | { kind: "poll"; question: string; options: string[]; opts: Record<string, Value> }
  | { kind: "close_poll" }
  | { kind: "dice"; emoji: string }
  | { kind: "tag"; userId: number; text: string }
  | { kind: "log" | "wake"; name: string }
  | { kind: "finish" };

type Refusal = "no_rule" | "not_for_you" | "said" | "full" | "broken";

export type Match =
  { rule: number; wakes: boolean } | { refused: Refusal; text?: string; who?: "owner" | "expr" };

/** Steps an event may take, the spec's figure. */
const EVENT_STEPS = 2000;
const STATE_BYTES = 8192;
const ANSWER_LENGTH = 200;
const POST_LENGTH = 4000;
const EVENT_NAME = /^[\w-]{1,32}$/;
const DICE = ["🎲", "🎯", "🏀", "⚽", "🎳", "🎰"];

function scopeOf(compiled: Compiled, state: Record<string, Value>, event: SceneEvent): Scope {
  return {
    state,
    lets: compiled.lets,
    vars: {
      user: { ...event.user },
      arg: event.arg ?? null,
      event: event.event ?? null,
      now: event.now,
      owner: { ...event.owner },
    },
  };
}

const plain = (text: string) => text;

export function match(compiled: Compiled, state: Record<string, Value>, event: SceneEvent): Match {
  const scope = scopeOf(compiled, state, event);
  const budget: Budget = { steps: EVENT_STEPS };
  try {
    for (const [index, rule] of compiled.rules.entries()) {
      if (rule.on !== event.on) continue;
      if (rule.when && !truthy(evaluate(rule.when, scope, budget))) continue;
      if (rule.who === "owner" && event.user.id !== event.owner.id) {
        return { refused: "not_for_you", text: event.owner.name, who: "owner" };
      }
      if (typeof rule.who === "object" && !truthy(evaluate(rule.who, scope, budget))) {
        return { refused: "not_for_you", who: "expr" };
      }
      if (!rule.do) {
        return {
          refused: "said",
          ...(rule.say ? { text: renderTemplate(rule.say, scope, budget, plain) } : {}),
        };
      }
      return { rule: index, wakes: rule.wakes };
    }
  } catch (error) {
    if (error instanceof LangError) return { refused: "broken", text: error.message };
    throw error;
  }
  return { refused: "no_rule" };
}

export function run(
  compiled: Compiled,
  state: Record<string, Value>,
  event: SceneEvent,
  rule: number,
):
  | { state: Record<string, Value>; effects: Effect[] }
  | { refused: "full" | "broken"; detail: string } {
  const next = structuredClone(state);
  const scope = scopeOf(compiled, next, event);
  const budget: Budget = { steps: EVENT_STEPS };
  const effects: Effect[] = [];
  const definition = compiled.rules[rule];
  try {
    execute(definition.do ?? [], next, scope, budget, effects, compiled, event);
    if (definition.say) {
      effects.unshift({
        kind: "toast",
        text: cut(renderTemplate(definition.say, scope, budget, plain), ANSWER_LENGTH),
      });
    }
  } catch (error) {
    if (error instanceof LangError) return { refused: "broken", detail: error.message };
    throw error;
  }
  const size = new TextEncoder().encode(JSON.stringify(next)).byteLength;
  if (size > STATE_BYTES) {
    return { refused: "full", detail: `the state would be ${size} bytes, over ${STATE_BYTES}` };
  }
  return { state: next, effects };
}

function cut(text: string, length: number): string {
  const chars = Array.from(text);
  return chars.length > length ? `${chars.slice(0, length - 1).join("")}…` : text;
}

function execute(
  statements: CompiledStmt[],
  state: Record<string, Value>,
  scope: Scope,
  budget: Budget,
  effects: Effect[],
  compiled: Compiled,
  event: SceneEvent,
): void {
  for (const stmt of statements) {
    if (stmt.kind === "if") {
      const branch = truthy(evaluate(stmt.cond, scope, budget)) ? stmt.then : stmt.else;
      execute(branch, state, scope, budget, effects, compiled, event);
    } else if (stmt.kind === "assign") {
      assign(state, stmt, scope, budget);
    } else {
      const args = stmt.args.map((arg) => evaluate(arg, scope, budget));
      effects.push(action(stmt.name, args, compiled, event, stmt.args[0]?.at ?? 0));
    }
  }
}

function action(
  name: string,
  args: Value[],
  compiled: Compiled,
  event: SceneEvent,
  at: number,
): Effect {
  const text = (length: number) => cut(str(args[0] ?? null), length);
  const eventName = () => {
    const value = str(args[0] ?? null);
    if (!EVENT_NAME.test(value))
      throw new LangError(`${name}() takes a short name: letters, digits, - and _`, at);
    return value;
  };
  switch (name) {
    case "toast":
    case "alert":
    case "whisper":
      return { kind: name, text: text(ANSWER_LENGTH) };
    case "post": {
      const value = str(args[0] ?? null);
      return Object.hasOwn(compiled.views, value)
        ? { kind: "post", view: value }
        : { kind: "post", text: text(POST_LENGTH) };
    }
    case "show": {
      const view = str(args[0] ?? null);
      if (!Object.hasOwn(compiled.views, view))
        throw new LangError(`there is no view "${view}"`, at);
      return { kind: "show", view };
    }
    case "poll": {
      const options = Array.isArray(args[1]) ? args[1].map((option) => cut(str(option), 100)) : [];
      if (options.length < 2 || options.length > 12) {
        throw new LangError("poll() takes a question and 2 to 12 options", at);
      }
      return {
        kind: "poll",
        question: cut(str(args[0] ?? null), 300),
        options,
        opts: isMap(args[2] ?? null) ? (args[2] as Record<string, Value>) : {},
      };
    }
    case "close_poll":
      return { kind: "close_poll" };
    case "dice": {
      const emoji = args[0] === undefined || args[0] === null ? "🎲" : str(args[0]);
      if (!DICE.includes(emoji)) throw new LangError(`dice() takes one of ${DICE.join(" ")}`, at);
      return { kind: "dice", emoji };
    }
    case "tag": {
      const target = args[0] ?? null;
      const id = isMap(target) ? target.id : target;
      // A scene tags only whoever caused the event, never someone else.
      if (!equal(id, event.user.id))
        throw new LangError("tag() works only on the event's user", at);
      return { kind: "tag", userId: event.user.id, text: cut(str(args[1] ?? null), 16) };
    }
    case "log":
    case "wake":
      return { kind: name, name: eventName() };
    case "finish":
      return { kind: "finish" };
  }
  throw new LangError(`there is no action "${name}"`, at);
}
