/** Scene definitions the tests share: the two from the spec. */

export const TICTACTOE = {
  title: "Крестики-нолики",
  brief: "Игра на двоих, меня не будит. Итог в state.won.",
  state: { cells: ["", "", "", "", "", "", "", "", ""], x: null, o: null, turn: "x", won: null },
  let: {
    seat: "turn == 'x' ? x : o",
    over: "won != null || full(cells)",
  },
  view: {
    text: "**Крестики-нолики**\n❌ {x ? x.name : 'свободно'}\n⭕ {o ? o.name : 'свободно'}\n\n{won ? 'Победил ' + won.name : over ? 'Ничья' : 'Ход: ' + (turn == 'x' ? '❌' : '⭕')}",
    buttons: [
      {
        grid: "cells",
        width: 3,
        press: "cell",
        text: "{it == 'x' ? '❌' : it == 'o' ? '⭕' : '·'}",
      },
    ],
  },
  rules: [
    { on: "press:cell", when: "over", say: "Игра окончена" },
    { on: "press:cell", when: "cells[arg] != ''", say: "Занято" },
    {
      on: "press:cell",
      when: "seat != null && seat.id != user.id",
      say: "Сейчас ходит {seat.name}",
    },
    {
      on: "press:cell",
      do: [
        "x = turn == 'x' ? user : x",
        "o = turn == 'o' ? user : o",
        "cells[arg] = turn",
        "won = line(cells, 3, 3) != '' ? user : null",
        "turn = turn == 'x' ? 'o' : 'x'",
        { if: "over", do: ["finish()"] },
      ],
    },
  ],
};

export const TRIAGE = {
  title: "Находки ревью",
  brief:
    "Я нашёл 3 проблемы в PR. Когда придёт done — чинить те, где d == 'fix', остальные перечислить в ответе.",
  state: {
    items: [
      { t: "SQL без индекса", d: null },
      { t: "Нет теста на 429", d: null },
      { t: "Опечатка в README", d: null },
    ],
  },
  view: {
    text: "**Что делаем с находками?**\n{each(items, '{i + 1}. {it.t} — {it.d ?? \"…\"}\\n')}",
    buttons: [
      {
        each: "items",
        row: [
          { text: "🔧 {i + 1}", press: "mark", arg: "[i, 'fix']" },
          { text: "⏭", press: "mark", arg: "[i, 'skip']" },
          { text: "🕓", press: "mark", arg: "[i, 'later']" },
        ],
      },
      [{ text: "Готово", press: "done", style: "success" }],
    ],
  },
  rules: [
    { on: "press:mark", who: "owner", do: ["items[arg[0]].d = arg[1]"] },
    {
      on: "press:done",
      who: "owner",
      when: "count(items, null, 'd') > 0",
      say: "Остались неразобранные",
    },
    { on: "press:done", who: "owner", do: ["wake('done')", "finish()"] },
  ],
};
