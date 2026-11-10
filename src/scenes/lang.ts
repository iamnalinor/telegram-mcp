/**
 * The scenes' expression language: a tokenizer, a Pratt parser and an
 * evaluator of our own — never `eval`. A definition is parsed once, when the
 * scene is created, and D1 keeps the tree; every event only evaluates it.
 *
 * Values are what JSON has. There are no loops, no recursion and no functions
 * of one's own; every node evaluated costs a step from a budget, and the
 * built-ins (src/scenes/functions.ts) charge for the elements they walk, so
 * an event's work is bounded whatever the definition says.
 *
 *   expressions   1 + 2 * 3, a.b[i], x in list, a ?? b, c ? a : b, len(list)
 *   statements    path = expr, path += expr, path -= expr, or an action: wake('done')
 *   templates     "Turn: {turn == 'x' ? '❌' : '⭕'}" — "{{" and "}}" are literal braces
 */

import { ARITY, FUNCTIONS } from "./functions";

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

/** A mistake in a definition or a failure while evaluating; `at` is the offset in the source. */
export class LangError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

type BinaryOp =
  "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "in" | "&&" | "||" | "??";

/** The parsed tree: plain JSON, so it is stored as is. */
export type Expr =
  | { k: "lit"; v: Value; at: number }
  | { k: "name"; n: string; at: number }
  | { k: "list"; items: Expr[]; at: number }
  | { k: "map"; entries: [string, Expr][]; at: number }
  | { k: "get"; obj: Expr; key: Expr; at: number }
  | { k: "call"; fn: string; args: Expr[]; tpl?: Template; at: number }
  | { k: "not" | "neg"; e: Expr; at: number }
  | { k: "bin"; op: BinaryOp; l: Expr; r: Expr; at: number }
  | { k: "cond"; c: Expr; t: Expr; f: Expr; at: number };

export type Stmt =
  | { kind: "assign"; path: Expr; op: "=" | "+=" | "-="; value: Expr }
  | { kind: "call"; name: string; args: Expr[] };

export type Template = (string | Expr)[];

export interface Budget {
  steps: number;
}

export interface Scope {
  /** The event's names (user, arg, event, now, owner) and, inside each(), it, i and key. */
  vars: Record<string, Value>;
  /** Computed names, evaluated on first use. */
  lets: Record<string, Expr>;
  /** The scene's state; assignments write here. */
  state?: Record<string, Value>;
  /** Where randomness comes from; crypto by default. */
  random?: () => number;
  /** How a value goes into the text being rendered; each() uses it for its own values. */
  escape?: (text: string) => string;
}

/** Actions a rule's `do` may call; each is carried out by the engine, not here. */
export const ACTIONS: readonly string[] = [
  "alert",
  "toast",
  "whisper",
  "post",
  "show",
  "poll",
  "close_poll",
  "dice",
  "tag",
  "log",
  "wake",
  "finish",
];

/** Names an event provides; no state field or let may take them. */
export const RESERVED: readonly string[] = [
  "user",
  "arg",
  "event",
  "now",
  "owner",
  "it",
  "i",
  "key",
  "null",
  "true",
  "false",
  "in",
];

/** How many arguments each action takes: [least, most]. */
const ACTION_ARITY: Record<string, [number, number]> = {
  alert: [1, 1],
  toast: [1, 1],
  whisper: [1, 1],
  post: [1, 1],
  show: [1, 1],
  poll: [2, 3],
  close_poll: [0, 0],
  dice: [0, 1],
  tag: [2, 2],
  log: [1, 1],
  wake: [1, 1],
  finish: [0, 0],
};

/**
 * The largest value an expression may build, about its JSON bytes: four
 * times the state's cap. Lists and maps are measured as they are built, so a
 * few doublings are refused long before they cost time or memory.
 */
const MAX_VALUE = 32_768;
/** Measuring or printing a value costs a step per this many bytes. */
const BYTES_PER_STEP = 256;

/** Strings and lists stop here: a few doublings would otherwise fill the isolate's memory. */
const MAX_STRING = 16_384;
const MAX_LIST = 4096;

// --- tokens -----------------------------------------------------------------

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "name"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPERATORS = [
  "??",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "?",
  ":",
  ".",
  ",",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "=",
];

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "'": "'", '"': '"', "\\": "\\" };

