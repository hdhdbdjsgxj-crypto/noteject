/* Board geometry helpers. Only board item positions are changed by arrange(). */
(() => {
  'use strict';

  const defaultWidth = 207;
  const defaultHeight = 160;
  const gap = 32;

  function finite(value, fallback = 0) {
    if (value === null || value === '' || typeof value === 'boolean') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function dimension(value, fallback) {
    const number = finite(value, fallback);
    return number > 0 ? number : fallback;
  }

  function entries(items, sizes) {
    return (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object').map((item, index) => {
      const measured = typeof sizes?.get === 'function' ? sizes.get(item.id) : sizes?.[item.id];
      return {
        item, index,
        x: finite(item.x), y: finite(item.y),
        width: dimension(measured?.width, defaultWidth),
        height: dimension(measured?.height, defaultHeight)
      };
    });
  }

  function extent(cards) {
    if (!cards.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const card of cards) {
      left = Math.min(left, card.x);
      top = Math.min(top, card.y);
      right = Math.max(right, card.x + card.width);
      bottom = Math.max(bottom, card.y + card.height);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function bounds(items, sizes = {}) {
    return extent(entries(items, sizes));
  }

  function arrange(items, selectedIds, mode, sizes = {}) {
    const selection = new Set(selectedIds || []);
    const cards = entries(items, sizes).filter(card => !selection.size || selection.has(card.item.id));
    const minimum = mode === 'grid' ? 1 : mode === 'align-left' || mode === 'align-top' ? 2 : mode === 'distribute-horizontal' || mode === 'distribute-vertical' ? 3 : Infinity;
    if (cards.length < minimum) return { count: 0 };
    const area = extent(cards);

    if (mode === 'align-left' || mode === 'align-top') {
      const axis = mode === 'align-left' ? 'x' : 'y';
      const coordinate = axis === 'x' ? area.left : area.top;
      for (const card of cards) card.item[axis] = coordinate;
    } else if (mode === 'grid') {
      cards.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
      const columns = Math.ceil(Math.sqrt(cards.length));
      const cellWidth = Math.max(...cards.map(card => card.width)) + gap;
      const cellHeight = Math.max(...cards.map(card => card.height)) + gap;
      cards.forEach((card, index) => {
        card.item.x = area.left + (index % columns) * cellWidth;
        card.item.y = area.top + Math.floor(index / columns) * cellHeight;
      });
    } else {
      const horizontal = mode === 'distribute-horizontal';
      const axis = horizontal ? 'x' : 'y';
      const measure = horizontal ? 'width' : 'height';
      cards.sort((a, b) => a[axis] - b[axis] || a.index - b.index);
      const totalSize = cards.reduce((sum, card) => sum + card[measure], 0);
      const spacing = ((horizontal ? area.width : area.height) - totalSize) / (cards.length - 1);
      let coordinate = horizontal ? area.left : area.top;
      for (const card of cards) {
        card.item[axis] = coordinate;
        coordinate += card[measure] + spacing;
      }
    }
    return { count: cards.length };
  }

  function fit(items, viewport, sizes = {}) {
    const area = bounds(items, sizes);
    if (!area) return { zoom: 1, left: 0, top: 0 };
    const width = dimension(viewport?.width, 1);
    const height = dimension(viewport?.height, 1);
    const zoom = Math.max(.01, Math.min(1.5, Math.max(1, width - 72) / area.width, Math.max(1, height - 72) / area.height));
    return {
      zoom,
      left: Math.max(0, (area.left + area.width / 2) * zoom - width / 2),
      top: Math.max(0, (area.top + area.height / 2) * zoom - height / 2)
    };
  }

  function centeredGrid(items, viewport, sizes = {}, options = {}) {
    const cards = entries(items, sizes);
    const width = dimension(viewport?.width, 1), height = dimension(viewport?.height, 1);
    // Size the persistent Board for its minimum supported scale, including
    // either device orientation. Zooming must not move cards or hit an edge
    // merely because the Board became smaller than the viewport.
    const minimumSpan = Math.max(width, height, dimension(viewport?.screenWidth, width), dimension(viewport?.screenHeight, height)) / .01 * 3;
    const overviewFrame = (area = {}) => ({
      width: Math.max(16000, dimension(options.worldFrame?.width, 16000), finite(area.width) + 400, minimumSpan),
      height: Math.max(10000, dimension(options.worldFrame?.height, 10000), finite(area.height) + 400, minimumSpan)
    });
    if (!cards.length) {
      const worldFrame = overviewFrame();
      return { count: 0, changed: false, zoom: .1, worldFrame, anchorId: null, center: { x: worldFrame.width / 2, y: worldFrame.height / 2 } };
    }
    const cellWidth = Math.max(...cards.map(card => card.width)), cellHeight = Math.max(...cards.map(card => card.height));
    let best = null;
    // Choose columns for the actual phone orientation. Board item order owns
    // reading order, so a later batch cannot shuffle existing cards by position.
    for (let columns = 1; columns <= cards.length; columns++) {
      const rows = Math.ceil(cards.length / columns);
      const gridWidth = columns * cellWidth + (columns - 1) * gap;
      const gridHeight = rows * cellHeight + (rows - 1) * gap;
      const zoom = Math.min(1.5, Math.max(1, width - 72) / gridWidth, Math.max(1, height - 72) / gridHeight);
      const waste = rows * columns - cards.length;
      if (!best || zoom > best.zoom + .000001 || (Math.abs(zoom - best.zoom) < .000001 && waste < best.waste)) best = { columns, gridWidth, gridHeight, zoom, waste };
    }
    if (options.overview) {
      const anchor = cards.find(card => card.item.id === options.centerAssetId) || cards[0];
      const ordered = [anchor, ...cards.filter(card => card !== anchor)];
      const columns = best.columns % 2 ? best.columns : best.columns + 1;
      const neededRows = Math.ceil(cards.length / columns), rows = neededRows % 2 ? neededRows : neededRows + 1, slots = [];
      // The middle slot belongs to the first asset. Fill nearby slots outward,
      // keeping every card's center aligned to a uniform, nonoverlapping grid.
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        slots.push({ x: column - Math.floor(columns / 2), y: row - Math.floor(rows / 2) });
      }
      slots.sort((a, b) => Math.abs(a.x) + Math.abs(a.y) - Math.abs(b.x) - Math.abs(b.y) || Math.abs(a.y) - Math.abs(b.y) || b.x - a.x || a.y - b.y);
      ordered.forEach((card, index) => {
        card.item.x = slots[index].x * (cellWidth + gap) - card.width / 2;
        card.item.y = slots[index].y * (cellHeight + gap) - card.height / 2;
      });
      const area = bounds(items, sizes);
      const radiusX = Math.max(-area.left, area.right), radiusY = Math.max(-area.top, area.bottom);
      const zoom = Math.max(.01, Math.min(.1, width * .3 / radiusX, height * .3 / radiusY));
      const worldFrame = overviewFrame({ width: radiusX * 2, height: radiusY * 2 });
      const center = { x: worldFrame.width / 2, y: worldFrame.height / 2 };
      for (const card of cards) { card.item.x += center.x; card.item.y += center.y; }
      return {
        count: cards.length,
        changed: cards.some(card => Math.abs(card.x - card.item.x) > .01 || Math.abs(card.y - card.item.y) > .01),
        zoom, worldFrame, center, anchorId: anchor.item.id
      };
    }
    // Leave enough world space above/left for the viewport center. Otherwise
    // scroll clamping pins a fitted grid to the top of a tall phone screen.
    const zoom = Math.max(.01, best.zoom), empty = window.NotejectBoardScene.worldSize([]);
    const left = Math.max(empty.width / 2, width / (2 * zoom)) - best.gridWidth / 2;
    const top = Math.max(empty.height / 2, height / (2 * zoom)) - best.gridHeight / 2;
    let changed = false;
    cards.forEach((card, index) => {
      const x = left + (index % best.columns) * (cellWidth + gap);
      const y = top + Math.floor(index / best.columns) * (cellHeight + gap);
      if (Math.abs(card.x - x) > .01 || Math.abs(card.y - y) > .01) changed = true;
      card.item.x = x; card.item.y = y;
    });
    const actual = bounds(items, sizes), target = fit(items, { width, height }, sizes);
    const worldFrame = null;
    const dx = Math.max(empty.width / 2, width / (2 * target.zoom)) - (actual.left + actual.width / 2);
    const dy = Math.max(empty.height / 2, height / (2 * target.zoom)) - (actual.top + actual.height / 2);
    for (const card of cards) {
      card.item.x += dx; card.item.y += dy;
    }
    changed = cards.some(card => Math.abs(card.x - card.item.x) > .01 || Math.abs(card.y - card.item.y) > .01);
    return { count: cards.length, changed, zoom: target.zoom, worldFrame, center: { x: actual.left + actual.width / 2 + dx, y: actual.top + actual.height / 2 + dy } };
  }

  window.NotejectBoardLayout = Object.freeze({ arrange, bounds, fit, centeredGrid });
})();
