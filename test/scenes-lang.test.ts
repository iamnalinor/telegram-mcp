import { describe, expect, it } from "bun:test";

import {
  ACTIONS,
  assign,
  evaluate,
  LangError,
  parseExpr,
  parseStatement,
  parseTemplate,
  renderTemplate,
  type Scope,
  type Value,
} from "../src/scenes/lang";

/** A random source that walks a fixed list, for functions that shuffle and pick. */
function seq(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

function scope(
  state: Record<string, Value> = {},
  vars: Record<string, Value> = {},
  lets: Record<string, string> = {},
): Scope {
  return {
    state,
    vars: { now: 1_000_000, ...vars },
    lets: Object.fromEntries(Object.entries(lets).map(([name, src]) => [name, parseExpr(src)])),
    random: seq(0.1, 0.7, 0.4, 0.9),
  };
}

const run = (source: string, s: Scope = scope(), steps = 2000): Value =>
  evaluate(parseExpr(source), s, { steps });

function errorOf(fn: () => unknown): LangError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LangError) return error;
    throw error;
  }
  throw new Error("expected a LangError");
}

describe("expressions", () => {
  it("follows the precedence table", () => {
    expect(run("1 + 2 * 3 == 7")).toBe(true);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("7 % 4 + 8 / 2")).toBe(7);
    const s = scope({ a: false, b: true, c: true });
    expect(run("!a && b || c", s)).toBe(true);
    expect(run("!(a || b)", s)).toBe(false);
    expect(run("1 < 2 == true")).toBe(true);
    expect(run("null ?? 1 + 1")).toBe(2);
    expect(run("2 in [1, 2] && 'x' in {x: 1}")).toBe(true);
    // Nested ternaries associate to the right.
    expect(run("1 > 2 ? 'a' : 2 > 3 ? 'b' : 'c'")).toBe("c");
    expect(run("-2 * -3")).toBe(6);
  });

  it("reads paths, and missing things are null", () => {
    const s = scope({ m: { a: [10, { b: "deep" }] }, cells: ["x", "", "o"] });
    expect(run("m.a[1].b", s)).toBe("deep");
    expect(run("m.a[5]", s)).toBeNull();
    expect(run("m.nope.further", s)).toBeNull();
    expect(run("cells[-1]", s)).toBeNull();
    expect(run("m['a'][0]", s)).toBe(10);
    expect(run("1 / 0")).toBeNull();
    expect(run("'ab' + 1 + null")).toBe("ab1");
    expect(run("null + 1")).toBe(1);
    expect(run("unknown_name")).toBeNull();
  });

  it("compares deeply", () => {
    expect(run("[1, {a: [2]}] == [1, {a: [2]}]")).toBe(true);
    expect(run("{a: 1, b: 2} == {b: 2, a: 1}")).toBe(true);
    expect(run("[1, 2] != [2, 1]")).toBe(true);
    expect(run("'2' == 2")).toBe(false);
  });

  it("is truthy as the spec says", () => {
    for (const falsy of ["null", "false", "0", "''", "[]", "{}"])
      expect(run(`!${falsy}`)).toBe(true);
    for (const truthy of ["1", "'a'", "[0]", "{a: null}"]) expect(run(`!${truthy}`)).toBe(false);
  });

  it("keys maps by strings", () => {
    const s = scope({ players: { "42": "Ann" } }, { user: { id: 42, name: "Ann" } });
    expect(run("players[user.id]", s)).toBe("Ann");
    expect(run("user.id in players", s)).toBe(true);
  });
});

