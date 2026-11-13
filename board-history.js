(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectBoardHistory = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // History is kept in memory. The limit counts undoable edits, plus one baseline.
  // Observe after a completed edit; observe again after undo/redo is a safe no-op.
  function create(limit) {
    var undoLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
    var boards = new Map();

    function validBoard(board) {
      return board && typeof board.id === 'string' && board.id.length > 0;
    }

    function snapshot(board) {
      // Board layouts contain JSON data. Sorting object keys avoids extra history
      // entries when an equivalent item is reconstructed with a different order.
      return JSON.stringify({
        items: Array.isArray(board.items) ? board.items : [],
        edges: Array.isArray(board.edges) ? board.edges : [],
        groups: Array.isArray(board.groups) ? board.groups : [],
        worldFrame: board.worldFrame || null,
        centerAssetId: board.centerAssetId || null
      }, function (key, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        var sorted = Object.create(null);
        Object.keys(value).sort().forEach(function (name) { sorted[name] = value[name]; });
        return sorted;
      });
    }

    function observe(board) {
      if (!validBoard(board)) return false;
      var next = snapshot(board);
      var history = boards.get(board.id);
      if (!history) {
        boards.set(board.id, { frames: [next], cursor: 0 });
        return true;
      }
      if (history.frames[history.cursor] === next) return false;
      // Any new edit after undo starts a new branch and drops the old redo path.
      history.frames.splice(history.cursor + 1);
      history.frames.push(next);
      if (history.frames.length > undoLimit + 1) {
        history.frames.splice(0, history.frames.length - undoLimit - 1);
      }
      history.cursor = history.frames.length - 1;
      return true;
    }

    function move(board, direction) {
      if (!validBoard(board)) return false;
      var history = boards.get(board.id);
      if (!history) return false;
      var cursor = history.cursor + direction;
      if (cursor < 0 || cursor >= history.frames.length) return false;
      // Parse on every restoration so live mutations cannot alter saved frames.
      var restored = JSON.parse(history.frames[cursor]);
      board.items = restored.items;
      board.edges = restored.edges;
      board.groups = restored.groups;
      if (restored.worldFrame) board.worldFrame = restored.worldFrame; else delete board.worldFrame;
      if (restored.centerAssetId) board.centerAssetId = restored.centerAssetId; else delete board.centerAssetId;
      history.cursor = cursor;
      return true;
    }

    function coalesce(board) {
      if (!validBoard(board)) return false;
      var next = snapshot(board);
      var history = boards.get(board.id);
      if (!history) {
        boards.set(board.id, { frames: [next], cursor: 0 });
        return true;
      }
      // Automatic first-visit placement belongs to the edit that introduced
      // the cards. Replace the current frame so one Undo removes that edit.
      history.frames[history.cursor] = next;
      return true;
    }

    return {
      observe: observe,
      coalesce: coalesce,
      undo: function (board) { return move(board, -1); },
      redo: function (board) { return move(board, 1); },
      canUndo: function (boardId) {
        var history = boards.get(boardId);
        return Boolean(history && history.cursor > 0);
      },
      canRedo: function (boardId) {
        var history = boards.get(boardId);
        return Boolean(history && history.cursor < history.frames.length - 1);
      },
      discard: function (boardId) { return boards.delete(boardId); }
    };
  }

  return { create: create };
});
