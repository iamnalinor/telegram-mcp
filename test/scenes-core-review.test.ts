/**
 * The review of the scenes' language and core (section C): each finding's
 * scenario, and the missing tests it listed.
 */

import { describe, expect, it } from "bun:test";

import { compile, DefinitionError, type Compiled } from "../src/scenes/definition";
import { match, run, type Actor, type Effect, type SceneEvent } from "../src/scenes/engine";
import { guide, PRESETS } from "../src/scenes/guide";
import {
  evaluate,
  LangError,
  parseExpr,
  parseStatement,
  renderTemplate,
  type Scope,
  type Value,
} from "../src/scenes/lang";
import { parseCallback, render, RenderError } from "../src/scenes/render";

const OWNER: Actor = { id: 1, name: "Owner" };
const ANN: Actor = { id: 2, name: "Ann" };
const BOB: Actor = { id: 3, name: "Bob" };
const CID: Actor = { id: 4, name: "Cid" };

function definitionError(input: unknown): DefinitionError {
  try {
    compile(input);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error("expected a DefinitionError");
}

type Step = { state: Record<string, Value>; effects: Effect[]; refused?: string; text?: string };

/** One event, as the bot layer runs it. */
function fire(
  compiled: Compiled,
  state: Record<string, Value>,
  user: Actor,
  on: string,
  arg?: Value,
  event?: Record<string, Value>,
): Step {
  const e: SceneEvent = { on, user, arg, event, now: 1000, owner: OWNER };
  const found = match(compiled, state, e);
  if ("refused" in found) return { state, effects: [], refused: found.refused, text: found.text };
  const result = run(compiled, state, e, found.rule);
  if ("refused" in result)
    return { state, effects: [], refused: result.refused, text: result.detail };
  return result;
}

/** A small scene: state, one view, and the rules given. */
const raw = (
  state: Record<string, Value>,
  rules: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  title: "t",
  state,
  view: { text: "x" },
  rules,
  ...extra,
});
const scene = (
  state: Record<string, Value>,
  rules: unknown[],
  extra: Record<string, unknown> = {},
) => compile(raw(state, rules, extra));

const scope = (state: Record<string, Value> = {}): Scope => ({
  state,
  vars: { now: 1 },
  lets: {},
  random: () => 0.5,
});

describe("C1: names on Object.prototype are no functions", () => {
  it("refuses toString, valueOf, __proto__, hasOwnProperty and constructor as calls", () => {
    for (const source of [
      "toString(1)",
      "valueOf()",
      "__proto__(1)",
      "hasOwnProperty('x')",
      "constructor(1)",
    ]) {
      expect(() => parseExpr(source)).toThrow(LangError);
    }
    expect(
      definitionError(raw({ x: 0 }, [{ on: "press:a", do: ["x = valueOf()", "x.len = 0"] }])).where,
    ).toBe("rules[0].do[0]");
    // len still works afterwards, for everyone.
    expect(evaluate(parseExpr("len([1, 2])"), scope(), { steps: 10 })).toBe(2);
  });

  it("show('constructor') names no view, and no preset is called constructor", () => {
    expect(definitionError(raw({}, [{ on: "press:a", do: ["show('constructor')"] }])).where).toBe(
      "rules[0].do",
    );
    expect(guide("constructor")).toStartWith('No preset "constructor"');
    expect(guide("toString")).toStartWith("No preset");
  });

  it("prototype names are ordinary state fields and map keys", () => {
    const { compiled, state } = scene({ constructor: 1, m: {} }, [
      { on: "press:a", do: ["constructor += 1", "m['__proto__'] = 5", "m['toString'] = 6"] },
    ]);
    const after = fire(compiled, state, ANN, "press:a").state;
    expect(after["constructor"]).toBe(2);
    expect(Object.keys(after.m as object)).toEqual(["__proto__", "toString"]);
    expect(evaluate(parseExpr("m['__proto__'] + len(m)"), scope(after), { steps: 50 })).toBe(7);
  });
});