function tokenize(source: string, offset: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const at = offset + i;
    if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(source.slice(i))!;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new LangError("the number is too large", at);
      tokens.push({ t: "num", v: value, at });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_]\w*/.exec(source.slice(i))!;
      tokens.push({ t: "name", v: match[0], at });
      i += match[0].length;
      continue;
    }
    if (char === "'" || char === '"') {
      let value = "";
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) {
        if (source[j] === "\\") {
          const escaped = ESCAPES[source[j + 1]];
          if (escaped === undefined) throw new LangError("unknown escape in a string", offset + j);
          value += escaped;
          j++;
        } else {
          value += source[j];
        }
      }
      if (j >= source.length) throw new LangError("a string is not closed", at);
      tokens.push({ t: "str", v: value, at });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new LangError(`unexpected character ${JSON.stringify(char)}`, at);
    tokens.push({ t: "op", v: op, at });
    i += op.length;
  }
  tokens.push({ t: "end", at: offset + source.length });
  return tokens;
}

// --- parser -----------------------------------------------------------------

/** Binding power of each binary operator: higher binds tighter. */
const BINARY: Record<string, number> = {
  "??": 2,
  "||": 3,
  "&&": 4,
  "==": 5,
  "!=": 5,
  "<": 6,
  "<=": 6,
  ">": 6,
  ">=": 6,
  in: 6,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "%": 8,
};
const TERNARY = 1;

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos];
  }

  peekAt(ahead: number): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)];
  }

  next(): Token {
    return this.tokens[this.pos++];
  }

  isOp(value: string): boolean {
    const token = this.peek();
    return token.t === "op" && token.v === value;
  }

  expect(value: string): Token {
    const token = this.next();
    if (token.t !== "op" || token.v !== value) {
      throw new LangError(`expected "${value}"`, token.at);
    }
    return token;
  }

  end(): void {
    const token = this.peek();
    if (token.t !== "end") throw new LangError("unexpected text after the expression", token.at);
  }

  expr(minPower = 0): Expr {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      const op = token.t === "op" || (token.t === "name" && token.v === "in") ? token.v : null;
      if (op === "?" && TERNARY >= minPower) {
        this.next();
        const t = this.expr(0);
        this.expect(":");
        const f = this.expr(TERNARY);
        left = { k: "cond", c: left, t, f, at: token.at };
        continue;
      }
      const power = op === null ? undefined : BINARY[op];
      if (power === undefined || power <= minPower) return left;
      this.next();
      const right = this.expr(power);
      left = { k: "bin", op: op as BinaryOp, l: left, r: right, at: token.at };
    }
  }

  unary(): Expr {
    const token = this.peek();
    if (token.t === "op" && (token.v === "!" || token.v === "-")) {
      this.next();
      return { k: token.v === "!" ? "not" : "neg", e: this.unary(), at: token.at };
    }
    return this.postfix(this.primary());
  }

  postfix(base: Expr): Expr {
    let expr = base;
    for (;;) {
      const token = this.peek();
      if (token.t === "op" && token.v === ".") {
        this.next();
        const name = this.next();
        if (name.t !== "name") throw new LangError("expected a field name after the dot", name.at);
        expr = { k: "get", obj: expr, key: { k: "lit", v: name.v, at: name.at }, at: token.at };
      } else if (token.t === "op" && token.v === "[") {
        this.next();
        const key = this.expr();
        this.expect("]");
        expr = { k: "get", obj: expr, key, at: token.at };
      } else {
        return expr;
      }
    }
  }

  primary(): Expr {
    const token = this.next();
    switch (token.t) {
      case "num":
        return { k: "lit", v: token.v, at: token.at };
      case "str":
        return { k: "lit", v: token.v, at: token.at };
      case "name":
        if (token.v === "null") return { k: "lit", v: null, at: token.at };
        if (token.v === "true" || token.v === "false")
          return { k: "lit", v: token.v === "true", at: token.at };
        if (this.isOp("(")) return this.call(token.v, token.at, false);
        return { k: "name", n: token.v, at: token.at };
      case "op":
        if (token.v === "(") {
          const inner = this.expr();
          this.expect(")");
          return inner;
        }
        if (token.v === "[") {
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.isOp("]")) this.expect(",");
          }
          this.next();
          return { k: "list", items, at: token.at };
        }
        if (token.v === "{") {
          const entries: [string, Expr][] = [];
          while (!this.isOp("}")) {
            const key = this.next();
            if (key.t !== "name" && key.t !== "str") {
              throw new LangError("expected a key", key.at);
            }
            this.expect(":");
            entries.push([key.v, this.expr()]);
            if (!this.isOp("}")) this.expect(",");
          }
          this.next();
          return { k: "map", entries, at: token.at };
        }
        throw new LangError(`unexpected "${token.v}"`, token.at);
      case "end":
        throw new LangError("the expression ends too early", token.at);
    }
  }

  /** `name(args)`: a built-in function, or (in a statement) an action. */
  call(name: string, at: number, action: boolean): Expr & { k: "call" } {
    const known = action
      ? Object.hasOwn(ACTION_ARITY, name)
      : Object.hasOwn(FUNCTIONS, name) || name === "each";
    if (!known) throw new LangError(`there is no function "${name}"`, at);
    this.expect("(");
    const args: Expr[] = [];
    while (!this.isOp(")")) {
      args.push(this.expr());
      if (!this.isOp(")")) this.expect(",");
    }
    this.next();
    const [least, most] = action ? ACTION_ARITY[name] : name === "each" ? [2, 2] : ARITY[name];
    if (args.length < least || args.length > most) {
      const wanted =
        least === most
          ? `${least}`
          : most === Infinity
            ? `${least} or more`
            : `${least} to ${most}`;
      throw new LangError(`${name}() takes ${wanted} argument${most === 1 ? "" : "s"}`, at);
    }
    if (name !== "each") return { k: "call", fn: name, args, at };
    // each(coll, 'template'): the template is parsed now, once.
    const template = args[1];
    if (args.length !== 2 || template.k !== "lit" || typeof template.v !== "string") {
      throw new LangError("each takes a collection and a template in quotes", at);
    }
    return {
      k: "call",
      fn: name,
      args: [args[0]],
      tpl: parseTemplate(template.v, template.at + 1),
      at,
    };
  }
}

