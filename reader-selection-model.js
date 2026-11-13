(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectReaderSelectionModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var colors = Object.freeze({
    violet: '#a995ee', blue: '#84b8ff', teal: '#6fd3bc',
    amber: '#efc071', rose: '#f097b6', gray: '#aab4c5'
  });
  var own = Object.prototype.hasOwnProperty;

  function text(value) { return typeof value === 'string' ? value : ''; }
  function cleanText(value) { return text(value).replace(/\r\n?/g, '\n').trim(); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function timestamp(value) { return finite(value) && value >= 0 ? value : 0; }

  function automaticTitle(quote, comment) {
    var source = cleanText(quote || comment).replace(/\s+/g, ' ');
    if (!source) return 'Reader comment';
    if (source.length <= 76) return source;
    var title = source.slice(0, 76), boundary = title.lastIndexOf(' ');
    if (boundary >= 48) title = title.slice(0, boundary);
    return title.trimEnd() + '…';
  }

  function tags(value) {
    var values = Array.isArray(value) ? value : [value];
    var seen = new Set(), result = [];
    values.forEach(function (item) {
      text(item).split(/[,#]/).forEach(function (part) {
        var tag = part.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
        var key = tag.toLocaleLowerCase();
        if (tag && !seen.has(key) && result.length < 12) { seen.add(key); result.push(tag); }
      });
    });
    return result;
  }

  function location(value) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var result = {};
    if (finite(value.page) && value.page >= 1) result.page = Math.floor(value.page);
    if (typeof value.chapter === 'string' && value.chapter.trim()) result.chapter = value.chapter.trim().slice(0, 240);
    if (finite(value.chapterIndex) && value.chapterIndex >= 0) result.chapterIndex = Math.floor(value.chapterIndex);
    if (finite(value.pageScroll)) result.pageScroll = Math.max(0, Math.min(1, value.pageScroll));
    if (finite(value.scroll)) result.scroll = Math.max(0, Math.min(1, value.scroll));
    if (finite(value.textOffset) && value.textOffset >= 0) result.textOffset = Math.floor(value.textOffset);
    if (finite(value.endPage) && value.endPage >= (result.page || 1)) result.endPage = Math.floor(value.endPage);
    if (finite(value.endTextOffset) && value.endTextOffset >= 0) result.endTextOffset = Math.floor(value.endTextOffset);
    if (Array.isArray(value.pages)) {
      result.pages = value.pages.slice(0, 128).filter(part => part && finite(part.page) && part.page >= (result.page || 1) && part.page <= (result.endPage || result.page || 1))
        .map(part => ({ page: Math.floor(part.page), textOffset: Math.max(0, Math.floor(Number(part.textOffset) || 0)), quote: text(part.quote).slice(0, 200000) }));
    }
    if (finite(value.endChapterIndex) && value.endChapterIndex >= (result.chapterIndex || 0)) result.endChapterIndex = Math.floor(value.endChapterIndex);
    if (Array.isArray(value.chapters)) result.chapters = value.chapters.slice(0,128).filter(part=>part && finite(part.chapterIndex) && part.chapterIndex >= (result.chapterIndex || 0) && part.chapterIndex <= (result.endChapterIndex ?? result.chapterIndex ?? 0)).map(part=>({chapterIndex:Math.floor(part.chapterIndex),textOffset:Math.max(0,Math.floor(Number(part.textOffset)||0)),quote:text(part.quote).slice(0,200000)}));
    if (typeof value.sourceRevision === 'string' && value.sourceRevision.length <= 200) result.sourceRevision = value.sourceRevision;
    for (var field of ['prefix', 'suffix']) if (typeof value[field] === 'string') result[field] = value[field].slice(0, 80);
    return result;
  }

  function textIndex(full) {
    var chars = [], starts = [], ends = [];
    for (var i = 0; i < full.length; i++) {
      var char = /\s/.test(full[i]) ? ' ' : full[i];
      if (char === ' ' && chars[chars.length - 1] === ' ') { ends[ends.length - 1] = i + 1; continue; }
      chars.push(char); starts.push(i); ends.push(i + 1);
    }
    return { text: chars.join(''), starts: starts, ends: ends };
  }

  function findTextRange(index, quote, place) {
    var needle = quoteKey(quote), where = location(place), preferred = where.textOffset;
    if (!needle) return null;
    if (finite(preferred)) {
      var low = 0, high = index.starts.length;
      while (low < high) { var middle = (low + high) >>> 1; if (index.starts[middle] < preferred) low = middle + 1; else high = middle; }
      if (index.starts[low] === preferred && index.text.startsWith(needle, low)) return { index: low, endIndex: low + needle.length - 1, start: preferred, end: index.ends[low + needle.length - 1] };
    }
    var prefix = quoteKey(where.prefix), suffix = quoteKey(where.suffix), best = null, tied = false;
    for (var at = index.text.indexOf(needle); at >= 0; at = index.text.indexOf(needle, at + 1)) {
      var before = prefix ? index.text.slice(Math.max(0, at - prefix.length - 2), at).trimEnd() : '';
      var after = suffix ? index.text.slice(at + needle.length, at + needle.length + suffix.length + 2).trimStart() : '';
      var score = (prefix && before.endsWith(prefix) ? 1 : 0) + (suffix && after.startsWith(suffix) ? 1 : 0);
      var distance = finite(preferred) ? Math.abs(index.starts[at] - preferred) : 0;
      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { index: at, endIndex: at + needle.length - 1, start: index.starts[at], end: index.ends[at + needle.length - 1], score: score, distance: distance }; tied = false;
      } else if (score === best.score && distance === best.distance) tied = true;
    }
    return tied ? null : best;
  }

  function locationLabel(value) {
    var place = location(value), labels = [];
    if (place.page) labels.push(place.endPage > place.page ? 'Pages ' + place.page + '–' + place.endPage : 'Page ' + place.page);
    if (place.endChapterIndex > place.chapterIndex) labels.push('Chapters '+(place.chapterIndex+1)+'–'+(place.endChapterIndex+1));
    else if (place.chapter) labels.push(place.chapter);
    else if (own.call(place, 'chapterIndex')) labels.push('Chapter ' + (place.chapterIndex + 1));
    if (!labels.length && own.call(place, 'textOffset')) labels.push('Text passage');
    if (!labels.length && own.call(place, 'scroll')) labels.push(Math.round(place.scroll * 100) + '% through document');
    return labels.join(' · ');
  }

  function legacyQuote(note) {
    var content = cleanText(note.content);
    if (!/^>\s?/.test(content)) return '';
    // Older selections only prefixed their first line; retain subsequent lines too.
    var source = content.search(/\n\s*\nSource:\s*\[\[/i);
    if (source >= 0) content = content.slice(0, source);
    return content.split('\n').map(function (line) { return line.replace(/^> ?/, ''); }).join('\n').trim();
  }

  function normalize(note) {
    note = note && typeof note === 'object' ? note : {};
    var quote = typeof note.selectionQuote === 'string' ? cleanText(note.selectionQuote) : legacyQuote(note);
    var comment = cleanText(note.selectionComment);
    var title = text(note.title).trim();
    if (!title && (note.selectionSourceId || quote || comment)) title = automaticTitle(quote, comment);
    return {
      id: text(note.id),
      title: title,
      folder: text(note.folder).trim() || 'Inbox',
      quote: quote,
      comment: comment,
      tags: tags(note.tags),
      color: own.call(colors, note.selectionColor) ? note.selectionColor : 'violet',
      location: location(note.selectionLocation),
      favorite: !!note.favorite,
      created: timestamp(note.created) || timestamp(note.updated),
      updated: timestamp(note.updated) || timestamp(note.created)
    };
  }

  function normalizeDraft(draft) {
    draft = draft && typeof draft === 'object' ? draft : {};
    var quote = cleanText(own.call(draft, 'quote') ? draft.quote : draft.selectionQuote);
    var title = cleanText(draft.title).replace(/\s+/g, ' ').slice(0, 160) || automaticTitle(quote, draft.comment);
    var color = own.call(draft, 'color') ? draft.color : draft.selectionColor;
    return {
      title: title,
      folder: text(draft.folder).trim().slice(0, 80) || 'Inbox',
      quote: quote,
      comment: cleanText(own.call(draft, 'comment') ? draft.comment : draft.selectionComment),
      tags: tags(draft.tags),
      color: own.call(colors, color) ? color : 'violet',
      location: location(own.call(draft, 'location') ? draft.location : draft.selectionLocation),
      favorite: !!draft.favorite
    };
  }

  function syncFromContent(note) {
    if (!note || typeof note !== 'object' || Array.isArray(note)) return note;
    var body = text(note.content).replace(/\r\n?/g, '\n');
    var source = body.lastIndexOf('\n\nSource: [['), sourceLine = '';
    if (source >= 0) {
      sourceLine = body.slice(source + 2).trim();
      body = body.slice(0, source);
    }
    body = body.trim();
    var lines = body.split('\n'), quote = [], index = 0;
    // New reader notes store passages as ordinary text. Use their existing
    // passage metadata to distinguish the quote from the user's comment.
    var savedQuote = cleanText(note.selectionQuote);
    if (savedQuote && body.startsWith(savedQuote)) {
      note.selectionQuote = savedQuote;
      note.selectionComment = body.slice(savedQuote.length).replace(/^\n{1,}/, '').trim();
    } else {
      // Read older notes that used Markdown blockquote prefixes, then migrate
      // their content to plain text the next time they are saved.
      while (index < lines.length && /^>/.test(lines[index])) {
        quote.push(lines[index].replace(/^> ?/, ''));
        index++;
      }
      if (quote.length) {
        note.selectionQuote = quote.join('\n').trim();
        note.selectionComment = lines.slice(index).join('\n').trim();
      } else {
        note.selectionQuote = savedQuote;
        note.selectionComment = body;
      }
    }
    var plainBody = quote.length ? [cleanText(note.selectionQuote), cleanText(note.selectionComment)].filter(Boolean).join('\n\n') : body;
    note.content = [plainBody, sourceLine].filter(Boolean).join('\n\n');
    return note;
  }

  function selectionsFor(data, doc) {
    if (!doc || !doc.id || !data || !Array.isArray(data.notes)) return [];
    return data.notes.filter(function (note) {
      if (!note) return false;
      if (note.selectionSourceId || note.sourceId) return (note.selectionSourceId || note.sourceId) === doc.id;
      return /^Highlight\b/.test(text(note.title)) && text(note.content).includes('[[' + text(doc.name) + ']]');
    });
  }

  function quoteKey(value) { return cleanText(value).replace(/\s+/g, ' '); }

  function contentFor(draft, doc) {
    var content = draft.quote || '';
    if (draft.comment) content += (content ? '\n\n' : '') + draft.comment;
    var name = text(doc.name).replace(/[\r\n]+/g, ' ') || 'Document';
    content += (content ? '\n\n' : '') + 'Source: [[' + name + ']]';
    var place = locationLabel(draft.location);
    if (place) content += ' · ' + place;
    return content;
  }

  function chooseBoard(data, options, docId) {
    var boards = Array.isArray(data.boards) ? data.boards.filter(Boolean) : [];
    if (options.boardId) return boards.find(function (board) { return board.id === options.boardId; });
    return boards.find(function (board) { return Array.isArray(board.items) && board.items.some(function (item) { return item && item.id === docId; }); }) ||
      boards.find(function (board) { return board.id === data.activeBoard; }) || boards[0];
  }

  function positionNear(items, origin) {
    var width = 310, height = 260, gap = 32;
    var originX = finite(origin && origin.x) ? origin.x : 100;
    var originY = finite(origin && origin.y) ? origin.y : 100;
    // Scan a stable grid to keep repeated saves from stacking cards on top of each other.
    for (var index = 0; index <= items.length; index++) {
      var x = Math.max(40, originX + width + gap + Math.floor(index / 4) * (width + gap));
      var y = Math.max(40, originY + (index % 4) * (height + gap));
      var occupied = items.some(function (item) {
        return item && finite(item.x) && finite(item.y) &&
          item.x < x + width + gap && item.x + width + gap > x &&
          item.y < y + height + gap && item.y + height + gap > y;
      });
      if (!occupied) return { x: x, y: y };
    }
    var right = items.reduce(function (max, item) { return item && finite(item.x) ? Math.max(max, item.x + width + gap) : max; }, originX + width + gap);
    return { x: right, y: Math.max(40, originY) };
  }

  function saveSelection(data, options, makeId, now) {
    options = options && typeof options === 'object' ? options : {};
    if (!data || !Array.isArray(data.docs)) return { ok: false, error: 'This document is unavailable.' };
    var doc = data.docs.find(function (item) { return item && item.id === options.docId; });
    if (!doc) return { ok: false, error: 'This document is unavailable.' };
    var draft = normalizeDraft(options.draft);
    if (!draft.quote && !draft.comment) return { ok: false, error: 'Add a passage or a comment first.' };
    var notes = Array.isArray(data.notes) ? data.notes : [];
    var existing = options.noteId ? notes.find(function (note) { return note && note.id === options.noteId; }) : null;
    var related = selectionsFor(data, doc);
    if (options.noteId && (!existing || !related.includes(existing))) return { ok: false, error: 'This saved selection is unavailable.' };
    // Native events identify accepted annotations by passage/event ID. Keep
    // each new ID so its location, comment, and later deletion stay consistent.
    if (!existing && options.preserveAnnotation !== true) {
      var duplicate = draft.quote && related.find(function (note) {
        var saved = normalize(note);
        return quoteKey(saved.quote) === quoteKey(draft.quote) && JSON.stringify(location(saved.location)) === JSON.stringify(location(draft.location));
      });
      if (duplicate) return { ok: false, duplicate: duplicate.id, error: 'This passage is already saved. Open the saved selection to edit it.' };
    }
    var board = options.addToBoard === false ? null : chooseBoard(data, options, doc.id);
    if (options.addToBoard !== false && !board) return { ok: false, error: 'Choose an available board, or save without adding a card.' };
    if (typeof makeId !== 'function') return { ok: false, error: 'Could not create a saved selection.' };
    var time = typeof now === 'function' ? now() : now;
    time = finite(time) && time >= 0 ? time : Date.now();
    var noteId = existing ? existing.id : makeId();
    var edgeId = board && !(Array.isArray(board.edges) && board.edges.some(function (edge) {
      return edge && ((edge.from === noteId && edge.to === doc.id) || (edge.from === doc.id && edge.to === noteId));
    })) ? makeId() : null;
    var previousCreated = existing ? timestamp(existing.created) || timestamp(existing.updated) : time;
    var note = existing || { id: noteId, created: time, folder: text(doc.folder) || 'Inbox', archived: false };
    note.title = draft.title;
    note.folder = draft.folder;
    note.content = contentFor(draft, doc);
    note.selectionQuote = draft.quote;
    note.selectionComment = draft.comment;
    note.selectionLocation = draft.location;
    note.selectionColor = draft.color;
    note.selectionSourceId = doc.id;
    note.selectionSourceName = text(doc.name);
    note.sourceId = doc.id;
    note.sourceName = text(doc.name);
    note.tags = draft.tags;
    note.favorite = draft.favorite;
    note.updated = time;
    if (!note.created) note.created = previousCreated || time;
    if (!existing) { if (!Array.isArray(data.notes)) data.notes = notes; notes.unshift(note); }
    if (board) {
      if (!Array.isArray(board.items)) board.items = [];
      if (!Array.isArray(board.edges)) board.edges = [];
      var source = board.items.find(function (item) { return item && item.id === doc.id; });
      if (!source) {
        if (!board.items.length) board.focusNewAssets = true;
        var sourcePosition = board.items.length ? positionNear(board.items, { x: 40, y: 100 }) : { x: 697, y: 420 };
        source = { type: 'doc', id: doc.id, x: sourcePosition.x, y: sourcePosition.y };
        board.items.push(source);
      }
      if (!board.items.some(function (item) { return item && item.id === note.id; })) {
        var position = positionNear(board.items, source);
        board.items.push({ type: 'note', id: note.id, x: position.x, y: position.y });
      }
      if (edgeId) board.edges.push({ id: edgeId, from: note.id, to: doc.id, label: 'selection from' });
    }
    return { ok: true, note: note, created: !existing, board: board || null };
  }

  function addSelectionsToBoard(data, docId, boardId, makeId) {
    var doc = (data.docs || []).find(function (item) { return item.id === docId; });
    var board = (data.boards || []).find(function (item) { return item.id === boardId; });
    if (!doc || !board || typeof makeId !== 'function') return { ok: false, error: 'Choose an available Board for this document.' };
    var notes = selectionsFor(data, doc), added = 0;
    if (!notes.length) return { ok: false, error: 'Save a passage first.' };
    if (!Array.isArray(board.items)) board.items = [];
    if (!Array.isArray(board.edges)) board.edges = [];
    var source = board.items.find(function (item) { return item.id === docId; });
    var emptyBoard = board.items.length === 0;
    if (emptyBoard) board.focusNewAssets = true;
    var right = board.items.reduce(function (value, item) { return finite(item.x) ? Math.max(value, item.x + Math.max(310, Number(item.width) || 0) + 32) : value; }, emptyBoard ? 697 : 100);
    if (!source) { source = { type: 'doc', id: docId, x: right, y: emptyBoard ? 420 : 100 }; board.items.push(source); right += 342; }
    // Append a compact grid beyond existing cards. Sets keep a whole-book
    // addition linear instead of rescanning the Board for every placement.
    var itemIds = new Set(board.items.map(function (item) { return item.id; }));
    var edgeKeys = new Set(board.edges.map(function (edge) { return JSON.stringify([edge.from, edge.to].sort()); }));
    for (var note of notes) {
      if (!itemIds.has(note.id)) {
        board.items.push({ type: 'note', id: note.id, x: right + Math.floor(added / 4) * 342, y: Math.max(40, Number(source.y) || 100) + (added % 4) * 292 });
        itemIds.add(note.id); added++;
      }
      var key = JSON.stringify([note.id, docId].sort());
      if (!edgeKeys.has(key)) { board.edges.push({ id: makeId(), from: note.id, to: docId, label: 'selection from' }); edgeKeys.add(key); }
    }
    doc.readerPassageBoardId = board.id;
    return { ok: true, board: board, added: added, total: notes.length };
  }

  return { colors: colors, normalize: normalize, normalizeDraft: normalizeDraft, automaticTitle: automaticTitle, syncFromContent: syncFromContent, selectionsFor: selectionsFor, locationLabel: locationLabel, saveSelection: saveSelection, addSelectionsToBoard: addSelectionsToBoard, textIndex: textIndex, findTextRange: findTextRange };
});