describe("C2: the budget bounds time and memory", () => {
  /** Refused, and quickly. */
  function refusedFast(definition: unknown, press = "a") {
    const started = performance.now();
    let refused: string | undefined;
    try {
      const { compiled, state } = compile(definition);
      refused = fire(compiled, state, ANN, `press:${press}`).refused;
    } catch (error) {
      if (!(error instanceof DefinitionError)) throw error;
      refused = "definition";
    }
    expect(performance.now() - started).toBeLessThan(50);
    expect(refused).toBeDefined();
  }

  it("doubling texts into a list of thousands", () => {
    const lets: Record<string, string> = { s0: "'xxxxxxxx'" };
    for (let k = 1; k <= 11; k++) lets[`s${k}`] = `s${k - 1} + s${k - 1}`;
    lets.l0 = "[s11]";
    for (let k = 1; k <= 12; k++) lets[`l${k}`] = `l${k - 1} + l${k - 1}`;
    refusedFast({
      title: "t",
      state: { out: "" },
      let: lets,
      view: { text: "x" },
      rules: [{ on: "press:a", do: ["out = str(l12)"] }],
    });
  });

  it("nesting a value into itself", () => {
    refusedFast({
      title: "t",
      state: { x: [1] },
      view: { text: "x" },
      rules: [{ on: "press:a", do: Array.from({ length: 22 }, () => "x = [x, x]") }],
    });
  });

  it("comparing two deep shared structures", () => {
    const lets: Record<string, string> = { a0: "[1]", b0: "[1]" };
    for (let k = 1; k <= 20; k++) {
      lets[`a${k}`] = `[a${k - 1}, a${k - 1}]`;
      lets[`b${k}`] = `[b${k - 1}, b${k - 1}]`;
    }
    refusedFast({
      title: "t",
      state: { same: false },
      let: lets,
      view: { text: "x" },
      rules: [{ on: "press:a", do: ["same = a20 == b20"] }],
    });
  });

  it("join and each are checked before they build a long text", () => {
    refusedFast({
      title: "t",
      state: {
        items: Array.from({ length: 2000 }, (_, i) => `item ${i} ${"y".repeat(20)}`),
        out: "",
      },
      view: { text: "x" },
      rules: [{ on: "press:a", do: ["out = join(items, '----') + join(items, '----')"] }],
    });
    refusedFast({
      title: "t",
      state: {
        items: Array.from({ length: 2000 }, (_, i) => `item ${i} ${"y".repeat(20)}`),
        out: "",
      },
      view: { text: "x" },
      rules: [{ on: "press:a", do: ["out = each(items, '{it}{it}{it}')"] }],
    });
  });
});

describe("C3: each() inside a larger expression", () => {
  const def = (format: "markdown" | "rich", text: string) =>
    compile({
      title: "t",
      state: { items: [{ t: "**b** <i> | x\nnext" }, { t: "plain" }] },
      view: { text, format },
      rules: [],
    });

  it("shows the values, escaped once, in both formats", () => {
    for (const text of [
      "{len(items) ? each(items, '- {it.t};') : 'empty'}",
      "{each(items, '- {it.t};') + '!'}",
    ]) {
      const md = def("markdown", text);
      const shown = render(md.compiled, "main", md.state, { owner: OWNER, now: 1 });
      expect(shown.text).toContain("- **b** &lt;i&gt; | x\nnext;- plain;");
      expect(shown.text).not.toContain("<i>");
      const rich = def("rich", text);
      const richText = render(rich.compiled, "main", rich.state, { owner: OWNER, now: 1 }).text;
      expect(richText).toContain("plain");
      expect(richText).toContain("\\*\\*b\\*\\* \\<i\\> \\| x next");
    }
  });

  it("each() as the whole interpolation keeps its own markup", () => {
    const md = def("markdown", "{each(items, '**{it.t}**;')}");
    const text = render(md.compiled, "main", md.state, { owner: OWNER, now: 1 }).text;
    expect(text).toContain("<b>plain</b>");
    expect(text).toContain("&lt;i&gt;");
  });
});

