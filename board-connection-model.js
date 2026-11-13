(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectBoardConnectionModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var colors = Object.freeze({
    violet: '#a995ee', blue: '#84b8ff', teal: '#6fd3bc',
    amber: '#efc071', rose: '#f097b6', gray: '#aab4c5'
  });
  var own = Object.prototype.hasOwnProperty;
  var fields = ['label', 'from', 'to', 'color', 'width', 'line', 'direction'];

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function normalize(edge) {
    edge = edge && typeof edge === 'object' ? edge : {};
    var width = Number(edge.width);
    return {
      label: (text(edge.label).trim() || 'related to').slice(0, 160),
      from: text(edge.from),
      to: text(edge.to),
      color: own.call(colors, edge.color) ? edge.color : 'violet',
      width: width === 3 || width === 4 ? width : 2,
      line: edge.line === 'dashed' || edge.line === 'dotted' ? edge.line : 'solid',
      direction: edge.direction === 'both' || edge.direction === 'none' ? edge.direction : 'forward'
    };
  }

  function describeStyle(edge) {
    var value = normalize(edge);
    return {
      colorHex: colors[value.color],
      width: value.width,
      dasharray: value.line === 'dashed' ? '8 6' : value.line === 'dotted' ? '1 6' : '',
      markerStart: value.direction === 'both',
      markerEnd: value.direction !== 'none'
    };
  }

  function fail(error) {
    return { ok: false, changed: false, error: error };
  }

  function commit(board, edgeId, draft) {
    if (!board || !Array.isArray(board.items) || !Array.isArray(board.edges)) {
      return fail('This board is unavailable.');
    }
    var index = board.edges.findIndex(function (edge) { return edge && edge.id === edgeId; });
    if (index < 0) return fail('This connection no longer exists.');
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return fail('Connection details are unavailable.');
    }

    var edge = board.edges[index];
    var candidate = {};
    fields.forEach(function (field) {
      candidate[field] = own.call(draft, field) ? draft[field] : edge[field];
    });
    if (text(candidate.label).trim().length > 160) {
      return fail('Use 160 characters or fewer for the connection name.');
    }
    var next = normalize(candidate);
    var ids = new Set(board.items.filter(Boolean).map(function (item) { return item.id; }));
    if (!next.from || !next.to || !ids.has(next.from) || !ids.has(next.to)) {
      return fail('Choose two cards that are on this board.');
    }
    if (next.from === next.to) return fail('Choose two different cards.');
    var duplicate = board.edges.some(function (other, otherIndex) {
      return otherIndex !== index && other && (
        (other.from === next.from && other.to === next.to) ||
        (other.from === next.to && other.to === next.from)
      );
    });
    if (duplicate) return fail('These cards already have a connection.');

    var previous = normalize(edge);
    var changed = fields.some(function (field) { return previous[field] !== next[field]; });
    if (!changed) return { ok: true, changed: false };
    fields.forEach(function (field) { edge[field] = next[field]; });
    return { ok: true, changed: true };
  }

  function remove(board, edgeId) {
    if (!board || !Array.isArray(board.edges)) return false;
    var index = board.edges.findIndex(function (edge) { return edge && edge.id === edgeId; });
    if (index < 0) return false;
    board.edges.splice(index, 1);
    return true;
  }

  return { colors: colors, normalize: normalize, describeStyle: describeStyle, commit: commit, remove: remove };
});
