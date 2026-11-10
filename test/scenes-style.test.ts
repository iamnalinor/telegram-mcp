/**
 * A button's style as a template, and the per-row limit counted on what is
 * shown rather than on what is defined.
 */

import { describe, expect, it } from "bun:test";

import { compile, DefinitionError } from "../src/scenes/definition";
import type { Actor } from "../src/scenes/engine";
import type { Value } from "../src/scenes/lang";
import { render, RenderError } from "../src/scenes/render";

const OWNER: Actor = { id: 1, name: "Owner" };

function definitionError(input: unknown): DefinitionError {
  try {
    compile(input);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error("expected a DefinitionError");
}

function draw(input: unknown, state?: Record<string, Value>) {
  const { compiled, state: initial } = compile(input);
  return render(compiled, "main", state ?? initial, { owner: OWNER, now: 1 });
}

describe("style", () => {
  it("keeps a literal style", () => {
    const shown = draw({
      title: "t",
      view: { text: "x", buttons: [[{ text: "Go", press: "go", style: "success" }]] },
      rules: [],
    });
    expect(shown.rows[0][0].style).toBe("success");
  });

  it("refuses a literal that is not a style", () => {
    const error = definitionError({
      title: "t",
      view: { text: "x", buttons: [[{ text: "Go", press: "go", style: "green" }]] },
      rules: [],
    });
    expect(error.where).toBe("view.buttons[0][0].style");
    expect(error.message).toMatch(/primary, success, danger/);
  });

  it("colours each cell of a 7×5 grid from its value", () => {
    const cells = Array.from({ length: 35 }, (_, i) => ["", "r", "b"][i % 3]);
    const shown = draw({
      title: "grid",
      state: { cells },
      view: {
        text: "board",
        buttons: [
          {
            grid: "cells",
            width: 7,
            text: "{i}",
            press: "cell",
            style: "{it == 'r' ? 'danger' : it == 'b' ? 'primary' : ''}",
          },
        ],
      },
      rules: [{ on: "press:cell", do: ["cells[arg] = 'r'"] }],
    });
    expect(shown.rows).toHaveLength(5);
    expect(shown.rows.every((row) => row.length === 7)).toBe(true);
    const styles = shown.rows.flat().map((button) => button.style);
    expect(styles.slice(0, 4)).toEqual([undefined, "danger", "primary", undefined]);
    expect(shown.rows[0][0]).not.toHaveProperty("style");
  });

  it("reads state, lets, i and key in each rows and lists", () => {
    const shown = draw({
      title: "list",
      state: { picked: "b", items: { a: 1, b: 2 } },
      let: { hot: "2" },
      view: {
        text: "x",
        buttons: [
          {
            each: "items",
            row: [{ text: "{key}", press: "p", style: "{key == picked ? 'success' : ''}" }],
          },
          {
            each: "[1, 2, 3]",
            per_row: 3,
            text: "{it}",
            press: "q",
            style: "{it == hot ? 'danger' : i == 0 ? 'primary' : ''}",
          },
        ],
      },
      rules: [],
    });
    expect(shown.rows[0][0].style).toBeUndefined();
    expect(shown.rows[1][0].style).toBe("success");
    expect(shown.rows[2].map((button) => button.style)).toEqual(["primary", "danger", undefined]);
  });

  it("treats null as no style", () => {
    const shown = draw({
      title: "t",
      state: { s: null },
      view: { text: "x", buttons: [[{ text: "Go", press: "go", style: "{s}" }]] },
      rules: [],
    });
    expect(shown.rows[0][0]).not.toHaveProperty("style");
  });

  it("refuses a template that yields something else, with where", () => {
    const definition = {
      title: "t",
      state: { s: "danger" },
      view: { text: "x", buttons: [[{ text: "Go", press: "go", style: "{s}" }]] },
      rules: [{ on: "act:set", do: ["s = arg"] }],
    };
    const { compiled } = compile(definition);
    expect(() => render(compiled, "main", { s: "red" }, { owner: OWNER, now: 1 })).toThrow(
      RenderError,
    );
    const error = definitionError({ ...definition, state: { s: "red" } });
    expect(error.where).toBe("view.buttons[0][0].style");
    expect(error.message).toMatch(/primary, success, danger or empty/);
    expect(error.message).not.toContain("red");
  });

  it("rejects unknown names in a style template at creation", () => {
    const error = definitionError({
      title: "t",
      view: { text: "x", buttons: [[{ text: "Go", press: "go", style: "{nope}" }]] },
      rules: [],
    });
    expect(error.where).toBe("view.buttons[0][0].style");
  });
});

describe("buttons a row", () => {
  // Two variants a column: one shows, depending on the state.
  const variants = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { text: `${i}`, press: "p", arg: `${i}`, show: `on[${i}]` },
      { text: `${i}*`, press: "p", arg: `${i}`, style: "success", show: `!on[${i}]` },
    ]).flat();

  it("counts the buttons shown, not the ones defined", () => {
    const shown = draw({
      title: "t",
      state: { on: [true, false, true, false, true, false, true, false] },
      view: { text: "x", buttons: [variants(8)] },
      rules: [],
    });
    expect(shown.rows[0]).toHaveLength(8);
    expect(shown.rows[0][1]).toMatchObject({ text: "1*", style: "success" });
    expect(shown.places[0][1]).toBe("buttons[0][3]");
  });

  it("refuses a row that would show more than 8", () => {
    const error = definitionError({
      title: "t",
      view: { text: "x", buttons: [Array.from({ length: 9 }, () => ({ text: "b", press: "p" }))] },
      rules: [],
    });
    expect(error.message).toMatch(/shows at most 8 buttons; this one would show 9/);
    expect(error.where).toBe("view.buttons[0]");
  });

  it("refuses at render when the state would show more than 8", () => {
    const { compiled } = compile({
      title: "t",
      state: { n: 1 },
      view: {
        text: "x",
        buttons: [
          Array.from({ length: 10 }, (_, i) => ({ text: "b", press: "p", show: `n > ${i}` })),
        ],
      },
      rules: [],
    });
    expect(render(compiled, "main", { n: 8 }, { owner: OWNER, now: 1 }).rows[0]).toHaveLength(8);
    expect(() => render(compiled, "main", { n: 9 }, { owner: OWNER, now: 1 })).toThrow(
      /shows at most 8/,
    );
  });

  it("applies the same to each rows", () => {
    const shown = draw({
      title: "t",
      state: { items: [true, false] },
      view: {
        text: "x",
        buttons: [
          {
            each: "items",
            row: variants(5).map((b) => ({ ...b, show: b.show.replace(/on\[\d\]/, "it") })),
          },
        ],
      },
      rules: [],
    });
    expect(shown.rows.map((row) => row.length)).toEqual([5, 5]);
  });

  it("still caps what a row may define", () => {
    const error = definitionError({
      title: "t",
      view: {
        text: "x",
        buttons: [Array.from({ length: 101 }, () => ({ text: "b", press: "p", show: "false" }))],
      },
      rules: [],
    });
    expect(error.message).toMatch(/defines at most 100/);
  });
});