describe("C4: assignment copies", () => {
  it("lists, maps, the user and the event's argument are never shared", () => {
    const { compiled, state } = scene(
      { cells: ["", ""], prev: null, a: null, b: null, got: null },
      [
        {
          on: "press:a",
          do: [
            "prev = cells",
            "cells[0] = 'x'",
            "a = user",
            "b = user",
            "a.name = 'changed'",
            "got = arg",
            "got[0] = 99",
          ],
        },
      ],
    );
    const arg: Value = [1, 2];
    const after = fire(compiled, state, ANN, "press:a", arg).state;
    expect(after.prev).toEqual(["", ""]);
    expect(after.cells).toEqual(["x", ""]);
    expect(after.b).toEqual({ id: 2, name: "Ann" });
    expect(after.got).toEqual([99, 2]);
    expect(arg).toEqual([1, 2]);
  });

  it("run leaves its input untouched after a broken or a full run", () => {
    const { compiled, state } = scene({ l: [1], big: "", pad: "p".repeat(3000) }, [
      { on: "press:a", do: ["l[0] = 5", "l = l * 2"] },
      { on: "press:b", do: ["l[0] = 7", "big = pad + pad + pad"] },
    ]);
    const before = structuredClone(state);
    expect(fire(compiled, state, ANN, "press:a").refused).toBe("broken");
    expect(fire(compiled, state, ANN, "press:b").refused).toBe("full");
    expect(state).toEqual(before);
  });
});

describe("C5: render enforces what Telegram takes", () => {
  it("a text that outgrows the message is refused, not drawn cut", () => {
    const { compiled, state } = compile({
      title: "rsvp",
      state: { yes: {} },
      view: { text: "Coming: {join(values(yes))}" },
      rules: [{ on: "press:yes", do: ["yes[user.id] = user.name"] }],
    });
    let current = state;
    for (let id = 1; id <= 40; id++) {
      current = fire(compiled, current, { id, name: `${"N".repeat(110)}${id}` }, "press:yes").state;
    }
    expect(() => render(compiled, "main", current, { owner: OWNER, now: 1 })).toThrow(RenderError);
  });

  it("buttons past 100, and callback data past 64 bytes, after the state grew", () => {
    const { compiled, state } = compile({
      title: "list",
      state: { items: [1], label: "a" },
      view: {
        text: "x",
        buttons: [{ each: "items", per_row: 8, text: "{it}", press: "p", arg: "label" }],
      },
      rules: [
        { on: "act:grow", do: ["items = arg"] },
        { on: "act:label", do: ["label = arg"] },
      ],
    });
    const many = fire(
      compiled,
      state,
      OWNER,
      "act:grow",
      Array.from({ length: 120 }, (_, i) => i),
    ).state;
    expect(() => render(compiled, "main", many, { owner: OWNER, now: 1 })).toThrow(/at most 100/);
    const long = fire(compiled, state, OWNER, "act:label", "z".repeat(60)).state;
    expect(() => render(compiled, "main", long, { owner: OWNER, now: 1, sceneId: 5 })).toThrow(
      /64 bytes/,
    );
  });
});

describe("C6: unknown keys", () => {
  it("are refused, naming the place", () => {
    const misspelt = definitionError(
      raw({ n: 0 }, [{ on: "press:a", whn: "false", do: ["n = 1"] }]),
    );
    expect(misspelt.where).toBe("rules[0]");
    expect(misspelt.message).toContain("whn");
    expect(
      definitionError({ title: "t", lets: {}, view: { text: "x" }, rules: [] }).message,
    ).toContain("lets");
    expect(definitionError({ title: "t", view: { text: "x", button: [] }, rules: [] }).where).toBe(
      "view",
    );
  });
});

