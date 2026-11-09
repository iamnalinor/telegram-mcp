/**
 * A scene's definition: the JSON a session writes, checked against the
 * limits and compiled into trees once, at creation. D1 keeps the compiled
 * form; events never parse anything again.
 */

import { z } from "zod";

import { FUNCTIONS } from "./functions";
import {
  LangError,
  parseExpr,
  parseStatement,
  parseTemplate,
  RESERVED,
  pathRoot,
  type Expr,
  type Stmt,
  type Template,
  type Value,
} from "./lang";
import { callbackData, render } from "./render";

/** The spec's limits. */
const LIMITS = {
  definitionBytes: 16_384,
  stateBytes: 8192,
  rules: 40,
  views: 8,
  buttonsPerView: 100,
  buttonsPerRow: 8,
  callbackBytes: 64,
  ifDepth: 3,
  wakeLimit: 10,
};

/** A press name: short, so callback_data keeps room for the argument. */
export const PRESS_NAME = /^[a-z0-9_]{1,16}$/;
/** What a rule may react to. */
const EVENT = /^(?:press:[a-z0-9_]{1,16}|act:[a-z0-9_]{1,16}|vote|poll|reply|reaction|dice)$/;

/** A mistake in the definition, with where it is: "rules[2].when", "view.buttons[0].text". */
export class DefinitionError extends Error {
  constructor(
    message: string,
    readonly where: string,
    /** For a mistake inside an expression: its source, and the offset of the mistake. */
    readonly source?: string,
    readonly at?: number,
  ) {
    super(message);
  }
}

export interface CompiledButton {
  text: Template;
  press?: string;
  arg?: Expr;
  url?: Template;
  style?: "primary" | "success" | "danger";
  show?: Expr;
}

type CompiledRow =
  | { kind: "row"; buttons: CompiledButton[] }
  | { kind: "grid"; over: Expr; width: number; button: CompiledButton }
  | { kind: "each"; over: Expr; row: CompiledButton[] }
  | { kind: "list"; over: Expr; perRow: number; button: CompiledButton };

interface CompiledView {
  text: Template;
  format: "markdown" | "rich";
  rows: CompiledRow[];
}

export type CompiledStmt =
  Stmt | { kind: "if"; cond: Expr; then: CompiledStmt[]; else: CompiledStmt[] };

interface CompiledRule {
  on: string;
  when?: Expr;
  who: "anyone" | "owner" | Expr;
  do?: CompiledStmt[];
  say?: Template;
  wakes: boolean;
}

export interface Compiled {
  title: string;
  brief: string | null;
  lets: Record<string, Expr>;
  views: Record<string, CompiledView>;
  rules: CompiledRule[];
  wakeLimit: number;
}

// --- the model's JSON -------------------------------------------------------

const style = z.enum(["primary", "success", "danger"]).optional();
const buttonInput = z.object({
  text: z.string().min(1).max(200),
  press: z.string().optional(),
  arg: z.string().max(200).optional(),
  url: z.string().max(500).optional(),
  style,
  show: z.string().max(500).optional(),
});
const rowInput = z.union([
  z.array(buttonInput),
  z.object({
    grid: z.string(),
    width: z.number().int().min(1).max(LIMITS.buttonsPerRow),
    text: z.string().min(1).max(200),
    press: z.string(),
    style,
    show: z.string().max(500).optional(),
  }),
  z.object({ each: z.string(), row: z.array(buttonInput) }),
  z.object({
    each: z.string(),
    per_row: z.number().int().min(1).max(LIMITS.buttonsPerRow),
    text: z.string().min(1).max(200),
    press: z.string(),
    arg: z.string().max(200).optional(),
    style,
    show: z.string().max(500).optional(),
  }),
]);
const viewInput = z.object({
  text: z.string().min(1).max(4096),
  format: z.enum(["markdown", "rich"]).optional(),
  buttons: z.array(rowInput).optional(),
});
type StmtInput = string | { if: string; do: StmtInput[]; else?: StmtInput[] };
const stmtInput: z.ZodType<StmtInput> = z.lazy(() =>
  z.union([
    z.string().min(1).max(500),
    z.object({ if: z.string(), do: z.array(stmtInput), else: z.array(stmtInput).optional() }),
  ]),
);
const definitionInput = z.object({
  title: z.string().min(1).max(100),
  brief: z.string().max(2000).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  let: z.record(z.string(), z.string().max(500)).optional(),
  view: viewInput.optional(),
  views: z.record(z.string(), viewInput).optional(),
  rules: z.array(
    z.object({
      on: z.string(),
      when: z.string().max(500).optional(),
      who: z.string().max(500).optional(),
      do: z.array(stmtInput).optional(),
      say: z.string().max(200).optional(),
    }),
  ),
  wake_limit: z.number().int().optional(),
});