describe("functions", () => {
  const s = () =>
    scope({
      list: [3, 1, 2],
      people: [
        { n: "a", d: "fix" },
        { n: "b", d: null },
        { n: "c", d: "fix" },
      ],
      votes: { "1": "7", "2": "7", "3": "9" },
      scores: { ann: 5, bob: 9, cid: 9 },
    });

  it("lists and maps", () => {
    expect(run("len(list)", s())).toBe(3);
    expect(run("len(null)")).toBe(0);
    expect(run("keys({a: 1, b: 2})")).toEqual(["a", "b"]);
    expect(run("values({a: 1, b: 2})")).toEqual([1, 2]);
    expect(run("has(list, 2)", s())).toBe(true);
    expect(run("has({a: 1}, 'b')")).toBe(false);
    expect(run("count(list, 1)", s())).toBe(1);
    expect(run("count(people, 'fix', 'd')", s())).toBe(2);
    expect(run("count(people, null, 'd')", s())).toBe(1);
    expect(run("sum(list)", s())).toBe(6);
    expect(run("sum([])")).toBe(0);
    expect(run("min(list)", s())).toBe(1);
    expect(run("max(4, 8, 2)")).toBe(8);
    expect(run("max([])")).toBeNull();
    expect(run("slice(list, 1)", s())).toEqual([1, 2]);
    expect(run("slice('hello', 0, 2)")).toBe("he");
    expect(run("without(list, 1)", s())).toEqual([3, 2]);
    expect(run("without({a: 1, b: 2}, 'a')")).toEqual({ b: 2 });
    expect(run("tally(votes)", s())).toEqual({ "7": 2, "9": 1 });
    expect(run("tally({})")).toEqual({});
    expect(run("leader(tally(votes))", s())).toBe("7");
    expect(run("leader(scores)", s())).toBeNull(); // a tie
    expect(run("leader({})")).toBeNull();
    expect(run("top(scores, 2)", s())).toEqual([
      { key: "bob", value: 9 },
      { key: "cid", value: 9 },
    ]);
    expect(run("top({}, 3)")).toEqual([]);
  });

  it("boards: full, line and drop", () => {
    const board = (cells: string[]) => scope({ cells });
    expect(run("full(cells)", board(["x", "o", "x", "o", "x", "o", "o", "x", "o"]))).toBe(true);
    expect(run("full(cells)", board(["x", "", "x"]))).toBe(false);
    // Rows, columns and both diagonals on 3×3.
    expect(run("line(cells, 3, 3)", board(["", "", "", "o", "o", "o", "", "", ""]))).toBe("o");
    expect(run("line(cells, 3, 3)", board(["x", "", "", "x", "", "", "x", "", ""]))).toBe("x");
    expect(run("line(cells, 3, 3)", board(["x", "", "", "", "x", "", "", "", "x"]))).toBe("x");
    expect(run("line(cells, 3, 3)", board(["", "", "o", "", "o", "", "o", "", ""]))).toBe("o");
    expect(run("line(cells, 3, 3)", board(["x", "o", "x", "", "", "", "", "", ""]))).toBe("");
    // 7×6, four in a row, including a diagonal that starts off the first row.
    const wide = Array<string>(42).fill("");
    for (const [r, c] of [
      [5, 1],
      [4, 2],
      [3, 3],
      [2, 4],
    ])
      wide[r * 7 + c] = "r";
    expect(run("line(cells, 7, 4)", board(wide))).toBe("r");
    wide[2 * 7 + 4] = "y";
    expect(run("line(cells, 7, 4)", board(wide))).toBe("");
    // Gravity: the lowest empty cell of a column.
    const column = Array<string>(42).fill("");
    expect(run("drop(cells, 7, 3)", board(column))).toBe(38);
    column[38] = "r";
    expect(run("drop(cells, 7, 3)", board(column))).toBe(31);
    for (let r = 0; r < 6; r++) column[r * 7 + 3] = "y";
    expect(run("drop(cells, 7, 3)", board(column))).toBeNull();
  });

  it("chance comes from the injected source", () => {
    expect(run("random(10)")).toBe(1); // 0.1 × 10
    expect(run("pick(['a', 'b', 'c'])")).toBe("a");
    expect(run("pick([])")).toBeNull();
    const shuffled = run("shuffle([1, 2, 3, 4])") as number[];
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4]);
    const dealt = run("deal(['mafia', 'doc'], [1, 2, 3, 4], 'civ')") as Record<string, string>;
    expect(Object.keys(dealt).sort()).toEqual(["1", "2", "3", "4"]);
    expect(Object.values(dealt).sort()).toEqual(["civ", "civ", "doc", "mafia"]);
  });

  it("text", () => {
    expect(run("str(12)")).toBe("12");
    expect(run("str(null)")).toBe("");
    expect(run("join(['a', 'b'], ' / ')")).toBe("a / b");
    expect(run("join([1, 2])")).toBe("1, 2");
    expect(run("bar(3, 10)")).toBe("███░░░░░░░");
    expect(run("bar(20, 10)")).toBe("██████████");
    expect(run("bar(1, 0)")).toBe("░░░░░░░░░░");
    expect(run("ago(now - 90)")).toBe("1 min ago");
    expect(run("ago(now - 7200)")).toBe("2 h ago");
    expect(run("ago(now)")).toBe("just now");
    expect(run("each(['a', 'b'], '{i + 1}.{it};')")).toBe("1.a;2.b;");
    expect(run("each({x: 1, y: 2}, '{key}={it} ')")).toBe("x=1 y=2 ");
  });

  it("refuses an unknown function where it is named", () => {
    const error = errorOf(() => parseExpr("len(x) + nope(1)"));
    expect(error.at).toBe(9);
    expect(error.message).toContain("nope");
  });
});

describe("lets", () => {
  it("are computed lazily and may use one another", () => {
    const s = scope(
      { turn: "x", x: { id: 1 }, o: null },
      {},
      {
        seat: "turn == 'x' ? x : o",
        seated: "seat != null",
      },
    );
    expect(run("seated && seat.id == 1", s)).toBe(true);
  });

  it("a cycle is an error", () => {
    const s = scope({}, {}, { a: "b + 1", b: "a + 1" });
    expect(errorOf(() => run("a", s)).message).toContain("cycle");
  });
});

