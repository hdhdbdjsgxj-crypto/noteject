/* Noteject's local search index lives in this worker, including document text. */
'use strict';

const sourceMap = new Map();
const requests = [];
let index = null;
let bootError = null;
let busy = false;
let revision = 0;

// Register before loading dependencies so every request receives a response,
// including requests sent while an imported script fails to initialize.
self.onmessage = event => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1) return;
  if (requests.length >= 64) {
    respondError(message.id, Object.assign(new Error('The local search queue is full.'), { name: 'QueueFullError' }));
    return;
  }
  requests.push(message);
  drain();
};

try {
  importScripts('vendor/minisearch/SearchableMap.js');
  // The official standalone UMD build exports SearchableMap as MiniSearch.
  self.NotejectRadixMap = self.MiniSearch;
  importScripts('smart-search.js');
  if (!self.NotejectSmartSearch || typeof self.NotejectSmartSearch.create !== 'function') {
    throw new Error('The local search index could not be loaded.');
  }
  index = self.NotejectSmartSearch.create([]);
} catch (error) {
  bootError = error;
}

function stats() {
  const details = index && typeof index.getStats === 'function' ? index.getStats() : {};
  return { ...details, sourceCount: sourceMap.size, syncRevision: revision, worker: true };
}

function respondError(id, error) {
  self.postMessage({ id, error: { name: String(error && error.name || 'Error'), message: String(error && error.message || 'Local search failed.') } });
}

// Search results carry references and ranking details. The UI already holds
// source text; sending it back would clone entire books for every keystroke.
function excerpt(body, terms, limit) {
  const text = String(body || '');
  if (!text || !limit) return '';
  const words = [...new Set((Array.isArray(terms) ? terms : []).map(String).filter(word => word.length >= 2).slice(0, 64))];
  const pattern = words.map(word => word.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = pattern ? new RegExp(pattern, 'iu').exec(text) : null;
  const start = Math.max(0, (match ? match.index : 0) - Math.floor(limit / 3));
  const end = Math.min(text.length, start + limit * 4);
  const preview = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const prefix = start ? '…' : '';
  const truncated = end < text.length || preview.length + prefix.length > limit;
  const suffix = truncated ? '…' : '';
  return prefix + preview.slice(0, Math.max(0, limit - prefix.length - suffix.length)) + suffix;
}

function reference(source, previewOptions) {
  if (!source || typeof source !== 'object') return null;
  const output = {};
  for (const field of ['key', 'kind', 'id', 'boardId', 'title', 'folder', 'type', 'updated', 'created', 'indexed', 'isHighlight', 'archived', 'score']) {
    const value = source[field];
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (value !== undefined) output[field] = value;
    }
  }
  for (const field of ['tags', 'reasons', 'matchedTerms']) {
    if (Array.isArray(source[field])) output[field] = source[field].filter(value => ['string', 'number', 'boolean'].includes(typeof value));
  }
  if (previewOptions) {
    const terms = [...(Array.isArray(source.matchedTerms) ? source.matchedTerms : []), ...(String(previewOptions.query || '').match(/[\p{L}\p{N}]{2,}/gu) || [])];
    const body = source.body || sourceMap.get(source.key)?.body;
    output.snippet = excerpt(body, terms, 280);
    const contextLimit = Math.min(9500, Math.max(0, Math.floor(Number(previewOptions.contextLimit) || 0)));
    if (contextLimit) output.context = excerpt(body, terms, contextLimit);
  }
  return output;
}

function validSource(source) {
  return source && typeof source === 'object' && source.id != null;
}

function sourceKey(source) {
  return self.NotejectSmartSearch.key(source);
}

function remember(sources) {
  const next = new Map();
  for (const source of sources) {
    if (!validSource(source)) continue;
    const key = sourceKey(source);
    if (!next.has(key)) next.set(key, source);
  }
  return next;
}

function updateSources(next) {
  sourceMap.clear();
  for (const [key, source] of next) sourceMap.set(key, source);
}

async function execute(message) {
  if (bootError) throw bootError;
  const args = message.args && typeof message.args === 'object' ? message.args : {};
  switch (message.type) {
    case 'sync': {
      if (!Array.isArray(args.sources)) throw new TypeError('Search sources must be an array.');
      const next = remember(args.sources);
      if (typeof index.sync === 'function') await index.sync([...next.values()]);
      else index = self.NotejectSmartSearch.create([...next.values()]);
      updateSources(next);
      revision++;
      return { sourceCount: sourceMap.size, syncRevision: revision };
    }
    case 'syncDelta': {
      if (!Array.isArray(args.upserts) || !Array.isArray(args.removals)) throw new TypeError('Search changes must contain source and removal arrays.');
      const next = new Map(sourceMap);
      for (const key of args.removals) if (typeof key === 'string') next.delete(key);
      const changed = remember(args.upserts);
      for (const [key, source] of changed) next.set(key, source);
      if (typeof index.syncDelta === 'function') await index.syncDelta([...changed.values()], args.removals.filter(key => typeof key === 'string'));
      else if (typeof index.upsert === 'function' && typeof index.remove === 'function') {
        // Removal before insertion also handles replacing a source in one batch.
        for (const key of args.removals) if (typeof key === 'string') await index.remove(key);
        for (const source of changed.values()) await index.upsert(source);
      } else if (typeof index.sync === 'function') await index.sync([...next.values()]);
      else index = self.NotejectSmartSearch.create([...next.values()]);
      updateSources(next);
      revision++;
      return { sourceCount: sourceMap.size, syncRevision: revision };
    }
    case 'search': {
      const { contextLimit, ...options } = args.options || {};
      const query = String(args.query || '');
      return (await index.search(query, options)).map(source => reference(source, { query, contextLimit }));
    }
    case 'related':
      return (await index.related(String(args.key || ''), args.options || {})).map(source => reference(source, {}));
    case 'summarize': {
      const selected = (Array.isArray(args.keys) ? args.keys : []).map(key => sourceMap.get(key)).filter(Boolean);
      return index.summarize(selected, args.options || {});
    }
    case 'suggestTags':
      return index.suggestTags(String(args.key || ''), args.options || {});
    case 'insights': {
      const result = await index.insights();
      return {
        ...result,
        duplicateGroups: (result.duplicateGroups || []).map(group => ({ title: group.title, reason: group.reason, sources: (group.sources || []).map(source => reference(source)) })),
        missingIndexedDocuments: (result.missingIndexedDocuments || []).map(source => reference(source))
      };
    }
    case 'getStats':
      return stats();
    default:
      throw new Error('Unknown local search request.');
  }
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (requests.length) {
      const message = requests.shift();
      try {
        const result = await execute(message);
        self.postMessage({ id: message.id, result, stats: stats() });
      } catch (error) {
        respondError(message.id, error);
      }
    }
  } finally {
    busy = false;
  }
}