// --- compiling ----------------------------------------------------------------

const NAME = /^[A-Za-z_]\w{0,31}$/;

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Parse with the place attached to any mistake. */
function at<T>(where: string, source: string, parse: (source: string) => T): T {
  try {
    return parse(source);
  } catch (error) {
    if (error instanceof LangError)
      throw new DefinitionError(error.message, where, source, error.at);
    throw error;
  }
}

/** Every name an expression reads, with where it is. */
function namesIn(
  node: unknown,
  found: { n: string; at: number }[] = [],
): { n: string; at: number }[] {
  if (Array.isArray(node)) {
    for (const item of node) namesIn(item, found);
  } else if (node && typeof node === "object") {
    const expr = node as Record<string, unknown>;
    if (expr.k === "name") found.push({ n: expr.n as string, at: expr.at as number });
    for (const value of Object.values(expr)) if (typeof value === "object") namesIn(value, found);
  }
  return found;
}

class Compiler {
  private readonly known: Set<string>;

  constructor(
    private readonly state: Record<string, Value>,
    private readonly letNames: string[],
  ) {
    this.known = new Set([...Object.keys(state), ...letNames, ...RESERVED]);
  }

  /** Reject names that are neither state, a let, nor one the event gives. */
  private check<T>(where: string, source: string, parsed: T): T {
    const unknown = namesIn(parsed).find((name) => !this.known.has(name.n));
    if (unknown) {
      throw new DefinitionError(
        `"${unknown.n}" is not a state field, a let or one of ${RESERVED.slice(0, 8).join(", ")}`,
        where,
        source,
        unknown.at,
      );
    }
    return parsed;
  }

  expr(where: string, source: string): Expr {
    return this.check(
      where,
      source,
      at(where, source, (s) => parseExpr(s)),
    );
  }

  template(where: string, source: string): Template {
    return this.check(
      where,
      source,
      at(where, source, (s) => parseTemplate(s)),
    );
  }

  statements(where: string, input: StmtInput[], depth: number): CompiledStmt[] {
    return input.map((stmt, index) => {
      const place = `${where}[${index}]`;
      if (typeof stmt !== "string") {
        if (depth >= LIMITS.ifDepth) {
          throw new DefinitionError(`"if" nests at most ${LIMITS.ifDepth} deep`, place);
        }
        return {
          kind: "if",
          cond: this.expr(`${place}.if`, stmt.if),
          then: this.statements(`${place}.do`, stmt.do, depth + 1),
          else: this.statements(`${place}.else`, stmt.else ?? [], depth + 1),
        };
      }
      const parsed = this.check(
        place,
        stmt,
        at(place, stmt, (s) => parseStatement(s)),
      );
      if (parsed.kind === "assign") {
        const root = pathRoot(parsed.path);
        if (!Object.hasOwn(this.state, root.n)) {
          throw new DefinitionError(
            `"${root.n}" is not a field of the initial state: only state fields can be assigned`,
            place,
            stmt,
            root.at,
          );
        }
      }
      return parsed;
    });
  }

