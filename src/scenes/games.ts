/**
 * Ready-made games: scenes shipped in code. The bot's 🎬 Scenes offers them
 * to anyone, started like a saved scene (in the private chat, as the user's
 * own), and scene_guide hands the English ones out as presets. They need no
 * assistant: nothing in them wakes one.
 *
 * Definitions are built here rather than written out, so a game's repetitive
 * parts (eight lines to check, a square's name) stay one function, and each
 * language gets the same rules.
 */

type Lang = "en" | "ru";

/** A text as a quoted string inside an expression. */
const q = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** The bot's seat in tic-tac-toe: no Telegram user has id 0. */
const BOT_ID = 0;

const TTT_TEXT = {
  en: {
    title: "Tic-tac-toe",
    brief:
      "A game for two, or against the bot (🤖); it never wakes me. Seats and the score are in state.seats and state.score (id → wins).",
    free: "free",
    take: "take a seat",
    bot: "🤖 Bot",
    playBot: "🤖 Play the bot",
    rematch: "🔁 Rematch",
    end: "■ End",
    score: "Score",
    draws: "draws",
    draw: "A draw 🤝",
    wins: (name: string) => `${name} + ' wins! 🎉'`,
    turn: (name: string) => `${name} + ' to move'`,
    tapToPlay: "tap a cell to play",
    bad: "That is not on the board",
    over: "The game is over: 🔁 for a rematch",
    taken: "Taken",
    notYourTurn: "It is {seats[turn].name}'s turn",
    bothSides: "Waiting for a second player. Take the other seat yourself to play both sides.",
    seatTaken: "That seat is {seats[arg].name}'s",
    playing: "You are playing: seats change at a rematch",
    botSeat: "The other seat is taken",
    notPlayer: "Only the players can",
    notOver: "The game is still on",
  },
  ru: {
    title: "Крестики-нолики",
    brief:
      "Игра на двоих или против бота (🤖); меня не будит. Места и счёт — в state.seats и state.score (id → победы).",
    free: "свободно",
    take: "занять место",
    bot: "🤖 Бот",
    playBot: "🤖 Играть с ботом",
    rematch: "🔁 Реванш",
    end: "■ Закончить",
    score: "Счёт",
    draws: "ничьих",
    draw: "Ничья 🤝",
    wins: (name: string) => `'Победа: ' + ${name} + ' 🎉'`,
    turn: (name: string) => `'Ходит ' + ${name}`,
    tapToPlay: "нажми на клетку, чтобы играть",
    bad: "Такой клетки нет",
    over: "Игра окончена: 🔁 — реванш",
    taken: "Занято",
    notYourTurn: "Сейчас ходит {seats[turn].name}",
    bothSides: "Ждём второго игрока. Займи второе место сам, чтобы играть за обоих.",
    seatTaken: "Это место занял {seats[arg].name}",
    playing: "Ты уже играешь: места меняются на реванше",
    botSeat: "Второе место занято",
    notPlayer: "Это только для игроков",
    notOver: "Игра ещё идёт",
  },
};

/**
 * Tic-tac-toe: seats, whose turn in colour, the winning line in green, the
 * last move in blue, a score over rematches, and a bot that wins when it can,
 * blocks when it must, and otherwise takes the centre, a corner or any cell.
 */