export function parseExpr(source: string, offset = 0): Expr {
  const parser = new Parser(tokenize(source, offset));
  const expr = parser.expr();
  parser.end();
  return expr;
}

/** An assignment to a state path, or an action call. */
export function parseStatement(source: string, offset = 0): Stmt {
  const parser = new Parser(tokenize(source, offset));
  const first = parser.peek();
  const second = parser.peekAt(1);
  if (first.t === "name" && ACTIONS.includes(first.v) && second.t === "op" && second.v === "(") {
    parser.next();
    const call = parser.call(first.v, first.at, true);
    parser.end();
    return { kind: "call", name: call.fn, args: call.args };
  }
  const path = parser.postfix(parser.primary());
  if (!isPath(path)) throw new LangError("expected a state field to assign to", first.at);
  const op = parser.next();
  if (op.t !== "op" || !["=", "+=", "-="].includes(op.v)) {
    throw new LangError('expected "=", "+=" or "-=", or an action like wake(…)', op.at);
  }
  const value = parser.expr();
  parser.end();
  return { kind: "assign", path, op: op.v as "=" | "+=" | "-=", value };
}

function isPath(expr: Expr): boolean {
  if (expr.k === "name") return true;
  return expr.k === "get" && isPath(expr.obj);
}

/** The state field an assignment path starts at. */
export function pathRoot(expr: Expr): { n: string; at: number } {
  return expr.k === "get" ? pathRoot(expr.obj) : (expr as { n: string; at: number });
}

/** Where the interpolation that opens at `start` ("{") closes: quotes and nesting respected. */
function closingBrace(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "'" || char === '"') {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

export function parseTemplate(source: string, offset = 0): Template {
  const parts: Template = [];
  let literal = "";
  for (let i = 0; i < source.length;) {
    if (source.startsWith("{{", i) || source.startsWith("}}", i)) {
      literal += source[i];
      i += 2;
      continue;
    }
    if (source[i] !== "{") {
      literal += source[i++];
      continue;
    }
    const close = closingBrace(source, i);
    if (close < 0) throw new LangError("a { is not closed", offset + i);
    if (literal) parts.push(literal);
    literal = "";
    parts.push(parseExpr(source.slice(i + 1, close), offset + i + 1));
    i = close + 1;
  }
  if (literal) parts.push(literal);
  return parts;
}

// --- values -----------------------------------------------------------------

export function isMap(value: Value): value is { [key: string]: Value } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isMap(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Deep equality; with a budget, every pair of nodes compared costs a step. */
export function equal(a: Value, b: Value, budget?: Budget, at = 0): boolean {
  if (budget) charge(budget, 1, at);
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equal(item, b[i], budget, at));
  }
  if (isMap(a) && isMap(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key], budget, at))
    );
  }
  return false;
}