  button(where: string, input: z.infer<typeof buttonInput>, implicitArg?: Expr): CompiledButton {
    if (input.press !== undefined && !PRESS_NAME.test(input.press)) {
      throw new DefinitionError(
        "a press name is 1–16 characters: a-z, 0-9 and _",
        `${where}.press`,
      );
    }
    if (input.press === undefined && input.url === undefined) {
      throw new DefinitionError("a button needs press or url", where);
    }
    return {
      text: this.template(`${where}.text`, input.text),
      ...(input.press === undefined ? {} : { press: input.press }),
      ...(input.arg !== undefined
        ? { arg: this.expr(`${where}.arg`, input.arg) }
        : implicitArg && input.press !== undefined
          ? { arg: implicitArg }
          : {}),
      ...(input.url === undefined ? {} : { url: this.template(`${where}.url`, input.url) }),
      ...(input.style ? { style: input.style } : {}),
      ...(input.show === undefined ? {} : { show: this.expr(`${where}.show`, input.show) }),
    };
  }

  view(where: string, input: z.infer<typeof viewInput>): CompiledView {
    const index: Expr = { k: "name", n: "i", at: 0 };
    return {
      text: this.template(`${where}.text`, input.text),
      format: input.format ?? "markdown",
      rows: (input.buttons ?? []).map((row, r): CompiledRow => {
        const place = `${where}.buttons[${r}]`;
        if (Array.isArray(row)) {
          if (row.length > LIMITS.buttonsPerRow) {
            throw new DefinitionError(`a row holds at most ${LIMITS.buttonsPerRow} buttons`, place);
          }
          return { kind: "row", buttons: row.map((b, c) => this.button(`${place}[${c}]`, b)) };
        }
        if ("grid" in row) {
          return {
            kind: "grid",
            over: this.expr(`${place}.grid`, row.grid),
            width: row.width,
            button: this.button(place, row, index),
          };
        }
        if ("row" in row) {
          if (row.row.length > LIMITS.buttonsPerRow) {
            throw new DefinitionError(`a row holds at most ${LIMITS.buttonsPerRow} buttons`, place);
          }
          return {
            kind: "each",
            over: this.expr(`${place}.each`, row.each),
            row: row.row.map((b, c) => this.button(`${place}.row[${c}]`, b)),
          };
        }
        return {
          kind: "list",
          over: this.expr(`${place}.each`, row.each),
          perRow: row.per_row,
          button: this.button(place, row, index),
        };
      }),
    };
  }
}

/** Whether any branch of these statements calls wake(). */
function wakes(statements: CompiledStmt[]): boolean {
  return statements.some((stmt) =>
    stmt.kind === "if"
      ? wakes(stmt.then) || wakes(stmt.else)
      : stmt.kind === "call" && stmt.name === "wake",
  );
}