export function ticTacToe(lang: Lang = "en") {
  const t = TTT_TEXT[lang];
  const mark = (side: string) => `(${side} == 'x' ? '❌' : '⭕')`;
  const cellsOf = (line: number[]) => `[${line.map((c) => `cells[${c}]`).join(", ")}]`;
  /** After a mark at `turn`: a line won, a full board, or the other side's turn. */
  const settle = [
    ...LINES.map((line) => ({
      if: line.map((c) => `cells[${c}] == turn`).join(" && "),
      do: [`win = [${line.join(", ")}]`],
    })),
    {
      if: "len(win) > 0",
      do: [
        "winner = turn",
        "score[seats[turn].id] = (score[seats[turn].id] ?? 0) + 1",
        "games += 1",
      ],
    },
    { if: "winner == null && full(cells)", do: ["winner = 'draw'", "draws += 1", "games += 1"] },
    { if: "winner == null", do: ["turn = foe"] },
  ];
  /** Two of `side` and a free cell in a line: that cell. */
  const complete = (side: string) =>
    LINES.map((line) => ({
      if: `mv == null && count(${cellsOf(line)}, ${side}) == 2 && count(${cellsOf(line)}, '') == 1`,
      do: [
        `mv = cells[${line[0]}] == '' ? ${line[0]} : cells[${line[1]}] == '' ? ${line[1]} : ${line[2]}`,
      ],
    }));
  const freeOf = (cells: number[]) =>
    `without([${cells.map((c) => `cells[${c}] == '' ? ${c} : -1`).join(", ")}], -1)`;
  const botMove = [
    "mv = null",
    ...complete("turn"),
    ...complete("foe"),
    { if: "mv == null && cells[4] == ''", do: ["mv = 4"] },
    {
      if: `mv == null`,
      do: [`mv = pick(${freeOf([0, 2, 6, 8])}) ?? pick(${freeOf([1, 3, 5, 7])})`],
    },
    "cells[mv] = turn",
    "last = mv",
    ...settle,
  ];
  const seatButton = (side: "x" | "o") => ({
    text: `${side === "x" ? "❌" : "⭕"} {seats.${side} ? seats.${side}.name : ${q(t.take)}}`,
    press: "seat",
    arg: `'${side}'`,
    style: `{over ? (winner == '${side}' ? 'success' : '') : turn == '${side}' ? 'primary' : ''}`,
  });
  const seated =
    "(seats.x != null && seats.x.id == user.id || seats.o != null && seats.o.id == user.id)";
  return {
    title: t.title,
    brief: t.brief,
    state: {
      cells: ["", "", "", "", "", "", "", "", ""],
      seats: { x: null, o: null },
      turn: "x",
      last: null,
      win: [],
      winner: null,
      score: {},
      games: 0,
      draws: 0,
      mv: null,
    },
    let: {
      foe: "turn == 'x' ? 'o' : 'x'",
      over: "winner != null",
      started: "count(cells, '') < 9",
    },
    view: {
      text:
        `**${t.title}**\n` +
        `❌ {seats.x ? seats.x.name : ${q(t.free)}}\n` +
        `⭕ {seats.o ? seats.o.name : ${q(t.free)}}\n\n` +
        `{over ? (winner == 'draw' ? ${q(t.draw)} : ${mark("winner")} + ' ' + ${t.wins("seats[winner].name")}) : ` +
        `${mark("turn")} + ' ' + (seats[turn] ? ${t.turn("seats[turn].name")} : ${q(t.tapToPlay)})}` +
        `{games ? '\\n${t.score}: ' + seats.x.name + ' ' + (score[seats.x.id] ?? 0) + ' : ' + (score[seats.o.id] ?? 0) + ' ' + seats.o.name + (draws ? ', ${t.draws}: ' + draws : '') : ''}`,
      buttons: [
        {
          grid: "cells",
          width: 3,
          press: "cell",
          text: "{it == 'x' ? '❌' : it == 'o' ? '⭕' : '·'}",
          style: "{i in win ? 'success' : i == last ? 'primary' : ''}",
        },
        [seatButton("x"), seatButton("o")],
        [
          { text: t.playBot, press: "bot", show: "seats.o == null && !started && !over" },
          { text: t.rematch, press: "again", show: "over", style: "primary" },
          { text: t.end, press: "end", show: "over" },
        ],
      ],
    },
    rules: [
      { on: "press:seat", when: "arg != 'x' && arg != 'o'", say: t.bad },
      {
        on: "press:seat",
        when: "seats[arg] != null && seats[arg].id != user.id",
        say: t.seatTaken,
      },
      { on: "press:seat", when: "seats[arg] != null && (started || over)", say: t.playing },
      { on: "press:seat", when: "seats[arg] != null", do: ["seats[arg] = null"] },
      { on: "press:seat", do: ["seats[arg] = user"] },
      { on: "press:bot", when: "started || over", say: t.playing },
      { on: "press:bot", when: "seats.o != null", say: t.botSeat },
      {
        on: "press:bot",
        when: "seats.x != null && seats.x.id != user.id",
        say: t.notPlayer,
      },
      { on: "press:bot", do: [`seats.o = {id: ${BOT_ID}, name: ${q(t.bot)}}`, "seats.x = user"] },
      { on: "press:cell", when: "!(arg >= 0 && arg <= 8) || arg % 1 != 0", say: t.bad },
      { on: "press:cell", when: "over", say: t.over },
      {
        on: "press:cell",
        when: "seats[turn] != null && seats[turn].id != user.id",
        say: t.notYourTurn,
      },
      {
        on: "press:cell",
        when: "seats[turn] == null && seats[foe] != null && seats[foe].id == user.id",
        say: t.bothSides,
      },
      { on: "press:cell", when: "cells[arg] != ''", say: t.taken },
      {
        on: "press:cell",
        do: [
          "seats[turn] = seats[turn] ?? user",
          "cells[arg] = turn",
          "last = arg",
          ...settle,
          { if: `!over && seats[turn] != null && seats[turn].id == ${BOT_ID}`, do: botMove },
        ],
      },
      { on: "press:again", when: "!over", say: t.notOver },
      { on: "press:again", when: `!${seated}`, say: t.notPlayer },
      {
        on: "press:again",
        do: [
          "cells = ['', '', '', '', '', '', '', '', '']",
          "win = []",
          "last = null",
          "winner = null",
          // The other side opens the next game.
          "seats = {x: seats.o, o: seats.x}",
          "turn = 'x'",
          {
            if: `seats.x.id == ${BOT_ID}`,
            do: ["mv = pick([0, 2, 4, 6, 8])", "cells[mv] = 'x'", "last = mv", "turn = 'o'"],
          },
        ],
      },
      { on: "press:end", when: `!${seated} && user.id != owner.id`, say: t.notPlayer },
      { on: "press:end", do: ["finish()"] },
    ],
  };
}