describe("the core's minor findings", () => {
  it("bar() with a negative width draws nothing instead of throwing", () => {
    expect(evaluate(parseExpr("bar(5, 10, -3)"), scope(), { steps: 10 })).toBe("");
  });

  it("a value in a link's address stays inside the href", () => {
    const { compiled, state } = compile({
      title: "t",
      state: { u: 'a" x="y' },
      view: { text: "[site](https://ex.com/?q={u}) and {u}" },
      rules: [],
    });
    const text = render(compiled, "main", state, { owner: OWNER, now: 1 }).text;
    expect(text).toContain('href="https://ex.com/?q=a%22%20x%3D%22y"');
    expect(text).toContain("and a&quot; x=&quot;y");
  });

  it("post() of a member's text naming a view is a text, not another live view", () => {
    const { compiled, state } = compile({
      title: "t",
      state: {},
      views: { main: { text: "x" }, other: { text: "y" } },
      rules: [
        { on: "reply", do: ["post(event.text)"] },
        { on: "press:a", do: ["post('other')"] },
      ],
    });
    expect(fire(compiled, state, ANN, "reply", undefined, { text: "main" }).effects).toEqual([
      { kind: "post", text: "main" },
    ]);
    expect(fire(compiled, state, ANN, "press:a").effects).toEqual([
      { kind: "post", view: "other" },
    ]);
  });

  it("numbers: no Infinity from a literal or a sum; -null is 0", () => {
    expect(() => parseExpr("9".repeat(400))).toThrow(LangError);
    const s = scope({ big: 1.7e308, z: null });
    expect(evaluate(parseExpr("sum([big, big])"), s, { steps: 10 })).toBeNull();
    expect(evaluate(parseExpr("-z"), s, { steps: 10 })).toBe(0);
  });

  it("arity is checked when the scene is created", () => {
    for (const statement of [
      "n = line(n)",
      "wake()",
      "n = without()",
      "toast('a', 'b')",
      "finish(1)",
    ]) {
      expect(definitionError(raw({ n: 0 }, [{ on: "press:a", do: [statement] }])).where).toBe(
        "rules[0].do[0]",
      );
    }
  });

  it("assignment grows a list only by list[len] = v", () => {
    const { compiled, state } = scene({ items: [{ d: 1 }], l: [1] }, [
      { on: "press:a", do: ["items[arg].d = 5"] },
      { on: "press:b", do: ["l[1] = 2"] },
    ]);
    expect(fire(compiled, state, ANN, "press:a", 1).refused).toBe("broken");
    expect(fire(compiled, state, ANN, "press:b").state.l).toEqual([1, 2]);
  });

  it("a let that reads it, i or key is refused; inside each() it may", () => {
    expect(
      definitionError({
        title: "t",
        state: {},
        let: { x: "it + 1" },
        view: { text: "x" },
        rules: [],
      }).where,
    ).toBe("let.x");
    expect(() =>
      compile({
        title: "t",
        state: { l: [1] },
        let: { x: "each(l, '{it}')" },
        view: { text: "{x}" },
        rules: [],
      }),
    ).not.toThrow();
  });

  it("the guide says what is false, what `in` does on text, and that arguments are expressions", () => {
    const reference = guide(undefined);
    expect(reference).toContain("[] and {}");
    expect(reference).toContain("a piece of a text");
    expect(reference).toContain("Action arguments are expressions");
    expect(reference).toContain("map literal");
  });
});

describe("callback data from a hostile client", () => {
  it("is refused when it cannot be a button's", () => {
    expect(parseCallback("s:1:a:1e999")).toBeNull();
    expect(parseCallback("s:1:a:[1e999]")).toBeNull();
    expect(parseCallback(`s:1:a:${"[".repeat(60)}`)).toBeNull();
    expect(parseCallback(`s:1:a:"${"x".repeat(80)}"`)).toBeNull();
    expect(parseCallback("s:1:abcdefghijklmnopq")).toBeNull();
    expect(parseCallback('s:1:a:"x:y"')).toEqual({ sceneId: 1, press: "a", arg: "x:y" });
  });
});

describe("rules", () => {
  it("who as an expression, who after when, say with do, else branches", () => {
    const { compiled, state } = scene({ players: { "2": "Ann" }, n: 0, side: null }, [
      { on: "press:a", when: "n > 5", who: "owner", say: "late" },
      { on: "press:a", who: "has(players, user.id)", say: "added", do: ["n += 1"] },
      { on: "press:b", do: [{ if: "n > 0", do: ["side = 'then'"], else: ["side = 'else'"] }] },
    ]);
    expect(fire(compiled, state, BOB, "press:a")).toMatchObject({ refused: "not_for_you" });
    const added = fire(compiled, state, ANN, "press:a");
    expect(added.effects).toEqual([{ kind: "toast", text: "added" }]);
    expect(fire(compiled, state, ANN, "press:b").state.side).toBe("else");
    expect(fire(compiled, added.state, ANN, "press:b").state.side).toBe("then");
    // `when` comes first: a rule whose when fails does not refuse anyone.
    const late = { ...state, n: 9 };
    expect(fire(compiled, late, BOB, "press:a")).toMatchObject({ refused: "not_for_you" });
  });

  it("action arguments are checked when they run", () => {
    const { compiled, state } = scene({}, [
      { on: "press:a", do: ["dice('x')"] },
      { on: "press:b", do: ["tag({id: 99}, 'x')"] },
      { on: "press:c", do: ["poll('q', ['one'])"] },
      { on: "press:d", do: ["wake('no spaces allowed')"] },
    ]);
    for (const name of ["a", "b", "c", "d"]) {
      expect(fire(compiled, state, ANN, `press:${name}`).refused).toBe("broken");
    }
  });

  it("deal() with more roles than people gives each a role and drops the rest", () => {
    const dealt = evaluate(parseExpr("deal(['a', 'b', 'c'], [1, 2], 'z')"), scope(), { steps: 50 });
    expect(Object.keys(dealt as object).sort()).toEqual(["1", "2"]);
    expect(
      Object.values(dealt as object).every((role) => ["a", "b", "c"].includes(role as string)),
    ).toBe(true);
  });

  it("parsing a statement keeps an action's name free for a field", () => {
    expect(parseStatement("post = 1")).toMatchObject({ kind: "assign" });
  });
});