/** UTF-8 bytes of a string as JSON writes it, quotes and escapes included. */
function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * A value's size as JSON, in UTF-8 bytes — counted only until it passes
 * `limit`, so measuring a huge (or shared, many times nested) value costs no
 * more than measuring one just over the limit. Returns limit + 1 then.
 */
export function sizeOf(value: Value, limit: number): number {
  let total = 0;
  const stack: Value[] = [value];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === null) total += 4;
    else if (typeof node === "boolean") total += node ? 4 : 5;
    else if (typeof node === "number") total += String(node).length;
    else if (typeof node === "string") total += jsonStringBytes(node);
    else if (Array.isArray(node)) {
      total += 2 + Math.max(0, node.length - 1);
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else {
      const keys = Object.keys(node);
      total += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        total += jsonStringBytes(key) + 1;
        stack.push(node[key]);
      }
    }
    if (total > limit) return limit + 1;
  }
  return total;
}

/** A list or map just built: measured, paid for, refused when it grew too big. */
function grown(value: Value, budget: Budget, at: number): Value {
  if (typeof value !== "object" || value === null) return checkSize(value, at);
  const size = sizeOf(value, MAX_VALUE);
  charge(budget, Math.ceil(size / BYTES_PER_STEP), at);
  if (size > MAX_VALUE) throw new LangError(`a value grew past ${MAX_VALUE} bytes`, at);
  return checkSize(value, at);
}

/** str() for the evaluator: a list or map is measured and paid for before it is printed. */
export function text(value: Value, budget: Budget, at: number): string {
  if (typeof value === "object" && value !== null) grown(value, budget, at);
  return str(value);
}

/** How a value reads in text: null is nothing, lists and maps are JSON. */
export function str(value: Value): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A map key: always a string, so players[user.id] and players['42'] are one. */
export function keyOf(value: Value): string {
  return str(value);
}

/** Numbers that are not finite become null: JSON has no Infinity. */
export function num(value: number): Value {
  return Number.isFinite(value) ? value : null;
}

export function checkSize(value: Value, at: number): Value {
  if (typeof value === "string" && value.length > MAX_STRING) {
    throw new LangError(`a text grew past ${MAX_STRING} characters`, at);
  }
  if (Array.isArray(value) && value.length > MAX_LIST) {
    throw new LangError(`a list grew past ${MAX_LIST} items`, at);
  }
  return value;
}

export function charge(budget: Budget, steps: number, at: number): void {
  budget.steps -= steps;
  if (budget.steps < 0) throw new LangError("the evaluation budget ran out", at);
}

// --- evaluation -------------------------------------------------------------

const defaultRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/** Per scope: lets already computed, and those being computed (to catch a cycle). */
const letCache = new WeakMap<Scope, Map<string, Value | typeof PENDING>>();
const PENDING = Symbol("pending");
/** each() runs its template in a scope of its own; lets are still computed in the outer one. */
const outer = new WeakMap<Scope, Scope>();

function lookup(name: string, scope: Scope, at: number, budget: Budget): Value {
  if (Object.hasOwn(scope.vars, name)) return scope.vars[name];
  const root = outer.get(scope) ?? scope;
  if (Object.hasOwn(root.lets, name)) {
    let cache = letCache.get(root);
    if (!cache) letCache.set(root, (cache = new Map<string, Value | typeof PENDING>()));
    const cached = cache.get(name);
    if (cached === PENDING)
      throw new LangError(`"${name}" is defined through itself (a cycle)`, at);
    if (cached !== undefined) return cached;
    cache.set(name, PENDING);
    try {
      const value = evaluate(root.lets[name], root, budget);
      cache.set(name, value);
      return value;
    } catch (error) {
      cache.delete(name);
      throw error;
    }
  }
  if (scope.state && Object.hasOwn(scope.state, name)) return scope.state[name];
  return null;
}

/** State changed: computed names must be computed again. */
function forgetLets(scope: Scope): void {
  letCache.delete(outer.get(scope) ?? scope);
}

export function index(container: Value, key: Value): Value {
  if (Array.isArray(container)) {
    return typeof key === "number" && Number.isInteger(key) && key >= 0 && key < container.length
      ? container[key]
      : null;
  }
  if (isMap(container)) {
    const name = keyOf(key);
    return Object.hasOwn(container, name) ? container[name] : null;
  }
  return null;
}

