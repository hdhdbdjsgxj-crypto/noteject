/* SVG rendering for editable board connections. Card coordinates are world coordinates. */
(function (root, factory) {
  'use strict';
  var model = typeof module === 'object' && module.exports
    ? require('./board-connection-model.js') : root.NotejectBoardConnectionModel;
  var api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectBoardConnectionRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis, function (model) {
  'use strict';

  function escape(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function number(value, fallback) {
    if (value === null || value === '' || typeof value === 'boolean') return fallback;
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function dimension(value, fallback) {
    var result = number(value, fallback);
    return result > 0 ? result : fallback;
  }

  function round(value) { return Math.round(value * 100) / 100; }

  function node(value) {
    if (!value || typeof value !== 'object') return null;
    var x = number(value.x, NaN), y = number(value.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: x, y: y, width: dimension(value.width, 207), height: dimension(value.height, 160) };
  }

  function route(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var horizontal = Math.abs(dx) >= Math.abs(dy);
    var sign = (horizontal ? dx : dy) < 0 ? -1 : 1;
    var start = { x: from.x, y: from.y }, end = { x: to.x, y: to.y };
    var gap = 5, bend;
    if (horizontal) {
      start.x += sign * (from.width / 2 + gap);
      end.x -= sign * (to.width / 2 + gap);
      bend = Math.max(36, Math.abs(end.x - start.x) / 2);
      return {
        d: 'M ' + round(start.x) + ' ' + round(start.y) + ' C ' + round(start.x + sign * bend) + ' ' + round(start.y) + ', ' + round(end.x - sign * bend) + ' ' + round(end.y) + ', ' + round(end.x) + ' ' + round(end.y),
        x: (start.x + end.x) / 2, y: (start.y + end.y) / 2
      };
    }
    start.y += sign * (from.height / 2 + gap);
    end.y -= sign * (to.height / 2 + gap);
    bend = Math.max(36, Math.abs(end.y - start.y) / 2);
    return {
      d: 'M ' + round(start.x) + ' ' + round(start.y) + ' C ' + round(start.x) + ' ' + round(start.y + sign * bend) + ', ' + round(end.x) + ' ' + round(end.y - sign * bend) + ', ' + round(end.x) + ' ' + round(end.y),
      x: (start.x + end.x) / 2, y: (start.y + end.y) / 2
    };
  }

  /* Each horizontal bucket keeps a compressed index of occupied label rows.
     Shared midpoints jump directly to a free row instead of scanning old labels. */
  function labels(viewport) {
    var columns = new Map();
    var viewportWidth = dimension(viewport.width, Infinity);
    var viewportHeight = dimension(viewport.height, Infinity);

    function column(index) {
      if (!columns.has(index)) columns.set(index, new Map());
      return columns.get(index);
    }

    function free(rows, row) {
      var result = row, visited = [];
      while (rows.has(result)) { visited.push(result); result = rows.get(result); }
      visited.forEach(function (previous) { rows.set(previous, result); });
      return result;
    }

    return function place(x, y, width) {
      var inset = width / 2 + 12;
      if (Number.isFinite(viewportWidth) && viewportWidth >= inset * 2) x = Math.max(inset, Math.min(viewportWidth - inset, x));
      y = Math.max(12, Number.isFinite(viewportHeight) ? Math.min(Math.max(12, viewportHeight - 12), y) : y);
      var first = Math.floor((x - width / 2) / 128), last = Math.floor((x + width / 2) / 128);
      var row = Math.max(0, Math.round((y - 12) / 24));
      while (true) {
        var next = row;
        for (var index = first; index <= last; index++) next = Math.max(next, free(column(index), row));
        if (next === row) break;
        row = next;
      }
      for (var reserved = first; reserved <= last; reserved++) {
        var rows = column(reserved);
        rows.set(row, free(rows, row + 1));
      }
      return { x: round(x), y: 12 + row * 24 };
    };
  }

  function marker(name, color) {
    return '<marker id="noteject-edge-arrow-' + name + '" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" style="fill:' + color + ';stroke:none"></path></marker>';
  }

  function render(edges, nodes, viewport) {
    if (!Array.isArray(edges) || !nodes || typeof nodes.get !== 'function') return '';
    var place = labels(viewport || {}), groups = [];
    var palette = model.colors;
    edges.forEach(function (edge) {
      if (!edge || typeof edge !== 'object') return;
      var normalized = model.normalize(edge);
      var from = node(nodes.get(normalized.from)), to = node(nodes.get(normalized.to));
      if (!from || !to) return;
      var style = model.describeStyle(edge), path = route(from, to);
      var label = normalized.label, edgeId = escape(edge.id == null ? '' : edge.id);
      var position = place(path.x, path.y - 5, Math.max(50, label.length * 6 + 20));
      var arrow = 'url(#noteject-edge-arrow-' + normalized.color + ')';
      var markers = (style.markerStart ? ' marker-start="' + arrow + '"' : '') + (style.markerEnd ? ' marker-end="' + arrow + '"' : '');
      groups.push('<g class="mindmap-edge" data-edge="' + edgeId + '" data-edit-edge="' + edgeId + '" role="button" tabindex="0" aria-label="Edit connection: ' + escape(label) + '">' +
        '<title>Edit connection: ' + escape(label) + '</title>' +
        '<path class="mindmap-edge-line" d="' + path.d + '"' + markers + ' style="fill:none;stroke:' + style.colorHex + ';stroke-width:' + style.width + ';stroke-opacity:.88;stroke-dasharray:' + (style.dasharray || 'none') + ';stroke-linecap:round;pointer-events:stroke"></path>' +
        '<path class="mindmap-edge-hit" d="' + path.d + '" data-rename-edge="' + edgeId + '" style="fill:none;stroke:transparent;stroke-width:16;stroke-opacity:1;pointer-events:stroke"></path>' +
        '<text x="' + position.x + '" y="' + position.y + '" text-anchor="middle" data-rename-edge="' + edgeId + '" style="fill:' + style.colorHex + '">' + escape(label) + ' <tspan class="edge-edit-mark">✎</tspan></text></g>');
    });
    if (!groups.length) return '';
    return '<defs>' + Object.keys(palette).map(function (name) { return marker(name, palette[name]); }).join('') + '</defs>' + groups.join('');
  }

  return { render: render };
});