const CHECKERS_TEXT = {
  en: {
    title: "Checkers",
    brief:
      "Russian draughts for two; it never wakes me. The board is state.board (64 cells, black at the top), the score state.score (id → wins).",
    free: "free",
    take: "take a seat",
    move: "move",
    left: "on the board",
    took: "took",
    wins: "wins",
    draw: "A draw by agreement 🤝",
    won: (name: string) => `${name} + ' wins! 🎉'`,
    resigned: " (resigned)",
    blocked: " (no moves left)",
    turn: (name: string) => `${name} + ' to move'`,
    tapToPlay: "tap a piece to play",
    mustCapture: "capturing is mandatory ⚔",
    keepCapturing: "keeps capturing",
    offers: "offers a draw",
    last: "Last",
    offerDraw: "🤝 Draw?",
    acceptDraw: "🤝 Accept the draw",
    resign: "🏳 Resign",
    rematch: "🔁 Rematch",
    end: "■ End",
    bad: "That is not on the board",
    over: "The game is over: 🔁 for a rematch",
    notYourTurn: "It is {seats[turn].name}'s turn",
    bothSides: "Waiting for a second player. Take the other seat yourself to play both sides.",
    seatTaken: "That seat is {seats[arg].name}'s",
    playing: "You are playing: seats change at a rematch",
    keepOn: "Keep capturing with the same piece",
    mustCaptureSay: "You must capture: the pieces in red can",
    cannotMove: "That piece cannot move",
    pick: "Tap one of your pieces first",
    illegal: "That move is not allowed",
    notPlayer: "Only the players can",
    notYet: "Not yet: both players need a seat and a move",
    offered: "Offered: waiting for the answer",
    offerSent: "Draw offered",
    tapAgain: "Tap 🏳 again to resign",
    notOver: "The game is still on",
  },
  ru: {
    title: "Шашки",
    brief:
      "Русские шашки на двоих; меня не будят. Доска — state.board (64 клетки, чёрные сверху), счёт — state.score (id → победы).",
    free: "свободно",
    take: "занять место",
    move: "ход",
    left: "на доске",
    took: "взято",
    wins: "побед",
    draw: "Ничья по согласию 🤝",
    won: (name: string) => `'Победа: ' + ${name} + ' 🎉'`,
    resigned: " (соперник сдался)",
    blocked: " (у соперника нет ходов)",
    turn: (name: string) => `'Ходит ' + ${name}`,
    tapToPlay: "нажми на шашку, чтобы играть",
    mustCapture: "бить обязательно ⚔",
    keepCapturing: "бьёт дальше",
    offers: "предлагает ничью",
    last: "Последний ход",
    offerDraw: "🤝 Ничья?",
    acceptDraw: "🤝 Согласиться на ничью",
    resign: "🏳 Сдаться",
    rematch: "🔁 Реванш",
    end: "■ Закончить",
    bad: "Такой клетки нет",
    over: "Игра окончена: 🔁 — реванш",
    notYourTurn: "Сейчас ходит {seats[turn].name}",
    bothSides: "Ждём второго игрока. Займи второе место сам, чтобы играть за обоих.",
    seatTaken: "Это место занял {seats[arg].name}",
    playing: "Ты уже играешь: места меняются на реванше",
    keepOn: "Бей дальше той же шашкой",
    mustCaptureSay: "Бить обязательно: могут красные",
    cannotMove: "Этой шашке некуда ходить",
    pick: "Сначала выбери свою шашку",
    illegal: "Так ходить нельзя",
    notPlayer: "Это только для игроков",
    notYet: "Пока рано: нужны оба игрока и хотя бы один ход",
    offered: "Предложено: ждём ответа",
    offerSent: "Ничья предложена",
    tapAgain: "Нажми 🏳 ещё раз, чтобы сдаться",
    notOver: "Игра ещё идёт",
  },
};