describe("statements", () => {
  const exec = (source: string, state: Record<string, Value>, vars: Record<string, Value> = {}) => {
    const stmt = parseStatement(source);
    if (stmt.kind !== "assign") throw new Error("not an assignment");
    assign(state, stmt, scope(state, vars), { steps: 2000 });
    return state;
  };

  it("assigns fields, indexes and keys", () => {
    expect(exec("a = 1 + 1", { a: 0 })).toEqual({ a: 2 });
    expect(exec("cells[1] = 'x'", { cells: ["", "", ""] })).toEqual({ cells: ["", "x", ""] });
    expect(exec("items[0].d = 'fix'", { items: [{ t: "a", d: null }] })).toEqual({
      items: [{ t: "a", d: "fix" }],
    });
    expect(
      exec("players[user.id] = user.name", { players: {} }, { user: { id: 7, name: "Ann" } }),
    ).toEqual({ players: { "7": "Ann" } });
    // One past the end appends; further is an error.
    expect(exec("l[2] = 3", { l: [1, 2] })).toEqual({ l: [1, 2, 3] });
    expect(() => exec("l[5] = 3", { l: [1, 2] })).toThrow(LangError);
    expect(() => exec("nothing = 3", { l: [] })).toThrow(LangError);
    expect(() => exec("user = 3", { l: [] })).toThrow(LangError);
  });

  it("+= and -= on numbers, lists and missing keys", () => {
    expect(exec("n += 2", { n: 1 })).toEqual({ n: 3 });
    expect(exec("l += 3", { l: [1] })).toEqual({ l: [1, 3] });
    expect(exec("l -= 1", { l: [1, 2, 1] })).toEqual({ l: [2] });
    expect(exec("score['ann'] += 1", { score: {} })).toEqual({ score: { ann: 1 } });
    expect(exec("n -= 5", { n: 1 })).toEqual({ n: -4 });
  });

  it("parses actions and refuses what is neither", () => {
    expect(ACTIONS).toContain("wake");
    expect(parseStatement("log = 1")).toMatchObject({ kind: "assign" }); // a field may share a name
    expect(parseStatement("wake('done')")).toMatchObject({ kind: "call", name: "wake" });
    expect(parseStatement("finish()")).toMatchObject({ kind: "call", name: "finish", args: [] });
    expect(() => parseStatement("len(x)")).toThrow(LangError);
    expect(() => parseStatement("1 + 1")).toThrow(LangError);
    expect(() => parseStatement("a == 1")).toThrow(LangError);
  });
});

describe("templates", () => {
  it("interpolates and keeps double braces literal", () => {
    const t = parseTemplate("Hi {name}! {{not}} {1 + 1}");
    expect(renderTemplate(t, scope({ name: "Ann" }), { steps: 100 }, (v) => v)).toBe(
      "Hi Ann! {not} 2",
    );
  });

  it("escapes values and never parses them again", () => {
    const user = { id: 1, name: "*x* {state} <b>" };
    const t = parseTemplate("**{user.name}** joined");
    const escaped = renderTemplate(t, scope({}, { user }), { steps: 100 }, (v) => `[${v}]`);
    expect(escaped).toBe("**[*x* {state} <b>]** joined");
  });

  it("handles braces inside strings and maps in an interpolation", () => {
    const t = parseTemplate("{each(items, '{i + 1}. {it.t} — {it.d ?? \"…\"}\\n')}");
    const out = renderTemplate(
      t,
      scope({
        items: [
          { t: "a", d: null },
          { t: "b", d: "fix" },
        ],
      }),
      { steps: 200 },
      (v) => v,
    );
    expect(out).toBe("1. a — …\n2. b — fix\n");
    expect(renderTemplate(parseTemplate("{ {a: 1}.a }"), scope(), { steps: 10 }, (v) => v)).toBe(
      "1",
    );
  });

  it("points at the place of a mistake", () => {
    expect(errorOf(() => parseTemplate("ok {1 +} rest")).at).toBe(7);
    expect(errorOf(() => parseTemplate("ok {unclosed")).at).toBe(3);
    expect(errorOf(() => parseExpr("a + * b")).at).toBe(4);
    expect(errorOf(() => parseExpr("'open")).at).toBe(0);
    expect(errorOf(() => parseExpr("a b")).at).toBe(2);
  });
});

describe("budget", () => {
  it("runs out on each over a 3000-element list", () => {
    const big = scope({ list: Array.from({ length: 3000 }, (_, i) => i) });
    const error = errorOf(() => run("each(list, '{it}')", big));
    expect(error.message).toContain("budget");
  });

  it("stops strings that double past the size limit", () => {
    const s = scope({ s: "x".repeat(10_000) });
    expect(() => run("s + s", s)).toThrow(LangError);
  });
});
