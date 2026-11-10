import { describe, expect, it } from "bun:test";

import { compile, DefinitionError, wakingRules, type Compiled } from "../src/scenes/definition";
import { match, run, type Actor, type Effect, type SceneEvent } from "../src/scenes/engine";
import type { Value } from "../src/scenes/lang";
import { callbackData, parseCallback, render } from "../src/scenes/render";
import { TICTACTOE, TRIAGE } from "./scenes-fixtures";

const OWNER: Actor = { id: 1, name: "Owner" };
const ANN: Actor = { id: 2, name: "Ann" };
const BOB: Actor = { id: 3, name: "Bob" };
const CID: Actor = { id: 4, name: "Cid" };

/** Press, the way the bot layer does: match, then run the rule that matched. */
function press(
  compiled: Compiled,
  state: Record<string, Value>,
  user: Actor,
  name: string,
  arg?: Value,
): { state: Record<string, Value>; effects: Effect[]; refused?: string; text?: string } {
  const event: SceneEvent = { on: `press:${name}`, user, arg, now: 1000, owner: OWNER };
  const found = match(compiled, state, event);
  if ("refused" in found) return { state, effects: [], refused: found.refused, text: found.text };
  const result = run(compiled, state, event, found.rule);
  if ("refused" in result) return { state, effects: [], refused: result.refused };
  return result;
}