/** Check and compile a definition; the initial state comes back separately. */
export function compile(input: unknown): { compiled: Compiled; state: Record<string, Value> } {
  if (bytes(JSON.stringify(input ?? null)) > LIMITS.definitionBytes) {
    throw new DefinitionError(
      `a definition is at most ${LIMITS.definitionBytes} bytes`,
      "definition",
    );
  }
  const parsed = definitionInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path
      .map((part, i) =>
        typeof part === "number" ? `[${part}]` : i ? `.${String(part)}` : String(part),
      )
      .join("");
    throw new DefinitionError(issue.message, where || "definition");
  }
  const def = parsed.data;

  const state = (def.state ?? {}) as Record<string, Value>;
  if (bytes(JSON.stringify(state)) > LIMITS.stateBytes) {
    throw new DefinitionError(`the state is at most ${LIMITS.stateBytes} bytes`, "state");
  }
  const taken = new Set([...RESERVED, ...Object.keys(FUNCTIONS), "each"]);
  for (const name of Object.keys(state)) {
    if (!NAME.test(name) || taken.has(name)) {
      throw new DefinitionError(`"${name}" cannot name a state field`, `state.${name}`);
    }
  }
  const letInput = def.let ?? {};
  for (const name of Object.keys(letInput)) {
    if (!NAME.test(name) || taken.has(name) || Object.hasOwn(state, name)) {
      throw new DefinitionError(`"${name}" cannot name a let`, `let.${name}`);
    }
  }

  if (def.view && def.views) throw new DefinitionError("give view or views, not both", "views");
  const viewInputs = def.views ?? (def.view ? { main: def.view } : {});
  const viewNames = Object.keys(viewInputs);
  if (viewNames.length > LIMITS.views) {
    throw new DefinitionError(`at most ${LIMITS.views} views`, "views");
  }
  if (!viewInputs.main)
    throw new DefinitionError('a scene needs a view (or a view named "main")', "view");
  if (def.rules.length > LIMITS.rules) {
    throw new DefinitionError(`at most ${LIMITS.rules} rules`, "rules");
  }
  if (def.wake_limit !== undefined && (def.wake_limit < 1 || def.wake_limit > LIMITS.wakeLimit)) {
    throw new DefinitionError(
      `wake_limit can only lower the default: 1 to ${LIMITS.wakeLimit} an hour`,
      "wake_limit",
    );
  }

  const compiler = new Compiler(state, Object.keys(letInput));
  const lets = Object.fromEntries(
    Object.entries(letInput).map(([name, source]) => [name, compiler.expr(`let.${name}`, source)]),
  );
  const views = Object.fromEntries(
    Object.entries(viewInputs).map(([name, view]) => [
      name,
      compiler.view(def.view ? "view" : `views.${name}`, view),
    ]),
  );
  const rules = def.rules.map((rule, r): CompiledRule => {
    const where = `rules[${r}]`;
    if (!EVENT.test(rule.on)) {
      throw new DefinitionError(
        "on is press:<name>, act:<name>, vote, poll, reply, reaction or dice",
        `${where}.on`,
      );
    }
    const statements = rule.do ? compiler.statements(`${where}.do`, rule.do, 0) : undefined;
    for (const stmt of flatten(statements ?? [])) {
      const target = stmt.kind === "call" && stmt.name === "show" ? stmt.args[0] : null;
      if (target && !(target.k === "lit" && typeof target.v === "string" && viewInputs[target.v])) {
        throw new DefinitionError("show() takes the name of a view, in quotes", `${where}.do`);
      }
    }
    return {
      on: rule.on,
      ...(rule.when === undefined ? {} : { when: compiler.expr(`${where}.when`, rule.when) }),
      who:
        rule.who === undefined || rule.who === "anyone"
          ? "anyone"
          : rule.who === "owner"
            ? "owner"
            : compiler.expr(`${where}.who`, rule.who),
      ...(statements ? { do: statements } : {}),
      ...(rule.say === undefined ? {} : { say: compiler.template(`${where}.say`, rule.say) }),
      wakes: wakes(statements ?? []),
    };
  });

  const compiled: Compiled = {
    title: def.title,
    brief: def.brief ?? null,
    lets,
    views,
    rules,
    wakeLimit: def.wake_limit ?? LIMITS.wakeLimit,
  };

  // Every view once, against the initial state: mistakes show now, not on the first press.
  for (const name of viewNames) {
    const where = def.view ? "view" : `views.${name}`;
    let shown;
    try {
      shown = render(compiled, name, state, { owner: { id: 0, name: "owner" }, now: 0 });
    } catch (error) {
      if (error instanceof LangError) throw new DefinitionError(error.message, `${where}`);
      throw error;
    }
    if (shown.dropped > 0) {
      throw new DefinitionError(
        `a view shows at most ${LIMITS.buttonsPerView} buttons`,
        `${where}.buttons`,
      );
    }
    for (const [r, row] of shown.rows.entries()) {
      for (const [c, button] of row.entries()) {
        if (button.press && bytes(callbackData(999_999_999, button)) > LIMITS.callbackBytes) {
          throw new DefinitionError(
            `the button's argument is too long: name and argument together leave ${LIMITS.callbackBytes} bytes`,
            `${where}.${shown.places[r][c]}`,
          );
        }
      }
    }
  }
  return { compiled, state };
}

function flatten(statements: CompiledStmt[]): Stmt[] {
  return statements.flatMap((stmt) =>
    stmt.kind === "if" ? [...flatten(stmt.then), ...flatten(stmt.else)] : [stmt],
  );
}

/** The rules that wake the session, and who the rule itself lets trigger them. */
export function wakingRules(
  compiled: Compiled,
): { on: string; who: "owner" | "anyone" | "expr" }[] {
  return compiled.rules
    .filter((rule) => rule.wakes)
    .map((rule) => ({
      on: rule.on,
      who: rule.who === "owner" || rule.who === "anyone" ? rule.who : "expr",
    }));
}
