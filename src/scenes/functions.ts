/**
 * The built-in functions of the scenes' language. Each is pure — nothing
 * outside its arguments, the event's time and a source of randomness — and
 * charges the budget for the elements it walks. each() lives in lang.ts: it
 * evaluates a template.
 */

import {
  charge,
  checkSize,
  contains,
  equal,
  index,
  isMap,
  keyOf,
  LangError,
  num,
  text,
  type Budget,
  type Value,
} from "./lang";

interface Call {
  budget: Budget;
  at: number;
  random: () => number;
  now: number;
}

type Fn = (args: Value[], call: Call) => Value;

/** The elements of a list, or the values of a map; anything else has none. */
function items(value: Value): Value[] {
  if (Array.isArray(value)) return value;
  if (isMap(value)) return Object.values(value);
  return [];
}

/** A map built without setters: any key, "__proto__" too, is an ordinary key. */
function mapOf(entries: [string, Value][]): { [key: string]: Value } {
  return Object.fromEntries<Value>(entries);
}

function walk(call: Call, count: number): void {
  charge(call.budget, count, call.at);
}

function integer(value: Value, what: string, call: Call): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LangError(`${what} must be a whole number`, call.at);
  }
  return value;
}

function numbers(args: Value[], call: Call): number[] {
  const list = args.length === 1 ? items(args[0]) : args;
  walk(call, list.length);
  return list.filter((value): value is number => typeof value === "number");
}

function randomIndex(n: number, call: Call): number {
  return Math.min(n - 1, Math.floor(call.random() * n));
}

function shuffled(list: Value[], call: Call): Value[] {
  walk(call, list.length);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, call);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Numeric values of a map, as [key, value] pairs, in the map's order. */
function scored(value: Value, call: Call): [string, number][] {
  if (!isMap(value)) return [];
  const entries = Object.entries(value);
  walk(call, entries.length);
  return entries.filter((entry): entry is [string, number] => typeof entry[1] === "number");
}

const BAR_WIDTH = 10;

/** How many arguments each function takes: [least, most]. */
export const ARITY: Record<string, [number, number]> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, [number, number]>, {
    len: [1, 1],
    keys: [1, 1],
    values: [1, 1],
    has: [2, 2],
    count: [2, 3],
    sum: [1, Infinity],
    min: [1, Infinity],
    max: [1, Infinity],
    slice: [2, 3],
    without: [2, 2],
    tally: [1, 1],
    leader: [1, 1],
    top: [1, 2],
    full: [1, 1],
    line: [3, 3],
    drop: [3, 3],
    random: [1, 1],
    pick: [1, 1],
    shuffle: [1, 1],
    deal: [2, 3],
    str: [1, 1],
    join: [1, 2],
    bar: [2, 3],
    ago: [1, 1],
  }),
);