function definitionError(input: unknown): DefinitionError {
  try {
    compile(input);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error("expected a DefinitionError");
}

describe("tic-tac-toe", () => {
  it("compiles, and X wins on the diagonal", () => {
    const { compiled, state: initial } = compile(TICTACTOE);
    let state = initial;
    const shown = render(compiled, "main", state, { owner: OWNER, now: 1000 });
    expect(shown.rows).toHaveLength(3);
    expect(shown.rows[0].map((b) => b.text)).toEqual(["·", "·", "·"]);
    expect(shown.text).toContain("<b>Крестики-нолики</b>");
    expect(shown.text).toContain("Ход: ❌");

    for (const [who, cell] of [
      [ANN, 0],
      [BOB, 1],
      [ANN, 4],
      [BOB, 2],
    ] as const) {
      const step = press(compiled, state, who, "cell", cell);
      expect(step.refused).toBeUndefined();
      state = step.state;
    }
    // A third person is refused while seats are taken; a taken cell too.
    expect(press(compiled, state, CID, "cell", 8)).toMatchObject({
      refused: "said",
      text: "Сейчас ходит Ann",
    });
    expect(press(compiled, state, ANN, "cell", 1)).toMatchObject({
      refused: "said",
      text: "Занято",
    });
    const win = press(compiled, state, ANN, "cell", 8);
    expect(win.effects).toEqual([{ kind: "finish" }]);
    expect(win.state.won).toEqual({ id: 2, name: "Ann" });
    expect(render(compiled, "main", win.state, { owner: OWNER, now: 1 }).text).toContain(
      "Победил Ann",
    );
    expect(press(compiled, win.state, BOB, "cell", 7)).toMatchObject({
      refused: "said",
      text: "Игра окончена",
    });
  });

  it("ends in a draw", () => {
    const { compiled, state: initial } = compile(TICTACTOE);
    let state = initial;
    // x o x / x o o / o x x
    const moves = [0, 1, 2, 4, 3, 5, 7, 6, 8];
    let last: Effect[] = [];
    for (const [n, cell] of moves.entries()) {
      const step = press(compiled, state, n % 2 ? BOB : ANN, "cell", cell);
      expect(step.refused).toBeUndefined();
      state = step.state;
      last = step.effects;
    }
    expect(state.won).toBeNull();
    expect(last).toEqual([{ kind: "finish" }]);
    expect(render(compiled, "main", state, { owner: OWNER, now: 1 }).text).toContain("Ничья");
  });
});

describe("triage", () => {
  it("only the owner marks; done waits for every item, then wakes and finishes", () => {
    const { compiled, state: initial } = compile(TRIAGE);
    expect(press(compiled, initial, ANN, "mark", [0, "fix"])).toMatchObject({
      refused: "not_for_you",
      text: "Owner",
    });
    let state = initial;
    state = press(compiled, state, OWNER, "mark", [0, "fix"]).state;
    expect(press(compiled, state, OWNER, "done")).toMatchObject({
      refused: "said",
      text: "Остались неразобранные",
    });
    state = press(compiled, state, OWNER, "mark", [1, "skip"]).state;
    state = press(compiled, state, OWNER, "mark", [2, "later"]).state;
    const done = press(compiled, state, OWNER, "done");
    expect(done.effects).toEqual([{ kind: "wake", name: "done" }, { kind: "finish" }]);
    const event: SceneEvent = { on: "press:done", user: OWNER, now: 1, owner: OWNER };
    expect(match(compiled, state, event)).toEqual({ rule: 2, wakes: true });

    const shown = render(compiled, "main", state, { owner: OWNER, now: 1 });
    expect(shown.text).toContain("1. SQL без индекса — fix");
    expect(shown.rows).toHaveLength(4);
    expect(shown.rows[0].map((b) => b.arg)).toEqual([
      [0, "fix"],
      [0, "skip"],
      [0, "later"],
    ]);
    expect(shown.rows[3][0]).toMatchObject({ text: "Готово", press: "done", style: "success" });
  });

  it("names the rules that wake", () => {
    expect(wakingRules(compile(TRIAGE).compiled)).toEqual([{ on: "press:done", who: "owner" }]);
    expect(wakingRules(compile(TICTACTOE).compiled)).toEqual([]);
  });
});

describe("limits and mistakes", () => {
  const base = { title: "t", state: { n: 0 }, view: { text: "{n}" }, rules: [] as unknown[] };

  it("each limit names the place", () => {
    const rule = { on: "press:a", do: ["n += 1"] };
    expect(definitionError({ ...base, rules: Array(41).fill(rule) }).where).toBe("rules");
    expect(
      definitionError({
        ...base,
        view: undefined,
        views: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, { text: "x" }])),
      }).where,
    ).toBe("views");
    expect(definitionError({ ...base, state: { big: "x".repeat(9000) } }).where).toBe("state");
    expect(definitionError({ ...base, brief: "x".repeat(17_000) }).where).toBe("definition");
    const row = Array.from({ length: 9 }, () => ({ text: "b", press: "a" }));
    expect(definitionError({ ...base, view: { text: "x", buttons: [row] } }).where).toBe(
      "view.buttons[0]",
    );
    const many = Array.from({ length: 13 }, () =>
      Array.from({ length: 8 }, () => ({ text: "b", press: "a" })),
    );
    expect(definitionError({ ...base, view: { text: "x", buttons: many } }).where).toBe(
      "view.buttons",
    );
    expect(
      definitionError({
        ...base,
        view: { text: "x", buttons: [[{ text: "b", press: "This-Is-Bad" }]] },
      }).where,
    ).toBe("view.buttons[0][0].press");
    expect(
      definitionError({
        ...base,
        view: {
          text: "x",
          buttons: [[{ text: "b", press: "a", arg: "'" + "y".repeat(60) + "'" }]],
        },
      }).where,
    ).toBe("view.buttons[0][0]");
    const deep = {
      if: "true",
      do: [{ if: "true", do: [{ if: "true", do: [{ if: "true", do: [] }] }] }],
    };
    expect(definitionError({ ...base, rules: [{ on: "press:a", do: [deep] }] }).where).toBe(
      "rules[0].do[0].do[0].do[0].do[0]",
    );
  });

  it("a mistake inside each() names the button it comes from, past hidden ones", () => {
    const long = "'" + "y".repeat(60) + "'";
    const view = {
      text: "x",
      buttons: [
        { each: "items", row: [{ text: "ok", press: "a" }] },
        {
          each: "items",
          row: [
            { text: "hidden", press: "a", show: "false" },
            { text: "shown", press: "a" },
            { text: "long", press: "a", arg: long },
          ],
        },
      ],
    };
    expect(definitionError({ ...base, state: { items: [1] }, view }).where).toBe(
      "view.buttons[1].row[2]",
    );
    const { compiled, state } = compile({
      ...base,
      state: { items: [1, 2] },
      view: {
        text: "x",
        buttons: [
          {
            each: "items",
            row: [
              { text: "hidden", press: "a", show: "false" },
              { text: "shown", press: "a" },
            ],
          },
        ],
      },
    });
    expect(render(compiled, "main", state, { owner: OWNER, now: 0 }).places).toEqual([
      ["buttons[0].row[1]"],
      ["buttons[0].row[1]"],
    ]);
  });

  it("points at a mistake inside an expression", () => {
    const error = definitionError({
      ...base,
      rules: [
        { on: "press:a", do: ["n += 1"] },
        { on: "press:b", when: "n >", do: [] },
      ],
    });
    expect(error.where).toBe("rules[1].when");
    expect(error.at).toBe(3);
    expect(error.source).toBe("n >");
  });

  it("refuses unknown and reserved names", () => {
    expect(definitionError({ ...base, view: { text: "{nope}" } }).where).toBe("view.text");
    expect(definitionError({ ...base, state: { user: 1 } }).where).toBe("state.user");
    expect(definitionError({ ...base, let: { len: "1" } }).where).toBe("let.len");
    expect(
      definitionError({ ...base, rules: [{ on: "press:a", do: ["missing = 1"] }] }).where,
    ).toBe("rules[0].do[0]");
    expect(definitionError({ ...base, rules: [{ on: "nonsense", do: [] }] }).where).toBe(
      "rules[0].on",
    );
    expect(definitionError({ ...base, wake_limit: 11 }).where).toBe("wake_limit");
  });

  it("a state that outgrows 8 KB refuses the event and keeps the old state", () => {
    const { compiled, state } = compile({
      title: "join",
      state: { players: {} },
      view: { text: "{len(players)}", buttons: [[{ text: "Join", press: "join" }]] },
      rules: [{ on: "press:join", do: ["players[user.id] = user.name + str(slice(pad, 0, 300))"] }],
      let: { pad: "'" + "p".repeat(300) + "'" },
    });
    let current = state;
    let refused: string | undefined;
    for (let id = 1; id <= 40 && !refused; id++) {
      const step = press(compiled, current, { id, name: `P${id}` }, "join");
      refused = step.refused;
      if (!refused) current = step.state;
    }
    expect(refused).toBe("full");
    expect(JSON.stringify(current).length).toBeLessThanOrEqual(8192);
  });
});

