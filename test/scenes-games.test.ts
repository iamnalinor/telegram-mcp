/**
 * The ready-made games, played through the real engine: match and run as
 * the bot layer calls them, render after every press as the bot would.
 */

import { describe, expect, it } from "bun:test";

import { compile, type Compiled } from "../src/scenes/definition";
import { match, run, type Effect, type SceneEvent } from "../src/scenes/engine";
import { FUNCTIONS } from "../src/scenes/functions";
import { CHECKERS_START, checkers, GAMES, ticTacToe } from "../src/scenes/games";
import { PRESETS } from "../src/scenes/guide";
import { sizeOf, type Value } from "../src/scenes/lang";
import { render, type Rendered } from "../src/scenes/render";

const OWNER = { id: 1, name: "Owner" };
const ANN = { id: 2, name: "Ann" };
const BOB = { id: 3, name: "Bob" };
const CID = { id: 4, name: "Cid" };

type State = Record<string, Value>;

/** A scene in memory: presses go through match and run, and every new state is drawn. */
class Table {
  readonly compiled: Compiled;
  state: State;
  effects: Effect[] = [];

  constructor(definition: unknown, state?: Partial<State>) {
    const built = compile(definition);
    this.compiled = built.compiled;
    this.state = { ...built.state, ...state } as State;
  }

  /** A press: its answer (a refusal's text, or the rule's toast), and whether it changed anything. */
  press(
    user: { id: number; name: string },
    name: string,
    arg?: Value,
  ): { ok: boolean; text?: string } {
    const event: SceneEvent = { on: `press:${name}`, user, arg, now: 1000, owner: OWNER };
    const found = match(this.compiled, this.state, event);
    if ("refused" in found) return { ok: false, text: found.text };
    const result = run(this.compiled, this.state, event, found.rule);
    if ("refused" in result) throw new Error(`refused: ${result.detail}`);
    this.state = result.state;
    this.effects = result.effects;
    this.screen();
    const toast = result.effects.find((effect) => effect.kind === "toast");
    return { ok: true, ...(toast && "text" in toast ? { text: toast.text } : {}) };
  }

  /** Press, and fail the test if it was refused. */
  play(user: { id: number; name: string }, name: string, arg?: Value): void {
    const answer = this.press(user, name, arg);
    if (!answer.ok) throw new Error(`${name} ${JSON.stringify(arg)} refused: ${answer.text}`);
  }

  screen(): Rendered {
    return render(this.compiled, "main", this.state, { owner: OWNER, now: 1000, sceneId: 1 });
  }

  /** The board's buttons, in order: the first `n` of the keyboard. */
  cells(n: number) {
    return this.screen().rows.flat().slice(0, n);
  }

  /** Buttons after the board, by text. */
  controls(n: number) {
    return this.screen()
      .rows.flat()
      .slice(n)
      .map((button) => `${button.text}${button.style ? ` [${button.style}]` : ""}`);
  }
}

