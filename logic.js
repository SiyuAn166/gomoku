'use strict';
/* Gomoku pure-logic module: no DOM dependencies.
 * In the browser, include via <script src="logic.js"> (globals);
 * in Node, require('./logic.js') for unit tests. */

var BOARD_SIZE = 15;
var EMPTY = 0, BLACK = 1, WHITE = 2;

function createBoard() {
  var b = new Array(BOARD_SIZE);
  for (var y = 0; y < BOARD_SIZE; y++) {
    b[y] = new Array(BOARD_SIZE);
    for (var x = 0; x < BOARD_SIZE; x++) b[y][x] = EMPTY;
  }
  return b;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function isFull(board) {
  for (var y = 0; y < BOARD_SIZE; y++)
    for (var x = 0; x < BOARD_SIZE; x++)
      if (board[y][x] === EMPTY) return false;
  return true;
}

/* Check from (x, y) whether `color` has five in a row.
 * Returns the winning line (at least 5 [x, y] points, overlines included), else null. */
function checkWin(board, x, y, color) {
  var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var d = 0; d < dirs.length; d++) {
    var dx = dirs[d][0], dy = dirs[d][1];
    var line = [[x, y]];
    for (var s = 1; s >= -1; s -= 2) {
      var nx = x + dx * s, ny = y + dy * s;
      while (inBounds(nx, ny) && board[ny][nx] === color) {
        line.push([nx, ny]);
        nx += dx * s;
        ny += dy * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

/* Place a stone for `color` at (x, y) on the state.
 * Returns { ok: true, winLine } on success, { ok: false, error } on failure. */
function applyMove(state, x, y, color) {
  if (state.status !== 'playing') return { ok: false, error: 'Game has not started' };
  if (state.turn !== color) return { ok: false, error: 'Not your turn' };
  if (!inBounds(x, y) || state.board[y][x] !== EMPTY)
    return { ok: false, error: 'Cannot place a stone here' };
  state.board[y][x] = color;
  state.lastMove = { x: x, y: y, color: color };
  state.moveCount++;
  var winLine = checkWin(state.board, x, y, color);
  if (winLine) {
    state.status = 'over';
    state.winner = color;
    state.winLine = winLine;
    state.turn = 0;
  } else if (isFull(state.board)) {
    state.status = 'over';
    state.winner = 0; /* draw */
    state.turn = 0;
  } else {
    state.turn = (color === BLACK) ? WHITE : BLACK;
  }
  return { ok: true, winLine: winLine || null };
}

/* Initial game state (both seats taken) */
function newGameState(blackName, whiteName) {
  return {
    board: createBoard(),
    turn: BLACK,
    status: 'playing',
    winner: 0,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    players: { black: { name: blackName }, white: { name: whiteName } },
    spectators: [],
    rematchBy: null,
    notice: ''
  };
}

/* Waiting-room state (host already seated as Black) */
function newWaitingState(blackName) {
  var s = newGameState(blackName, null);
  s.status = 'waiting';
  return s;
}

/* Reset the board for a rematch (seats are kept) */
function resetBoard(state) {
  state.board = createBoard();
  state.turn = BLACK;
  state.status = 'playing';
  state.winner = 0;
  state.winLine = null;
  state.lastMove = null;
  state.moveCount = 0;
  state.rematchBy = null;
  state.notice = '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BOARD_SIZE: BOARD_SIZE, EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE,
    createBoard: createBoard, inBounds: inBounds, isFull: isFull,
    checkWin: checkWin, applyMove: applyMove,
    newGameState: newGameState, newWaitingState: newWaitingState,
    resetBoard: resetBoard
  };
}