describe("callback data", () => {
  it("round-trips, a list argument too", () => {
    for (const arg of [undefined, 3, "fix", [1, "fix"], null]) {
      const data = callbackData(12, { text: "x", press: "mark", arg });
      expect(parseCallback(data)).toEqual({ sceneId: 12, press: "mark", arg });
    }
    expect(callbackData(5, { text: "x", press: "done" })).toBe("s:5:done");
    expect(parseCallback("s:5:done:{bad")).toBeNull();
    expect(parseCallback("s:x:done")).toBeNull();
    expect(parseCallback("s:5:Bad")).toBeNull();
  });
});

describe("escaping", () => {
  it("a member's name with markup or braces reads literally", () => {
    const { compiled, state } = compile({
      title: "who",
      state: { last: null },
      view: { text: "**Last:** {last}", format: "markdown" },
      rules: [{ on: "press:a", do: ["last = user.name"] }],
    });
    const name = "*x* _y_ {state} <b>&";
    const event: SceneEvent = { on: "press:a", user: { id: 9, name }, now: 1, owner: OWNER };
    const after = run(compiled, state, event, 0) as { state: Record<string, Value> };
    const shown = render(compiled, "main", after.state, { owner: OWNER, now: 1 });
    expect(shown.text).toBe("<b>Last:</b> *x* _y_ {state} &lt;b&gt;&amp;");
    expect(shown.plain).toBe(`**Last:** ${name}`);

    const rich = compile({
      ...{ title: "r", state: { v: "*a* <i>" } },
      view: { text: "# {v}", format: "rich" },
      rules: [],
    });
    expect(render(rich.compiled, "main", rich.state, { owner: OWNER, now: 1 }).text).toBe(
      "# \\*a\\* \\<i\\>",
    );
  });
});
