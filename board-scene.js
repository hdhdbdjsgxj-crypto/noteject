/* Pure board scene geometry. Scroll and anchor coordinates use screen pixels. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotejectBoardScene = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const cardWidth = 207;
  const cardHeight = 160;
  const padding = 200;
  const minimumWidth = 1600;
  const minimumHeight = 1000;
  const mapWidth = 180;
  const mapHeight = 126;

  function finite(value, fallback = 0) {
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    if (typeof value === 'string' && !value.trim()) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positive(value, fallback) {
    const number = finite(value, fallback);
    return number > 0 ? number : fallback;
  }

  function bounded(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function cards(items, sizes) {
    return (Array.isArray(items) ? items : [])
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => {
        const measured = typeof sizes?.get === 'function' ? sizes.get(item.id) : sizes?.[item.id];
        return {
          id: item.id,
          type: item.type,
          x: Math.max(0, finite(item.x)),
          y: Math.max(0, finite(item.y)),
          width: positive(measured?.width, cardWidth),
          height: positive(measured?.height, cardHeight)
        };
      });
  }

  function extent(entries, frame) {
    let width = Math.max(minimumWidth, positive(frame?.width, minimumWidth));
    let height = Math.max(minimumHeight, positive(frame?.height, minimumHeight));
    for (const card of entries) {
      // Saturate sums so malformed, extreme values cannot produce Infinity.
      width = Math.max(width, Math.min(Number.MAX_VALUE, card.x + card.width + padding));
      height = Math.max(height, Math.min(Number.MAX_VALUE, card.y + card.height + padding));
    }
    return { width, height };
  }

  function worldSize(items, sizes, frame) {
    return extent(cards(items, sizes), frame);
  }

  function rectangle(x, y, width, height, world) {
    const left = bounded(x / world.width * 100);
    const top = bounded(y / world.height * 100);
    return {
      left,
      top,
      width: bounded(width / world.width * 100, 0, 100 - left),
      height: bounded(height / world.height * 100, 0, 100 - top)
    };
  }

  function minimap(items, viewport = {}, sizes) {
    const entries = cards(items, sizes);
    const world = extent(entries, viewport.worldFrame);
    const zoom = positive(viewport?.zoom, 1);
    const scale = Math.min(mapWidth / world.width, mapHeight / world.height);
    return {
      width: world.width * scale,
      height: world.height * scale,
      worldWidth: world.width,
      worldHeight: world.height,
      nodes: entries.map(card => ({
        id: card.id,
        type: card.type,
        ...rectangle(card.x, card.y, card.width, card.height, world)
      })),
      viewport: rectangle(
        Math.max(0, finite(viewport?.left)) / zoom,
        Math.max(0, finite(viewport?.top)) / zoom,
        Math.max(0, finite(viewport?.width)) / zoom,
        Math.max(0, finite(viewport?.height)) / zoom,
        world
      )
    };
  }

  function anchorZoom(oldZoom, newZoom, scroll = {}, anchor = {}) {
    const previous = positive(oldZoom, 1);
    const next = positive(newZoom, previous);
    const left = Math.max(0, finite(scroll?.left));
    const top = Math.max(0, finite(scroll?.top));
    const x = finite(anchor?.x);
    const y = finite(anchor?.y);
    const ratio = next / previous;
    const coordinate = (value, point) => {
      const result = (value + point) * ratio - point;
      if (!Number.isFinite(result)) return result > 0 ? Number.MAX_VALUE : 0;
      return Math.max(0, Math.min(Number.MAX_VALUE, result));
    };
    return { left: coordinate(left, x), top: coordinate(top, y) };
  }

  function groupSelection(board, selected) {
    const items = board?.items || [], valid = new Set(items.map(item => item.id));
    const ids = new Set([...selected].filter(id => valid.has(id))), groups = new Set();
    for (const item of items) if (ids.has(item.id) && item.groupId) groups.add(item.groupId);
    for (const group of board?.groups || []) {
      if (!groups.has(group.id) && !(group.itemIds || []).some(id => ids.has(id))) continue;
      groups.add(group.id);
      for (const id of group.itemIds || []) if (valid.has(id)) ids.add(id);
    }
    for (const item of items) if (groups.has(item.groupId)) ids.add(item.id);
    return [...ids];
  }

  return Object.freeze({ worldSize, minimap, anchorZoom, groupSelection });
});