const BUILT_INS: Record<string, Fn> = {
  len: ([value]) =>
    Array.isArray(value)
      ? value.length
      : isMap(value)
        ? Object.keys(value).length
        : typeof value === "string"
          ? Array.from(value).length
          : 0,
  keys: ([value], call) => {
    if (!isMap(value)) return [];
    walk(call, Object.keys(value).length);
    return Object.keys(value);
  },
  values: ([value], call) => {
    walk(call, items(value).length);
    return isMap(value) ? Object.values(value) : [];
  },
  has: ([collection, item], call) => {
    walk(call, items(collection).length);
    return contains(collection, item, call.budget, call.at);
  },
  count: ([list, wanted, field], call) => {
    const all = items(list);
    walk(call, all.length);
    return all.filter((item) =>
      equal(field === undefined ? item : index(item, field), wanted, call.budget, call.at),
    ).length;
  },
  sum: (args, call) => num(numbers(args, call).reduce((total, n) => total + n, 0)),
  min: (args, call) => {
    const list = numbers(args, call);
    return list.length ? Math.min(...list) : null;
  },
  max: (args, call) => {
    const list = numbers(args, call);
    return list.length ? Math.max(...list) : null;
  },
  slice: ([value, start, end], call) => {
    const from = start === undefined || start === null ? 0 : integer(start, "slice's start", call);
    const to = end === undefined || end === null ? undefined : integer(end, "slice's end", call);
    if (typeof value === "string") return Array.from(value).slice(from, to).join("");
    if (!Array.isArray(value)) return [];
    walk(call, value.length);
    return value.slice(from, to);
  },
  without: ([collection, item], call) => {
    walk(call, items(collection).length);
    if (Array.isArray(collection)) {
      return collection.filter((element) => !equal(element, item, call.budget, call.at));
    }
    if (isMap(collection)) {
      const key = keyOf(item);
      return mapOf(Object.entries(collection).filter(([name]) => name !== key));
    }
    return collection;
  },
  tally: ([value], call) => {
    const counts = new Map<string, number>();
    const all = items(value);
    walk(call, all.length);
    for (const item of all) {
      if (item === null) continue;
      const key = keyOf(item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return mapOf([...counts]);
  },
  leader: ([value], call) => {
    let best: [string, number] | null = null;
    let tie = false;
    for (const entry of scored(value, call)) {
      if (!best || entry[1] > best[1]) {
        best = entry;
        tie = false;
      } else if (entry[1] === best[1]) {
        tie = true;
      }
    }
    return best && !tie ? best[0] : null;
  },
  top: ([value, n], call) => {
    const limit = n === undefined ? 3 : integer(n, "top's count", call);
    return scored(value, call)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit))
      .map(([key, score]) => ({ key, value: score }));
  },
  full: ([cells], call) => {
    const all = items(cells);
    walk(call, all.length);
    return all.every((cell) => cell !== null && cell !== "");
  },
  line: ([cells, width, k], call) => {
    const all = Array.isArray(cells) ? cells : [];
    const w = integer(width, "line's width", call);
    const need = integer(k, "line's length", call);
    if (w < 1 || need < 1) return "";
    const h = Math.ceil(all.length / w);
    const at = (r: number, c: number) =>
      r >= 0 && r < h && c >= 0 && c < w ? (all[r * w + c] ?? null) : null;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const mark = at(r, c);
        if (mark === null || mark === "") continue;
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
          [1, 1],
          [1, -1],
        ]) {
          walk(call, 1);
          let run = 1;
          while (run < need && equal(at(r + dr * run, c + dc * run), mark)) run++;
          if (run >= need) return mark;
        }
      }
    }
    return "";
  },
  drop: ([cells, width, column], call) => {
    const all = Array.isArray(cells) ? cells : [];
    const w = integer(width, "drop's width", call);
    const col = integer(column, "drop's column", call);
    if (w < 1 || col < 0 || col >= w) return null;
    walk(call, all.length / w);
    for (let cell = Math.floor((all.length - 1 - col) / w) * w + col; cell >= 0; cell -= w) {
      if (all[cell] === null || all[cell] === "") return cell;
    }
    return null;
  },
  random: ([n], call) => {
    const bound = integer(n, "random's bound", call);
    return bound > 0 ? randomIndex(bound, call) : null;
  },
  pick: ([list], call) => {
    const all = items(list);
    return all.length ? all[randomIndex(all.length, call)] : null;
  },
  shuffle: ([list], call) => shuffled(items(list), call),
  deal: ([roles, ids, rest], call) => {
    const people = shuffled(items(ids), call);
    const parts = items(roles);
    walk(call, parts.length);
    return mapOf(people.map((id, i) => [keyOf(id), i < parts.length ? parts[i] : (rest ?? null)]));
  },
  str: ([value], call) => text(value ?? null, call.budget, call.at),
  join: ([list, separator], call) => {
    const all = items(list);
    walk(call, all.length);
    const between = separator === undefined ? ", " : text(separator, call.budget, call.at);
    let out = "";
    // Checked as it grows: a long list of long texts is refused before it is built.
    for (const [i, item] of all.entries()) {
      const next = out + (i ? between : "") + text(item, call.budget, call.at);
      checkSize(next, call.at);
      out = next;
    }
    return out;
  },
  bar: ([n, max, width], call) => {
    const cells =
      width === undefined
        ? BAR_WIDTH
        : Math.min(40, Math.max(0, integer(width, "bar's width", call)));
    const total = typeof max === "number" && max > 0 ? max : 0;
    const part = typeof n === "number" && total ? Math.min(1, Math.max(0, n / total)) : 0;
    const filled = Math.round(part * cells);
    return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
  },
  ago: ([time], call) => {
    if (typeof time !== "number") return "";
    const seconds = Math.max(0, call.now - time);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86_400)} d ago`;
  },
};

/** Looked up by name from definitions: no prototype, nothing to add or change. */
export const FUNCTIONS: Readonly<Record<string, Fn>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Fn>, BUILT_INS),
);