/** A seeded generator, so a failing random game can be played again. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("the games compile within the limits", () => {
  for (const [key, build] of Object.entries(GAMES)) {
    for (const lang of ["en", "ru"] as const) {
      it(`${key} in ${lang}`, () => {
        const definition = build(lang);
        expect(bytes(definition)).toBeLessThan(16_384);
        expect(definition.rules.length).toBeLessThanOrEqual(40);
        const { state } = compile(definition);
        expect(bytes(state)).toBeLessThan(8192);
        // Nothing in a game wakes an assistant: it runs alone.
        expect(JSON.stringify(definition)).not.toContain("wake(");
      });
    }
  }

  it("scene_guide's presets are the English games", () => {
    expect(PRESETS.tictactoe).toEqual(ticTacToe("en"));
    expect(PRESETS.checkers).toEqual(checkers("en"));
  });
});

describe("tic-tac-toe", () => {
  const board = (table: Table) => table.cells(9);

  it("seats the first two players, and a line wins in green", () => {
    const table = new Table(ticTacToe("en"));
    expect(table.screen().plain).toContain("❌ tap a cell to play");
    table.play(ANN, "cell", 0);
    expect(table.state.seats).toEqual({ x: ANN, o: null });
    expect(table.screen().plain).toContain("⭕ tap a cell to play");
    table.play(BOB, "cell", 3);
    expect(table.state.seats).toEqual({ x: ANN, o: BOB });
    expect(table.screen().plain).toContain("❌ Ann to move");
    // The last move is blue; whose turn it is, on the seat buttons.
    expect(board(table)[3]).toMatchObject({ text: "⭕", style: "primary" });
    expect(table.controls(9)).toEqual(["❌ Ann [primary]", "⭕ Bob"]);
    table.play(ANN, "cell", 1);
    table.play(BOB, "cell", 4);
    table.play(ANN, "cell", 2);

    expect(table.state).toMatchObject({ winner: "x", win: [0, 1, 2], score: { "2": 1 } });
    expect(board(table).map((b) => b.style ?? "")).toEqual([
      "success",
      "success",
      "success",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    expect(table.screen().plain).toContain("❌ Ann wins! 🎉");
    expect(table.screen().plain).toContain("Score: Ann 1 : 0 Bob");
    expect(table.controls(9)).toEqual([
      "❌ Ann [success]",
      "⭕ Bob",
      "🔁 Rematch [primary]",
      "■ End",
    ]);
    // A game over does not end the scene: the rematch is a press away.
    expect(table.effects).toEqual([]);
  });

  it("refuses the wrong player, a taken cell, and what is not a cell", () => {
    const table = new Table(ticTacToe("en"));
    table.play(ANN, "cell", 4);
    table.play(BOB, "cell", 0);
    const before = structuredClone(table.state);
    expect(table.press(BOB, "cell", 8)).toEqual({ ok: false, text: "It is Ann's turn" });
    expect(table.press(CID, "cell", 8)).toEqual({ ok: false, text: "It is Ann's turn" });
    expect(table.press(ANN, "cell", 0)).toEqual({ ok: false, text: "Taken" });
    for (const arg of [9, -1, 1.5, "4", null, [4], { a: 1 }]) {
      expect(table.press(ANN, "cell", arg)).toEqual({
        ok: false,
        text: "That is not on the board",
      });
    }
    expect(table.press(ANN, "seat", "z")).toEqual({ ok: false, text: "That is not on the board" });
    expect(table.state).toEqual(before);
  });

  it("a draw, then a rematch that swaps who opens and keeps the score", () => {
    const table = new Table(ticTacToe("en"));
    for (const [who, cell] of [
      [ANN, 0],
      [BOB, 1],
      [ANN, 2],
      [BOB, 4],
      [ANN, 3],
      [BOB, 5],
      [ANN, 7],
      [BOB, 6],
      [ANN, 8],
    ] as const)
      table.play(who, "cell", cell);
    expect(table.state).toMatchObject({ winner: "draw", draws: 1, games: 1 });
    expect(table.screen().plain).toContain("A draw 🤝");
    expect(table.press(BOB, "cell", 0)).toEqual({
      ok: false,
      text: "The game is over: 🔁 for a rematch",
    });
    expect(table.press(CID, "again")).toEqual({ ok: false, text: "Only the players can" });

    table.play(BOB, "again");
    expect(table.state).toMatchObject({
      seats: { x: BOB, o: ANN },
      turn: "x",
      winner: null,
      win: [],
      cells: ["", "", "", "", "", "", "", "", ""],
      draws: 1,
    });
    expect(table.screen().plain).toContain("❌ Bob to move");
    expect(table.press(ANN, "cell", 4)).toEqual({ ok: false, text: "It is Bob's turn" });
    expect(table.press(ANN, "again")).toEqual({ ok: false, text: "The game is still on" });
    // Bob wins the second game with the column.
    for (const [who, cell] of [
      [BOB, 0],
      [ANN, 1],
      [BOB, 3],
      [ANN, 2],
      [BOB, 6],
    ] as const)
      table.play(who, "cell", cell);
    expect(table.state).toMatchObject({ winner: "x", win: [0, 3, 6], games: 2, score: { "3": 1 } });
    expect(table.screen().plain).toContain("Score: Bob 1 : 0 Ann, draws: 1");
    table.play(ANN, "end");
    expect(table.effects).toEqual([{ kind: "finish" }]);
  });

  it("seats: taken, left before the start, locked once it starts, both sides on purpose", () => {
    const table = new Table(ticTacToe("en"));
    table.play(ANN, "seat", "x");
    expect(table.press(BOB, "seat", "x")).toEqual({ ok: false, text: "That seat is Ann's" });
    table.play(ANN, "seat", "x");
    expect(table.state.seats).toEqual({ x: null, o: null });
    table.play(ANN, "cell", 4);
    // Alone at the table: the other side is not taken by a tap on the board.
    expect(table.press(ANN, "cell", 0)).toEqual({
      ok: false,
      text: "Waiting for a second player. Take the other seat yourself to play both sides.",
    });
    expect(table.press(ANN, "seat", "x")).toEqual({
      ok: false,
      text: "You are playing: seats change at a rematch",
    });
    table.play(ANN, "seat", "o");
    table.play(ANN, "cell", 0);
    table.play(ANN, "cell", 8);
    expect(table.state.cells).toEqual(["o", "", "", "", "x", "", "", "", "x"]);
  });

  it("the bot answers in the same press, blocks, and takes a win", () => {
    const table = new Table(ticTacToe("en"));
    expect(table.controls(9)).toContain("🤖 Play the bot");
    table.play(ANN, "bot");
    expect(table.state.seats).toEqual({ x: ANN, o: { id: 0, name: "🤖 Bot" } });
    table.play(ANN, "cell", 0);
    // The centre, when nothing is to win or block.
    expect(table.state.cells).toEqual(["x", "", "", "", "o", "", "", "", ""]);
    expect(table.state.turn).toBe("x");
    table.play(ANN, "cell", 1);
    expect((table.state.cells as Value[])[2]).toBe("o");
    // Ann does not block 2-4-6: the bot completes it.
    table.play(ANN, "cell", 3);
    expect(table.state).toMatchObject({ winner: "o", win: [2, 4, 6], score: { "0": 1 } });
    expect(table.screen().plain).toContain("⭕ 🤖 Bot wins! 🎉");

    // The rematch gives the bot ❌: it opens at once, on a corner or the centre.
    table.play(ANN, "again");
    expect(table.state.seats).toEqual({ x: { id: 0, name: "🤖 Bot" }, o: ANN });
    const opened = (table.state.cells as string[]).flatMap((c, i) => (c ? [i] : []));
    expect(opened).toHaveLength(1);
    expect([0, 2, 4, 6, 8]).toContain(opened[0]);
    expect(table.state.turn).toBe("o");
  });

  it("the bot is not for someone else's game, nor once it started", () => {
    const table = new Table(ticTacToe("en"));
    table.play(ANN, "seat", "x");
    expect(table.press(BOB, "bot")).toEqual({ ok: false, text: "Only the players can" });
    table.play(ANN, "cell", 4);
    expect(table.press(ANN, "bot")).toEqual({
      ok: false,
      text: "You are playing: seats change at a rematch",
    });
  });

  it("random games against the bot all end within the limits", () => {
    const random = seeded(7);
    for (let game = 0; game < 200; game++) {
      const table = new Table(ticTacToe(game % 2 ? "ru" : "en"));
      table.play(ANN, "bot");
      for (let turn = 0; turn < 9 && table.state.winner === null; turn++) {
        const free = (table.state.cells as string[]).flatMap((c, i) => (c ? [] : [i]));
        table.play(ANN, "cell", free[Math.floor(random() * free.length)]);
      }
      expect(table.state.winner).not.toBeNull();
      expect(sizeOf(table.state, 8192)).toBeLessThan(8192);
    }
  });

  it("speaks Russian", () => {
    const table = new Table(ticTacToe("ru"));
    table.play(ANN, "cell", 4);
    expect(table.screen().plain).toContain("⭕ нажми на клетку, чтобы играть");
    table.play(BOB, "cell", 0);
    expect(table.press(BOB, "cell", 1)).toEqual({ ok: false, text: "Сейчас ходит Ann" });
  });
});

describe("checkers", () => {
  /** a1 is the bottom left, white's side. */
  const sq = (name: string) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
  const empty = (): string[] => CHECKERS_START.map((cell) => (cell === "-" ? "-" : ""));
  /** A position: white and black pieces by square, the rest empty. */
  const position = (pieces: Record<string, string>) => {
    const board = empty();
    for (const [name, piece] of Object.entries(pieces)) board[sq(name)] = piece;
    return board;
  };
  /** Both seated, `pieces` on the board, white to move unless said otherwise. */
  const seated = (pieces: Record<string, string>, extra: Partial<State> = {}) =>
    new Table(checkers("en"), { board: position(pieces), seats: { w: ANN, b: BOB }, ...extra });
  const squares = (table: Table, style: string) =>
    table
      .cells(64)
      .flatMap((button, i) =>
        button.style === style ? [`${"abcdefgh"[i % 8]}${8 - Math.floor(i / 8)}`] : [],
      );

  it("opens: select, the squares to go, a move, and the turn passes", () => {
    const table = new Table(checkers("en"));
    expect(table.cells(64)).toHaveLength(64);
    expect(
      table
        .screen()
        .rows.slice(0, 8)
        .every((row) => row.length === 8),
    ).toBe(true);
    expect(table.screen().plain).toContain("⚪ tap a piece to play");
    // Black's men cannot move on white's turn, and nobody plays black yet.
    expect(table.press(BOB, "sq", sq("f6"))).toEqual({
      ok: false,
      text: "Tap one of your pieces first",
    });

    table.play(ANN, "sq", sq("c3"));
    expect(table.state.seats).toEqual({ w: ANN, b: null });
    expect(squares(table, "primary")).toEqual(["c3"]);
    expect(squares(table, "success")).toEqual(["b4", "d4"]);
    expect(table.cells(64)[sq("d4")].text).toBe("•");
    // Not a move: a square too far, a light one.
    for (const to of ["c5", "e5", "c4"]) {
      expect(table.press(ANN, "sq", sq(to))).toEqual({
        ok: false,
        text: "That move is not allowed",
      });
    }
    // A man with nowhere to go.
    expect(table.press(ANN, "sq", sq("b2"))).toEqual({ ok: false, text: "That piece cannot move" });
    // Tapping the piece again lets it go.
    table.play(ANN, "sq", sq("c3"));
    expect(table.state.sel).toBeNull();
    table.play(ANN, "sq", sq("c3"));
    table.play(ANN, "sq", sq("d4"));
    expect(table.state).toMatchObject({ turn: "b", plies: 1, last: "⚪ c3-d4", sel: null });
    expect(table.screen().plain).toContain("Last: ⚪ c3-d4");
    expect(table.press(ANN, "sq", sq("f6"))).toEqual({
      ok: false,
      text: "Waiting for a second player. Take the other seat yourself to play both sides.",
    });
    table.play(BOB, "sq", sq("f6"));
    table.play(BOB, "sq", sq("e5"));
    expect(table.state.seats).toEqual({ w: ANN, b: BOB });
    expect(table.screen().plain).toContain("⚪ Ann to move — capturing is mandatory ⚔");
  });

  it("enforces the capture, then the recapture", () => {
    const table = new Table(checkers("en"));
    for (const [who, from, to] of [
      [ANN, "c3", "d4"],
      [BOB, "f6", "e5"],
    ] as const) {
      table.play(who, "sq", sq(from));
      table.play(who, "sq", sq(to));
    }
    // d4 must take e5: it shows red, and nothing else may move.
    expect(squares(table, "danger")).toEqual(["d4"]);
    expect(table.press(ANN, "sq", sq("a3"))).toEqual({
      ok: false,
      text: "You must capture: the pieces in red can",
    });
    table.play(ANN, "sq", sq("d4"));
    expect(squares(table, "success")).toEqual(["f6"]);
    table.play(ANN, "sq", sq("f6"));
    expect(table.state).toMatchObject({ turn: "b", last: "⚪ d4:f6", taken: { w: 1, b: 0 } });
    const after: string[] = [...CHECKERS_START];
    after[sq("c3")] = "";
    after[sq("e5")] = "";
    after[sq("f6")] = "w";
    expect(table.state.board).toEqual(after);
    // Black has two ways to take back, and must take one.
    expect(squares(table, "danger").sort()).toEqual(["e7", "g7"]);
    expect(table.press(BOB, "sq", sq("b6"))).toEqual({
      ok: false,
      text: "You must capture: the pieces in red can",
    });
    table.play(BOB, "sq", sq("g7"));
    expect(table.press(BOB, "sq", sq("g6"))).toEqual({
      ok: false,
      text: "You must capture: the pieces in red can",
    });
    table.play(BOB, "sq", sq("e5"));
    expect(table.state).toMatchObject({ turn: "w", taken: { w: 1, b: 1 } });
  });

  it("a capture goes on as a chain, the taken stay until it ends, and must be finished", () => {
    const table = seated({ c1: "w", d2: "b", f4: "b", h8: "b", a7: "b" });
    table.play(ANN, "sq", sq("c1"));
    table.play(ANN, "sq", sq("e3"));
    expect(table.state).toMatchObject({ chain: sq("e3"), sel: sq("e3"), turn: "w" });
    expect(table.cells(64)[sq("d2")].text).toBe("✖");
    expect(squares(table, "success")).toEqual(["g5"]);
    expect(table.screen().plain).toContain("⚪ Ann keeps capturing e3");
    for (const tap of ["e3", "a1", "d2"]) {
      expect(table.press(ANN, "sq", sq(tap))).toEqual({
        ok: false,
        text: "Keep capturing with the same piece",
      });
    }
    table.play(ANN, "sq", sq("g5"));
    expect(table.state).toMatchObject({
      chain: null,
      turn: "b",
      last: "⚪ c1:e3:g5",
      taken: { w: 2, b: 0 },
    });
    expect(table.state.board).toEqual(position({ g5: "w", h8: "b", a7: "b" }));
  });

  it("a man crowned mid-capture goes on as a flying king", () => {
    const table = seated({ f6: "w", e7: "b", b6: "b", h4: "b" });
    table.play(ANN, "sq", sq("f6"));
    table.play(ANN, "sq", sq("d8"));
    expect((table.state.board as Value[])[sq("d8")]).toBe("W");
    expect(table.cells(64)[sq("d8")].text).toBe("🤍");
    // From d8 the king flies over c7 to take b6.
    expect(squares(table, "success")).toEqual(["a5"]);
    table.play(ANN, "sq", sq("a5"));
    expect(table.state.board).toEqual(position({ a5: "W", h4: "b" }));
    expect(table.state).toMatchObject({ turn: "b", taken: { w: 2, b: 0 } });
  });

  it("a man reaching the far row is crowned", () => {
    const table = seated({ c7: "w", h8: "b" }, { turn: "w" });
    table.play(ANN, "sq", sq("c7"));
    table.play(ANN, "sq", sq("b8"));
    expect((table.state.board as Value[])[sq("b8")]).toBe("W");
    const black = seated({ f2: "b", a7: "w" }, { turn: "b" });
    black.play(BOB, "sq", sq("f2"));
    black.play(BOB, "sq", sq("g1"));
    expect((black.state.board as Value[])[sq("g1")]).toBe("B");
    expect(black.cells(64)[sq("g1")].text).toBe("🖤");
  });

  it("a king flies, captures from afar, and lands where it can capture again", () => {
    const quiet = seated({ a1: "W", h8: "b" });
    quiet.play(ANN, "sq", sq("a1"));
    expect(squares(quiet, "success")).toEqual(["g7", "f6", "e5", "d4", "c3", "b2"]);

    const free = seated({ a1: "W", d4: "b", h2: "b" });
    free.play(ANN, "sq", sq("a1"));
    expect(squares(free, "success")).toEqual(["h8", "g7", "f6", "e5"]);
    free.play(ANN, "sq", sq("g7"));
    expect(free.state.board).toEqual(position({ g7: "W", h2: "b" }));

    // From f6 it could take g5 next: only f6 is allowed.
    const bound = seated({ a1: "W", d4: "b", g5: "b", b8: "b" });
    bound.play(ANN, "sq", sq("a1"));
    expect(squares(bound, "success")).toEqual(["f6"]);
    bound.play(ANN, "sq", sq("f6"));
    expect(bound.state.chain).toBe(sq("f6"));
    expect(squares(bound, "success")).toEqual(["h4"]);
    bound.play(ANN, "sq", sq("h4"));
    expect(bound.state).toMatchObject({ turn: "b", taken: { w: 2, b: 0 } });
  });

  it("a king's capture of a king, and a piece is never taken twice", () => {
    const table = seated({ b8: "B", h2: "w", e5: "W" }, { turn: "b" });
    table.play(BOB, "sq", sq("b8"));
    // Over e5, landing f4, g3 — but h2 is white, so no further.
    expect(squares(table, "success")).toEqual(["f4", "g3"]);
    table.play(BOB, "sq", sq("g3"));
    // g3 then takes h2? No: the landing on h2's far side is off the board.
    expect(table.state).toMatchObject({ turn: "w", chain: null, taken: { w: 0, b: 1 } });

    // A captured piece blocks and cannot be jumped twice: the cycle stops.
    const fn = FUNCTIONS.draughts;
    const call = { budget: { steps: 1000 }, at: 0, random: Math.random, now: 0 };
    const board = position({ c3: "W", d4: "x", b4: "x", f6: "b" });
    expect(fn([board, "w", sq("c3")], call)).toEqual({});
  });

  it("wins when the other side has nothing left, or nothing to move", () => {
    const last = seated({ c3: "w", d4: "b" });
    last.play(ANN, "sq", sq("c3"));
    last.play(ANN, "sq", sq("e5"));
    expect(last.state).toMatchObject({ winner: "w", why: "moves", score: { "2": 1 } });
    expect(last.screen().plain).toContain("⚪ Ann wins! 🎉 (no moves left)");
    expect(last.press(BOB, "sq", sq("e5"))).toEqual({
      ok: false,
      text: "The game is over: 🔁 for a rematch",
    });

    // Black's only man is shut in at b8.
    const shut = seated({ b8: "b", a7: "w", c7: "w", d6: "w", h2: "w" });
    shut.play(ANN, "sq", sq("h2"));
    shut.play(ANN, "sq", sq("g3"));
    expect(shut.state).toMatchObject({ winner: "w", why: "moves" });
  });

  it("refuses the wrong player and what is not a square", () => {
    const table = new Table(checkers("en"), { seats: { w: ANN, b: BOB } });
    const before = structuredClone(table.state);
    expect(table.press(BOB, "sq", sq("c3"))).toEqual({ ok: false, text: "It is Ann's turn" });
    expect(table.press(CID, "sq", sq("c3"))).toEqual({ ok: false, text: "It is Ann's turn" });
    for (const arg of [64, -1, 2.5, "42", null, [42], { a: 1 }]) {
      expect(table.press(ANN, "sq", arg)).toEqual({ ok: false, text: "That is not on the board" });
    }
    expect(table.press(CID, "seat", "w")).toEqual({ ok: false, text: "That seat is Ann's" });
    expect(table.press(CID, "seat", "x")).toEqual({ ok: false, text: "That is not on the board" });
    for (const press of ["draw", "resign", "again"]) {
      expect(table.press(CID, press).ok).toBe(false);
    }
    expect(table.state).toEqual(before);
  });

  it("a draw by agreement, resigning in two taps, a rematch with colours swapped", () => {
    const table = new Table(checkers("en"), { seats: { w: ANN, b: BOB } });
    expect(table.press(ANN, "draw")).toEqual({
      ok: false,
      text: "Not yet: both players need a seat and a move",
    });
    table.play(ANN, "sq", sq("c3"));
    table.play(ANN, "sq", sq("d4"));
    expect(table.press(ANN, "draw")).toEqual({ ok: true, text: "Draw offered" });
    expect(table.screen().plain).toContain("🤝 Ann offers a draw");
    expect(table.controls(64)).toContain("🤝 Accept the draw [success]");
    expect(table.press(ANN, "draw")).toEqual({
      ok: false,
      text: "Offered: waiting for the answer",
    });
    // Bob moves instead: declined.
    table.play(BOB, "sq", sq("b6"));
    table.play(BOB, "sq", sq("a5"));
    expect(table.state.offer).toBeNull();
    table.play(ANN, "draw");
    table.play(BOB, "draw");
    expect(table.state).toMatchObject({ winner: "draw", why: "draw", games: 1 });
    expect(table.screen().plain).toContain("A draw by agreement 🤝");

    table.play(BOB, "again");
    expect(table.state).toMatchObject({
      seats: { w: BOB, b: ANN },
      turn: "w",
      winner: null,
      plies: 0,
      board: CHECKERS_START,
      taken: { w: 0, b: 0 },
    });
    table.play(BOB, "sq", sq("e3"));
    table.play(BOB, "sq", sq("f4"));
    expect(table.press(ANN, "resign")).toEqual({ ok: true, text: "Tap 🏳 again to resign" });
    expect(table.controls(64)).toContain("🏳 Resign [danger]");
    expect(table.state.winner).toBeNull();
    table.play(ANN, "resign");
    expect(table.state).toMatchObject({ winner: "w", why: "resign", score: { "3": 1 } });
    expect(table.screen().plain).toContain("⚪ Bob wins! 🎉 (resigned)");
    expect(table.press(CID, "end")).toEqual({ ok: false, text: "Only the players can" });
    table.play(OWNER, "end");
    expect(table.effects).toEqual([{ kind: "finish" }]);
  });

  it("one person in both seats plays both sides", () => {
    const table = new Table(checkers("en"));
    table.play(ANN, "seat", "w");
    table.play(ANN, "seat", "b");
    table.play(ANN, "sq", sq("c3"));
    table.play(ANN, "sq", sq("d4"));
    table.play(ANN, "sq", sq("f6"));
    table.play(ANN, "sq", sq("g5"));
    expect(table.state).toMatchObject({ plies: 2, turn: "w" });
  });

  it("random full games end within the limits, in both languages", () => {
    const random = seeded(2026);
    const call = { budget: { steps: 1e9 }, at: 0, random, now: 0 };
    const ends: Record<string, number> = {};
    for (let game = 0; game < 60; game++) {
      const table = new Table(checkers(game % 2 ? "ru" : "en"));
      table.play(ANN, "seat", "w");
      table.play(BOB, "seat", "b");
      for (let ply = 0; ply < 300 && table.state.winner === null; ply++) {
        const { board, turn, chain } = table.state;
        const moves = FUNCTIONS.draughts([board, turn, chain], call) as Record<
          string,
          Record<string, number | null>
        >;
        const froms = Object.keys(moves);
        const from = Number(froms[Math.floor(random() * froms.length)]);
        const tos = Object.keys(moves[from]);
        const to = Number(tos[Math.floor(random() * tos.length)]);
        const who = turn === "w" ? ANN : BOB;
        if (chain === null) table.play(who, "sq", from);
        table.play(who, "sq", to);
        expect(sizeOf(table.state, 8192)).toBeLessThan(2048);
      }
      const end = (table.state.winner as string | null) ?? "none";
      ends[end] = (ends[end] ?? 0) + 1;
    }
    expect((ends.w ?? 0) + (ends.b ?? 0)).toBeGreaterThan(40);
  });

  it("the costliest board found stays well inside the step budgets", () => {
    // Found by a hill-climbing search for the position draughts() takes longest on.
    const worst = position({
      b8: "W",
      d8: "W",
      f8: "W",
      h8: "W",
      a7: "W",
      g7: "B",
      b6: "B",
      d6: "b",
      h4: "W",
      e2: "B",
      d1: "W",
      f1: "W",
    });
    const budget = { steps: 2000 };
    FUNCTIONS.draughts([worst, "w", null], { budget, at: 0, random: Math.random, now: 0 });
    expect(2000 - budget.steps).toBeLessThan(500);

    // Played and drawn through the engine: a refusal for steps would throw.
    const table = seated(
      Object.fromEntries(
        worst.flatMap((cell, i) =>
          cell && cell !== "-" ? [[`${"abcdefgh"[i % 8]}${8 - Math.floor(i / 8)}`, cell]] : [],
        ),
      ),
    );
    const moves = FUNCTIONS.draughts([worst, "w", null], {
      budget: { steps: 1e9 },
      at: 0,
      random: Math.random,
      now: 0,
    }) as Record<string, Record<string, number | null>>;
    const from = Number(Object.keys(moves)[0]);
    table.play(ANN, "sq", from);
    table.play(ANN, "sq", Number(Object.keys(moves[from])[0]));
  });
});