/** The opening position: black men on the top three rows' dark squares, white on the bottom three. */
export const CHECKERS_START = Array.from({ length: 64 }, (_, square) => {
  const row = Math.floor(square / 8);
  // Light squares hold "-": never a piece, so the board draws itself without arithmetic.
  if ((row + (square % 8)) % 2 === 0) return "-";
  return row < 3 ? "b" : row > 4 ? "w" : "";
});

/**
 * Russian draughts. draughts() (src/scenes/functions.ts) knows the moves;
 * the rules here play them a step at a time: a tap selects a piece (blue),
 * its squares show in green, the pieces that must capture in red, and a
 * capture that can go on keeps the same piece selected until the chain ends.
 * Captured pieces stay on the board (✖) until then and cannot be jumped
 * twice; a man that reaches the far row mid-chain goes on as a king.
 */
export function checkers(lang: Lang = "en") {
  const t = CHECKERS_TEXT[lang];
  /** A square's name, a1 at the bottom left. */
  const sq = (e: string) =>
    `slice('abcdefgh', ${e} % 8, ${e} % 8 + 1) + (8 - (${e} - ${e} % 8) / 8)`;
  const mark = (side: string) => `(${side} == 'w' ? '⚪' : '⚫')`;
  const win = (side: string, why: string) => [
    `winner = ${side}`,
    `why = '${why}'`,
    `score[seats[${side}].id] = (score[seats[${side}].id] ?? 0) + 1`,
    "games += 1",
  ];
  const seatButton = (side: "w" | "b") => ({
    text: `${side === "w" ? "⚪" : "⚫"} {seats.${side} ? seats.${side}.name : ${q(t.take)}}`,
    press: "seat",
    arg: `'${side}'`,
    style: `{over ? (winner == '${side}' ? 'success' : '') : turn == '${side}' ? 'primary' : ''}`,
  });
  const line = (side: "w" | "b") =>
    `${side === "w" ? "⚪" : "⚫"} {seats.${side} ? seats.${side}.name : ${q(t.free)}} — ` +
    `{count(board, '${side}') + count(board, '${side.toUpperCase()}')} ${t.left}, ${t.took} {taken.${side}}` +
    `{games ? ', ${t.wins}: ' + (score[seats.${side}.id] ?? 0) : ''}`;
  return {
    title: t.title,
    brief: t.brief,
    state: {
      board: CHECKERS_START,
      seats: { w: null, b: null },
      turn: "w",
      sel: null,
      chain: null,
      winner: null,
      why: null,
      taken: { w: 0, b: 0 },
      path: "",
      last: "",
      offer: null,
      quit: null,
      plies: 0,
      score: {},
      games: 0,
      tk: null,
      pc: "",
    },
    let: {
      foe: "turn == 'w' ? 'b' : 'w'",
      over: "winner != null",
      moves: "winner != null ? {} : draughts(board, turn, chain)",
      dests: "sel == null ? {} : moves[sel] ?? {}",
      must: "len(moves) > 0 && values(values(moves)[0])[0] != null",
      mine: "turn == 'w' ? ['w', 'W'] : ['b', 'B']",
      glyph: "{w: '⚪', b: '⚫', W: '🤍', B: '🖤', x: '✖', '-': '⠀'}",
      hot: "sel == null && must ? moves : {}",
      // Who the presser plays for: the side to move first, for one person in both seats.
      me: "seats[turn] != null && seats[turn].id == user.id ? turn : seats[foe] != null && seats[foe].id == user.id ? foe : null",
    },
    view: {
      text:
        `**${t.title}** · ${t.move} {(plies - plies % 2) / 2 + 1}\n` +
        `${line("w")}\n${line("b")}\n\n` +
        `{over ? (winner == 'draw' ? ${q(t.draw)} : ${mark("winner")} + ' ' + ${t.won("seats[winner].name")} + (why == 'resign' ? ${q(t.resigned)} : ${q(t.blocked)})) : ` +
        `chain != null ? ${mark("turn")} + ' ' + seats[turn].name + ' ' + ${q(t.keepCapturing)} + ' ' + ${sq("chain")} : ` +
        `${mark("turn")} + ' ' + (seats[turn] ? ${t.turn("seats[turn].name")} : ${q(t.tapToPlay)}) + (must ? ' — ' + ${q(t.mustCapture)} : '')}` +
        `{offer != null && !over ? '\\n🤝 ' + seats[offer].name + ' ' + ${q(t.offers)} : ''}` +
        `{last ? '\\n${t.last}: ' + last : ''}`,
      buttons: [
        {
          grid: "board",
          width: 8,
          press: "sq",
          text: "{i in dests ? '•' : glyph[it] ?? '·'}",
          style: "{i == sel ? 'primary' : i in dests ? 'success' : i in hot ? 'danger' : ''}",
        },
        [seatButton("w"), seatButton("b")],
        [
          {
            text: t.offerDraw,
            press: "draw",
            show: "!over && plies > 0 && offer == null && seats.b != null",
          },
          {
            text: t.acceptDraw,
            press: "draw",
            show: "!over && offer != null",
            style: "success",
          },
          {
            text: t.resign,
            press: "resign",
            show: "!over && plies > 0 && seats.b != null",
            style: "{quit ? 'danger' : ''}",
          },
          { text: t.rematch, press: "again", show: "over", style: "primary" },
          { text: t.end, press: "end", show: "over" },
        ],
      ],
    },
    rules: [
      { on: "press:seat", when: "arg != 'w' && arg != 'b'", say: t.bad },
      {
        on: "press:seat",
        when: "seats[arg] != null && seats[arg].id != user.id",
        say: t.seatTaken,
      },
      {
        on: "press:seat",
        when: "seats[arg] != null && (plies > 0 || chain != null || over)",
        say: t.playing,
      },
      { on: "press:seat", when: "seats[arg] != null", do: ["seats[arg] = null"] },
      { on: "press:seat", do: ["seats[arg] = user"] },

      { on: "press:sq", when: "!(arg >= 0 && arg <= 63) || arg % 1 != 0", say: t.bad },
      { on: "press:sq", when: "over", say: t.over },
      {
        on: "press:sq",
        when: "seats[turn] != null && seats[turn].id != user.id",
        say: t.notYourTurn,
      },
      {
        on: "press:sq",
        when: "seats[turn] == null && seats[foe] != null && seats[foe].id == user.id",
        say: t.bothSides,
      },
      { on: "press:sq", when: "chain != null && !(arg in dests)", say: t.keepOn },
      { on: "press:sq", when: "arg == sel", do: ["sel = null"] },
      {
        on: "press:sq",
        when: "board[arg] in mine && arg in moves",
        do: ["seats[turn] = seats[turn] ?? user", "sel = arg"],
      },
      {
        on: "press:sq",
        when: "board[arg] in mine",
        say: `{must ? ${q(t.mustCaptureSay)} : ${q(t.cannotMove)}}`,
      },
      {
        on: "press:sq",
        when: "sel != null && arg in dests",
        do: [
          "quit = null",
          "tk = dests[arg]",
          "pc = board[sel]",
          `path = (path == '' ? ${sq("sel")} : path) + (tk == null ? '-' : ':') + ${sq("arg")}`,
          "board[sel] = ''",
          // A man on the far row is crowned at once, even in the middle of a capture.
          "board[arg] = pc == 'w' && arg < 8 ? 'W' : pc == 'b' && arg >= 56 ? 'B' : pc",
          "sel = null",
          { if: "tk != null", do: ["board[tk] = 'x'", "taken[turn] += 1"] },
          {
            if: "tk != null && len(draughts(board, turn, arg)) > 0",
            do: ["chain = arg", "sel = arg"],
            else: [
              "board = replace(board, 'x', '')",
              "chain = null",
              `last = ${mark("turn")} + ' ' + path`,
              "path = ''",
              // Moving instead of answering declines the other side's offer.
              { if: "offer != turn", do: ["offer = null"] },
              "plies += 1",
              "turn = foe",
              // Nothing to move with, or nothing left: the side that just moved wins.
              { if: "len(moves) == 0", do: win("foe", "moves") },
            ],
          },
        ],
      },
      { on: "press:sq", when: "sel == null", say: t.pick },
      {
        on: "press:sq",
        say: `{must ? ${q(t.mustCaptureSay)} : ${q(t.illegal)}}`,
      },

      { on: "press:draw", when: "over", say: t.over },
      { on: "press:draw", when: "me == null", say: t.notPlayer },
      { on: "press:draw", when: "plies == 0 || seats.w == null || seats.b == null", say: t.notYet },
      {
        on: "press:draw",
        when: "offer != null && offer != me",
        do: ["winner = 'draw'", "why = 'draw'", "games += 1", "offer = null"],
      },
      { on: "press:draw", when: "offer == me", say: t.offered },
      { on: "press:draw", do: ["offer = me", `toast(${q(t.offerSent)})`] },

      { on: "press:resign", when: "over", say: t.over },
      { on: "press:resign", when: "me == null", say: t.notPlayer },
      {
        on: "press:resign",
        when: "plies == 0 || seats.w == null || seats.b == null",
        say: t.notYet,
      },
      { on: "press:resign", when: "quit != me", do: ["quit = me", `toast(${q(t.tapAgain)})`] },
      {
        on: "press:resign",
        do: [
          "quit = null",
          "sel = null",
          "chain = null",
          "board = replace(board, 'x', '')",
          ...win("me == 'w' ? 'b' : 'w'", "resign"),
        ],
      },

      { on: "press:again", when: "!over", say: t.notOver },
      { on: "press:again", when: "me == null", say: t.notPlayer },
      {
        on: "press:again",
        do: [
          `board = ${JSON.stringify(CHECKERS_START).replaceAll('"', "'")}`,
          // The other side has white, and so the first move, next time.
          "seats = {w: seats.b, b: seats.w}",
          "turn = 'w'",
          "sel = null",
          "chain = null",
          "winner = null",
          "why = null",
          "taken = {w: 0, b: 0}",
          "path = ''",
          "last = ''",
          "offer = null",
          "quit = null",
          "plies = 0",
        ],
      },
      { on: "press:end", when: "me == null && user.id != owner.id", say: t.notPlayer },
      { on: "press:end", do: ["finish()"] },
    ],
  };
}

/** The games 🎬 Scenes offers, by the key its buttons carry. */
export const GAMES = { ttt: ticTacToe, chk: checkers } as const;
export type GameKey = keyof typeof GAMES;