describe("every preset, from start to finish", () => {
  const play = (name: string) => compile(PRESETS[name]);

  it("rsvp", () => {
    const { compiled, state } = play("rsvp");
    let s = fire(compiled, state, ANN, "press:yes").state;
    s = fire(compiled, s, BOB, "press:no").state;
    s = fire(compiled, s, ANN, "press:no").state;
    expect(s).toEqual({ yes: {}, no: { "3": "Bob", "2": "Ann" } });
  });

  it("checklist", () => {
    const { compiled, state } = play("checklist");
    let s = state;
    let last: Effect[] = [];
    for (const i of [0, 1, 2])
      ({ state: s, effects: last } = fire(compiled, s, ANN, "press:tick", i));
    expect(last).toEqual([{ kind: "log", name: "done" }]);
  });

  it("task board", () => {
    const { compiled, state } = play("task_board");
    let s = fire(compiled, state, OWNER, "act:progress", 40).state;
    expect(fire(compiled, s, ANN, "press:pause").refused).toBe("not_for_you");
    s = fire(compiled, s, OWNER, "press:pause").state;
    s = fire(compiled, s, OWNER, "press:resume").state;
    const stop = fire(compiled, s, OWNER, "press:stop");
    expect(stop.effects).toEqual([{ kind: "wake", name: "stop" }, { kind: "finish" }]);
    expect(stop.state).toMatchObject({ status: "stopped", progress: 40 });
  });

  it("triage", () => {
    const { compiled, state } = play("triage");
    let s = state;
    for (const i of [0, 1, 2]) s = fire(compiled, s, OWNER, "press:mark", [i, "fix"]).state;
    expect(fire(compiled, s, OWNER, "press:done").effects).toEqual([
      { kind: "wake", name: "done" },
      { kind: "finish" },
    ]);
  });

  it("panel", () => {
    const { compiled, state } = play("panel");
    const deploy = fire(compiled, state, OWNER, "press:deploy");
    expect(deploy.effects).toEqual([
      { kind: "wake", name: "deploy" },
      { kind: "toast", text: "Sent" },
    ]);
    expect(render(compiled, "main", deploy.state, { owner: OWNER, now: 1000 }).plain).toContain(
      "Last: deploy, just now",
    );
  });

  it("tic-tac-toe", () => {
    const { compiled, state } = play("tictactoe");
    let s = state;
    for (const [who, cell] of [
      [ANN, 4],
      [BOB, 0],
      [ANN, 2],
      [BOB, 1],
    ] as const)
      s = fire(compiled, s, who, "press:cell", cell).state;
    const win = fire(compiled, s, ANN, "press:cell", 6);
    expect(win.state).toMatchObject({ winner: "x", win: [2, 4, 6], seats: { x: ANN, o: BOB } });
    // The game stays, for a rematch.
    expect(win.effects).toEqual([]);
  });

  it("quiz: an old keyboard's press does not answer the next question", () => {
    const { compiled, state } = play("quiz");
    let s = fire(compiled, state, ANN, "press:answer", [0, 1]).state;
    s = fire(compiled, s, OWNER, "press:next").state;
    expect(fire(compiled, s, BOB, "press:answer", [0, 1])).toMatchObject({
      refused: "said",
      text: "That question is over",
    });
    s = fire(compiled, s, BOB, "press:answer", [1, 1]).state;
    s = fire(compiled, s, OWNER, "press:next").state;
    const last = fire(compiled, s, OWNER, "press:next");
    expect(last.effects).toEqual([{ kind: "log", name: "over" }, { kind: "finish" }]);
    expect(last.state.scores).toEqual({ "2": 1, "3": 1 });
  });

  /** Start a mafia game with roles chosen by a fixed deal. */
  function mafia(roles: Record<string, string>) {
    const { compiled, state } = play("mafia");
    let s = state;
    for (const who of [OWNER, ANN, BOB, CID]) s = fire(compiled, s, who, "press:join").state;
    s = fire(compiled, s, OWNER, "press:start").state;
    // The deal is random; the test sets it.
    return { compiled, state: { ...s, roles } as Record<string, Value> };
  }
  const ROLES = { "1": "civ", "2": "mafia", "3": "doc", "4": "cop" };

  it("mafia: a doctor's save, a tie, and the town's win", () => {
    const { compiled } = mafia(ROLES);
    let s = mafia(ROLES).state;
    // Night 1: the mafia goes for Owner, the doctor guards Owner: nobody dies.
    for (const [who, target] of [
      [ANN, "1"],
      [BOB, "1"],
      [CID, "2"],
    ] as const) {
      const step = fire(compiled, s, who, "press:pick", target);
      expect(step.effects.some((e) => e.kind === "wake")).toBe(false);
      s = step.state;
    }
    let end = fire(compiled, s, OWNER, "press:pick", "3");
    expect(end.effects.at(-1)).toEqual({ kind: "wake", name: "night_over" });
    s = end.state;
    expect(s).toMatchObject({ phase: "day", out: null });
    expect(s.alive).toHaveLength(4);
    // Day 1: two against two, a tie: nobody leaves.
    for (const [who, target] of [
      [OWNER, "2"],
      [CID, "2"],
      [ANN, "1"],
    ] as const)
      s = fire(compiled, s, who, "press:pick", target).state;
    end = fire(compiled, s, BOB, "press:pick", "1");
    expect(end.effects.at(-1)).toEqual({ kind: "wake", name: "day_over" });
    s = end.state;
    expect(s).toMatchObject({ phase: "night", out: null, day: 2 });
    // Night 2 ends by the owner's Next though the cop never taps; then the town votes the mafia out.
    s = fire(compiled, s, ANN, "press:pick", "4").state;
    s = fire(compiled, s, BOB, "press:pick", "1").state;
    end = fire(compiled, s, OWNER, "press:next");
    s = end.state;
    expect(s).toMatchObject({ phase: "day", out: "4" });
    expect(fire(compiled, s, CID, "press:pick", "2").text).toBe("You are out of the game");
    expect(fire(compiled, s, CID, "press:role").text).toBe("You were cop");
    for (const who of [OWNER, BOB]) s = fire(compiled, s, who, "press:pick", "2").state;
    end = fire(compiled, s, ANN, "press:pick", "1");
    expect(end.state).toMatchObject({ winner: "town", phase: "over", out: "2" });
    expect(end.effects).toContainEqual({ kind: "finish" });
  });

  it("mafia: the mafia wins when it is as many as the rest; act:next ends a stuck phase", () => {
    const { compiled } = mafia(ROLES);
    let s = mafia(ROLES).state;
    // Night: the mafia kills the doctor; nobody else taps, the host's session moves on.
    s = fire(compiled, s, ANN, "press:pick", "3").state;
    s = fire(compiled, s, OWNER, "act:next").state;
    expect(s).toMatchObject({ phase: "day", out: "3" });
    // Day: the town wrongly votes out the cop: one mafia against one civilian.
    for (const who of [OWNER, ANN, CID]) s = fire(compiled, s, who, "press:pick", "4").state;
    expect(s).toMatchObject({ winner: "mafia", phase: "over" });
  });

  it("each preset's name is in the guide", () => {
    expect(guide("presets")).toContain(Object.keys(PRESETS).join(", "));
  });
});

describe("rendering values in templates", () => {
  it("renderTemplate escapes a value made by each() inside a ternary", () => {
    const s = scope({ items: ["<b>"] });
    const out = renderTemplate(
      [parseExpr("true ? each(items, '[{it}]') : ''")],
      s,
      { steps: 50 },
      (value) => value.replaceAll("<", "&lt;"),
    );
    expect(out).toBe("[&lt;b>]");
  });
});