function add(a: Value, b: Value, at: number, budget: Budget): Value {
  if (typeof a === "string" || typeof b === "string") {
    const left = text(a, budget, at);
    const right = text(b, budget, at);
    if (left.length + right.length > MAX_STRING) {
      throw new LangError(`a text grew past ${MAX_STRING} characters`, at);
    }
    return left + right;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length + b.length > MAX_LIST)
      throw new LangError(`a list grew past ${MAX_LIST} items`, at);
    return grown([...a, ...b], budget, at);
  }
  if ((typeof a === "number" || a === null) && (typeof b === "number" || b === null)) {
    return num((a ?? 0) + (b ?? 0));
  }
  throw new LangError("+ takes numbers, texts or two lists", at);
}

function arithmetic(op: BinaryOp, a: Value, b: Value, at: number): Value {
  if ((typeof a !== "number" && a !== null) || (typeof b !== "number" && b !== null)) {
    throw new LangError(`${op} takes numbers`, at);
  }
  const x = a ?? 0;
  const y = b ?? 0;
  if (op === "-") return num(x - y);
  if (op === "*") return num(x * y);
  if (y === 0) return null;
  return num(op === "/" ? x / y : x % y);
}

function compare(op: BinaryOp, a: Value, b: Value): boolean {
  const comparable =
    (typeof a === "number" && typeof b === "number") ||
    (typeof a === "string" && typeof b === "string");
  if (!comparable) return false;
  const x = a;
  const y = b;
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

export function contains(collection: Value, item: Value, budget?: Budget, at = 0): boolean {
  if (Array.isArray(collection)) {
    return collection.some((element) => equal(element, item, budget, at));
  }
  if (isMap(collection)) return Object.hasOwn(collection, keyOf(item));
  if (typeof collection === "string") return collection.includes(str(item));
  return false;
}

export function evaluate(expr: Expr, scope: Scope, budget: Budget): Value {
  charge(budget, 1, expr.at);
  switch (expr.k) {
    case "lit":
      return expr.v;
    case "name":
      return lookup(expr.n, scope, expr.at, budget);
    case "list":
      return grown(
        expr.items.map((item) => evaluate(item, scope, budget)),
        budget,
        expr.at,
      );
    case "map":
      return grown(
        Object.fromEntries(
          expr.entries.map(([key, value]) => [key, evaluate(value, scope, budget)]),
        ),
        budget,
        expr.at,
      );
    case "get":
      return index(evaluate(expr.obj, scope, budget), evaluate(expr.key, scope, budget));
    case "not":
      return !truthy(evaluate(expr.e, scope, budget));
    case "neg": {
      const value = evaluate(expr.e, scope, budget);
      if (value === null) return 0;
      if (typeof value !== "number") throw new LangError("- takes a number", expr.at);
      return -value;
    }
    case "cond":
      return truthy(evaluate(expr.c, scope, budget))
        ? evaluate(expr.t, scope, budget)
        : evaluate(expr.f, scope, budget);
    case "bin":
      return binary(expr, scope, budget);
    case "call":
      if (expr.fn === "each") return each(expr, scope, budget);
      if (!Object.hasOwn(FUNCTIONS, expr.fn))
        throw new LangError(`there is no function "${expr.fn}"`, expr.at);
      return FUNCTIONS[expr.fn](
        expr.args.map((arg) => evaluate(arg, scope, budget)),
        { budget, at: expr.at, random: scope.random ?? defaultRandom, now: nowOf(scope) },
      );
  }
}

function nowOf(scope: Scope): number {
  const now = scope.vars.now;
  return typeof now === "number" ? now : Math.floor(Date.now() / 1000);
}

function binary(expr: Expr & { k: "bin" }, scope: Scope, budget: Budget): Value {
  const left = evaluate(expr.l, scope, budget);
  switch (expr.op) {
    case "&&":
      return truthy(left) ? evaluate(expr.r, scope, budget) : left;
    case "||":
      return truthy(left) ? left : evaluate(expr.r, scope, budget);
    case "??":
      return left !== null ? left : evaluate(expr.r, scope, budget);
  }
  const right = evaluate(expr.r, scope, budget);
  switch (expr.op) {
    case "+":
      return add(left, right, expr.at, budget);
    case "-":
    case "*":
    case "/":
    case "%":
      return arithmetic(expr.op, left, right, expr.at);
    case "==":
      return equal(left, right, budget, expr.at);
    case "!=":
      return !equal(left, right, budget, expr.at);
    case "in":
      return contains(right, left, budget, expr.at);
    default:
      return compare(expr.op, left, right);
  }
}

/** each(coll, 'template'): the template once per element, with it, i and key bound. */
function each(expr: Expr & { k: "call" }, scope: Scope, budget: Budget): Value {
  const collection = evaluate(expr.args[0], scope, budget);
  const entries: [string | null, Value][] = Array.isArray(collection)
    ? collection.map((item) => [null, item])
    : isMap(collection)
      ? Object.entries(collection)
      : [];
  let out = "";
  for (const [i, [key, item]] of entries.entries()) {
    charge(budget, 1, expr.at);
    const inner: Scope = { ...scope, vars: { ...scope.vars, it: item, i, key } };
    outer.set(inner, outer.get(scope) ?? scope);
    out = append(out, renderTemplate(expr.tpl!, inner, budget, scope.escape ?? plain), expr.at);
  }
  return out;
}

const plain = (value: string) => value;

/** Text joined only while it fits: the check comes before the copy. */
function append(out: string, piece: string, at: number): string {
  if (out.length + piece.length > MAX_STRING) {
    throw new LangError(`a text grew past ${MAX_STRING} characters`, at);
  }
  return out + piece;
}

/**
 * Interpolate a template. Values are turned into text and passed through
 * `escape`; the literal parts are the definition's own and stay as written.
 * A value is never parsed again, so a name like "{state}" stays that text.
 */
export function renderTemplate(
  template: Template,
  scope: Scope,
  budget: Budget,
  escape: (text: string) => string,
): string {
  const root = outer.get(scope) ?? scope;
  // each() as the whole interpolation escapes its own values and keeps its
  // own text; anywhere else it is a value like any other, escaped as a whole.
  const escaping: Scope = { ...scope, escape };
  const raw: Scope = { ...scope, escape: undefined };
  outer.set(escaping, root);
  outer.set(raw, root);
  let out = "";
  for (const part of template) {
    if (typeof part === "string") {
      out = append(out, part, 0);
    } else if (part.k === "call" && part.fn === "each") {
      out = append(out, str(evaluate(part, escaping, budget)), part.at);
    } else {
      out = append(out, escape(text(evaluate(part, raw, budget), budget, part.at)), part.at);
    }
  }
  return out;
}

// --- assignment -------------------------------------------------------------

/** Run an assignment against the state, in place. */
export function assign(
  state: Record<string, Value>,
  stmt: Stmt & { kind: "assign" },
  scope: Scope,
  budget: Budget,
): void {
  const root = pathRoot(stmt.path);
  if (RESERVED.includes(root.n) || !Object.hasOwn(state, root.n)) {
    throw new LangError(`"${root.n}" is not a field of the state`, root.at);
  }
  // A copy: assigning never makes two places share one list or map.
  const result = evaluate(stmt.value, scope, budget);
  const value = typeof result === "object" && result !== null ? structuredClone(result) : result;
  // The chain of keys under the root, evaluated before anything changes.
  const keys: { key: Value; at: number }[] = [];
  for (let node = stmt.path; node.k === "get"; node = node.obj) {
    keys.unshift({ key: evaluate(node.key, scope, budget), at: node.at });
  }
  let container: Value = state;
  let last: { key: Value; at: number } = { key: root.n, at: root.at };
  for (const step of keys) {
    let child = index(container, last.key);
    if (child === null) {
      // A missing map key on the way creates a map there; a list grows only by `list[len] = v`.
      if (!isMap(container)) throw new LangError("there is nothing at this index", last.at);
      child = {};
      put(container, last.key, child, last.at);
    }
    container = child;
    last = step;
  }
  const current = index(container, last.key);
  put(container, last.key, combine(stmt.op, current, value, last.at, budget), last.at);
  forgetLets(scope);
}

function combine(
  op: "=" | "+=" | "-=",
  current: Value,
  value: Value,
  at: number,
  budget: Budget,
): Value {
  if (op === "=") return value;
  if (Array.isArray(current)) {
    return op === "+="
      ? grown([...current, value], budget, at)
      : current.filter((item) => !equal(item, value, budget, at));
  }
  if (op === "+=") return add(current, value, at, budget);
  return arithmetic("-", current, value, at);
}

function put(container: Value, key: Value, value: Value, at: number): void {
  if (Array.isArray(container)) {
    if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > container.length) {
      throw new LangError("a list index is out of range", at);
    }
    if (key === container.length) checkSize([...container, value], at);
    container[key] = value;
    return;
  }
  if (isMap(container)) {
    // Defined, not set: a key like "__proto__" stays an ordinary key.
    Object.defineProperty(container, keyOf(key), {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  throw new LangError("only a list or a map can be assigned into", at);
}
