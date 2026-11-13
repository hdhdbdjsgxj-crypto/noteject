(function (root, factory) {
  'use strict';
  let RadixMap = root && (root.NotejectRadixMap || root.MiniSearch);
  if (typeof module === 'object' && module.exports) {
    try { RadixMap = require('./vendor/minisearch/SearchableMap.js'); } catch (_) { /* Compatibility for standalone copies. */ }
  }
  const api = factory(RadixMap);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectSmartSearch = api;
})(typeof globalThis === 'object' ? globalThis : this, function (RadixMap) {
  'use strict';

  // This index is entirely local. Search uses postings built once, never a scan
  // of every document's text for each keystroke.
  const STOP = new Set(('a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its itself just may me might more most my no nor not of on once only or our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours please find show tell give looking look search get all any about across inside within document documents file files note notes board boards chapter chapters figure figures section sections page pages summarize summarise summary explain compare').split(/\s+/));
  const SYNONYMS = [
    ['start', 'begin', 'commence'], ['finish', 'complete', 'completion'],
    ['create', 'make', 'build'], ['delete', 'remove'], ['folder', 'directory'],
    ['image', 'photo', 'picture'], ['task', 'todo'], ['smart', 'intelligent'],
    ['connect', 'connection', 'link', 'relate', 'relationship'],
    ['color', 'colour'], ['organize', 'organise', 'organization', 'organisation'],
    ['car', 'automobile'], ['backup', 'backups'], ['offline', 'local']
  ];
  const alias = new Map();
  const silentE = new Set(['creat', 'mak', 'sav', 'mov', 'writ', 'delet', 'us', 'chang', 'tak', 'giv', 'hav', 'organiz', 'organis', 'complet', 'relat', 'shar', 'clos', 'compar']);
  const stem = word => {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 4 && word.endsWith('ied')) return word.slice(0, -3) + 'y';
    if (word.length > 5 && word.endsWith('ing')) {
      let base = word.slice(0, -3);
      if (/([bdgmnprt])\1$/.test(base)) base = base.slice(0, -1);
      return silentE.has(base) ? base + 'e' : base;
    }
    if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed')) {
      let base = word.slice(0, -2);
      if (/([bdgmnprt])\1$/.test(base)) base = base.slice(0, -1);
      return silentE.has(base) ? base + 'e' : base;
    }
    if (word.length > 4 && /(?:ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is|ics|ous)$/.test(word)) return word.slice(0, -1);
    return word;
  };
  for (const group of SYNONYMS) for (const word of group) alias.set(stem(word), stem(group[0]));
  const normal = value => String(value == null ? '' : value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const canonical = word => {
    const value = stem(word.replace(/['’]s$/, ''));
    return alias.get(value) || value;
  };
  function tokenize(value) {
    const words = normal(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
    const result = [];
    for (const word of words) {
      if (STOP.has(word)) continue;
      const token = canonical(word);
      if (token.length > 1 && !STOP.has(token)) result.push(token);
    }
    return result;
  }
  function key(source) {
    if (!source) return '';
    return source.kind === 'connection'
      ? 'connection:' + String(source.boardId || '') + ':' + String(source.id)
      : String(source.kind || 'note') + ':' + String(source.id);
  }
  const tagsOf = value => (Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/)).map(tag => String(tag).replace(/^#/, '').trim()).filter(Boolean);
  const updated = source => typeof source.updated === 'number' ? source.updated : (Date.parse(source.updated) || 0);
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function fingerprint(text) {
    let first = 2166136261, second = 5381;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second, 33) ^ code;
    }
    return text.length + ':' + (first >>> 0) + ':' + (second >>> 0);
  }
  const bound = (value, fallback, maximum) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(maximum, Math.floor(Number(value)))) : fallback;
  function oneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let left = 0, right = 0, edits = 0;
    while (left < a.length && right < b.length) {
      if (a[left] === b[right]) { left++; right++; continue; }
      if (++edits > 1) return false;
      if (a.length === b.length && a[left] === b[right + 1] && a[left + 1] === b[right]) { left += 2; right += 2; }
      else if (a.length > b.length) left++;
      else if (a.length < b.length) right++;
      else { left++; right++; }
    }
    return edits + Number(left < a.length || right < b.length) <= 1;
  }
  function hasPosition(values, value) {
    let low = 0, high = values.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (values[mid] === value) return true;
      if (values[mid] < value) low = mid + 1; else high = mid - 1;
    }
    return false;
  }
  function phraseIn(positions, phrase) {
    const lists = phrase.map(term => positions.get(term));
    if (lists.some(list => !list)) return false;
    let anchor = 0;
    for (let i = 1; i < lists.length; i++) if (lists[i].length < lists[anchor].length) anchor = i;
    return lists[anchor].some(position => lists.every((list, index) => index === anchor || hasPosition(list, position + index - anchor)));
  }
  function create(input) {
    const radix = typeof RadixMap === 'function' && typeof RadixMap.prototype.atPrefix === 'function' && typeof RadixMap.prototype.fuzzyGet === 'function';
    const records = [], byKey = new Map(), postings = radix ? new RadixMap() : new Map(), lengths = new Map(), links = new Map();
    let vocabulary = [], vocabularyDirty = true, totalSize = 0, averageSize = 12, termCount = 0;
    const counters = { added: 0, updated: 0, removed: 0, revision: 0 };

    // Capture mutable arrays before the application edits them again. The body
    // is compared exactly, so equal-length corrections cannot keep old terms.
    function capture(source) {
      const value = { ...source, tags: tagsOf(source.tags), linkedKeys: Array.isArray(source.linkedKeys) ? [...new Set(source.linkedKeys.map(String))].sort(compareText) : [] };
      value.body = String(source.body == null ? '' : source.body);
      const metadata = Object.keys(value).filter(name => name !== 'body').sort(compareText).map(name => [name, value[name]]);
      return { value, signature: JSON.stringify(metadata) };
    }
    function makeRecord(captured, sourceKey, index) {
      const source = captured.value;
      const record = { source, signature: captured.signature, key: sourceKey, index, terms: new Map(), positions: {}, tags: source.tags.slice(), size: 0, titleSize: 0 };
      const fields = { title: source.title, tags: record.tags.join(' '), folder: source.folder, type: source.type, body: source.body };
      for (const [field, value] of Object.entries(fields)) {
        const tokens = tokenize(value), positions = new Map();
        if (field === 'body') record.size = tokens.length;
        if (field === 'title') record.titleSize = tokens.length;
        for (let position = 0; position < tokens.length; position++) {
          const term = tokens[position];
          if (!record.terms.has(term)) record.terms.set(term, { title: 0, tags: 0, folder: 0, type: 0, body: 0 });
          record.terms.get(term)[field]++;
          if (field === 'title' || field === 'body') {
            if (!positions.has(term)) positions.set(term, []);
            positions.get(term).push(position);
          }
        }
        if (field === 'title' || field === 'body') record.positions[field] = positions;
      }
      return record;
    }
    function attach(record) {
      records[record.index] = record;
      byKey.set(record.key, record);
      totalSize += record.size;
      for (const [term, counts] of record.terms) {
        if (!postings.has(term)) {
          postings.set(term, new Map());
          termCount++;
          if (!radix) {
            if (!lengths.has(term.length)) lengths.set(term.length, new Set());
            lengths.get(term.length).add(term);
          }
          vocabularyDirty = true;
        }
        postings.get(term).set(record.index, counts);
      }
    }
    function detach(record) {
      totalSize -= record.size;
      byKey.delete(record.key);
      records[record.index] = null;
      for (const term of record.terms.keys()) {
        const list = postings.get(term);
        list.delete(record.index);
        if (list.size) continue;
        postings.delete(term);
        termCount--;
        if (!radix) {
          const group = lengths.get(term.length);
          group.delete(term);
          if (!group.size) lengths.delete(term.length);
        }
        vocabularyDirty = true;
      }
    }
    function put(source) {
      if (!source || source.id == null) return false;
      const sourceKey = key(source), previous = byKey.get(sourceKey), captured = capture(source);
      if (previous && previous.source.body === captured.value.body && previous.signature === captured.signature) return false;
      const value = captured.value;
      const sameText = previous && ['title', 'folder', 'type', 'body'].every(field => previous.source[field] === value[field]) && previous.tags.length === value.tags.length && previous.tags.every((tag, at) => tag === value.tags[at]);
      if (sameText) {
        // Timestamp, archive, and link changes reuse all token frequencies and
        // phrase positions instead of parsing the book again.
        previous.source = value;
        previous.signature = captured.signature;
        counters.updated++;
        counters.revision++;
        return true;
      }
      // Build before detaching so a malformed source cannot damage old data.
      const record = makeRecord(captured, sourceKey, previous ? previous.index : records.length);
      if (previous) detach(previous);
      attach(record);
      counters[previous ? 'updated' : 'added']++;
      counters.revision++;
      return true;
    }
    function drop(sourceKey) {
      const record = byKey.get(typeof sourceKey === 'string' ? sourceKey : key(sourceKey));
      if (!record) return false;
      detach(record);
      counters.removed++;
      counters.revision++;
      return true;
    }
    function settle() {
      averageSize = Math.max(12, totalSize / Math.max(1, byKey.size));
      links.clear();
      for (const record of byKey.values()) {
        for (const target of record.source.linkedKeys) {
          if (!byKey.has(target) || target === record.key) continue;
          if (!links.has(record.key)) links.set(record.key, new Set());
          if (!links.has(target)) links.set(target, new Set());
          links.get(record.key).add(target); links.get(target).add(record.key);
        }
      }
    }
    function sync(nextSources) {
      if (!Array.isArray(nextSources)) throw new TypeError('Search sources must be an array.');
      const seen = new Set();
      let changed = false;
      for (const source of nextSources) {
        if (!source || source.id == null) continue;
        const sourceKey = key(source);
        if (seen.has(sourceKey)) continue;
        seen.add(sourceKey);
        changed = put(source) || changed;
      }
      for (const sourceKey of [...byKey.keys()]) if (!seen.has(sourceKey)) changed = drop(sourceKey) || changed;
      if (changed) settle();
      return getStats();
    }
    function upsert(source) {
      const changed = put(source);
      if (changed) settle();
      return changed;
    }
    function syncDelta(upserts = [], removals = []) {
      if (!Array.isArray(upserts) || !Array.isArray(removals)) throw new TypeError('Search changes must be arrays.');
      let changed = false;
      for (const sourceKey of removals) changed = drop(sourceKey) || changed;
      for (const source of upserts) changed = put(source) || changed;
      if (changed) settle();
      return getStats();
    }
    function remove(sourceKey) {
      const changed = drop(sourceKey);
      if (changed) settle();
      return changed;
    }
    function getStats() {
      return { sourceCount: byKey.size, termCount, ...counters, lookupEngine: radix ? 'MiniSearch radix tree' : 'Map' };
    }
    function prefixes(prefix) {
      if (radix) {
        const matches = [];
        for (const term of postings.atPrefix(prefix).keys()) {
          // Vendor iteration follows insertion order. Keep the lexically first
          // 24 terms without retaining a potentially large prefix branch.
          if (matches.length === 24 && term >= matches[23]) continue;
          let low = 0, high = matches.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (matches[middle] < term) low = middle + 1; else high = middle;
          }
          matches.splice(low, 0, term);
          if (matches.length > 24) matches.pop();
        }
        return matches;
      }
      if (vocabularyDirty) { vocabulary = [...postings.keys()].sort(compareText); vocabularyDirty = false; }
      let low = 0, high = vocabulary.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (vocabulary[middle] < prefix) low = middle + 1; else high = middle;
      }
      const matches = [];
      for (let i = low; i < vocabulary.length && matches.length < 24 && vocabulary[i].startsWith(prefix); i++) matches.push(vocabulary[i]);
      return matches;
    }
    function closeTerms(word) {
      // Exact and prefix lookup remain available for long identifiers. Avoid
      // allocating a quadratic Levenshtein matrix for pasted hashes or data.
      if (word.length > 64) return [];
      const nearby = new Set();
      if (radix) {
        // Levenshtein distance one prunes the trie. Adjacent swaps are added
        // explicitly to preserve the existing transposition correction policy.
        for (const term of postings.fuzzyGet(word, 1).keys()) if (oneEdit(word, term)) nearby.add(term);
        for (let at = 0; at < word.length - 1; at++) {
          if (word[at] === word[at + 1]) continue;
          const swapped = word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
          if (postings.has(swapped) && oneEdit(word, swapped)) nearby.add(swapped);
        }
      } else {
        for (const size of [word.length - 1, word.length, word.length + 1]) for (const term of lengths.get(size) || []) if (oneEdit(word, term)) nearby.add(term);
      }
      return [...nearby].sort((a, b) => (postings.get(b).size - postings.get(a).size) || compareText(a, b)).slice(0, 8);
    }
    sync(Array.isArray(input) ? input : []);
    const idf = term => Math.log(1 + (byKey.size - (postings.get(term)?.size || 0) + 0.5) / ((postings.get(term)?.size || 0) + 0.5));
    function eligible(record, kind, folder) {
      if (!record || record.source.archived) return false;
      if (kind === 'highlight' && !(record.source.kind === 'note' && record.source.isHighlight)) return false;
      if (kind === 'note' && !(record.source.kind === 'note' && !record.source.isHighlight)) return false;
      if (kind !== 'all' && kind !== 'highlight' && kind !== 'note' && record.source.kind !== kind) return false;
      return folder === 'all' || String(record.source.folder || 'Inbox') === String(folder);
    }
    const result = (record, score, reasons, matchedTerms = []) => ({ ...record.source, key: record.key, score: Number(score.toFixed(6)), reasons, matchedTerms });
    const sortResults = (a, b) => b.score - a.score || updated(b) - updated(a) || compareText(normal(a.title), normal(b.title)) || compareText(a.key, b.key);
    function search(query, { kind = 'all', folder = 'all', limit = 12 } = {}) {
      const tokens = tokenize(query), maximum = bound(limit, 12, 200), words = [...new Set(tokens)], lastWord = tokens[tokens.length - 1];
      if (!maximum) return [];
      if (!words.length) return [...byKey.values()].filter(record => eligible(record, kind, folder)).map(record => result(record, 0, ['Recently updated'])).sort(sortResults).slice(0, maximum);
      const candidates = new Map();
      for (const word of words) {
        let alternatives = postings.has(word) ? [{ term: word, weight: 1 }] : [];
        if (!alternatives.length && word === lastWord && word.length >= 3) alternatives = prefixes(word).map(term => ({ term, weight: 0.82, prefix: true }));
        if (!alternatives.length && word.length >= 4) {
          alternatives = closeTerms(word).map(term => ({ term, weight: 0.67 }));
        }
        for (const { term, weight, prefix } of alternatives) {
          for (const [index, counts] of postings.get(term) || []) {
            const record = records[index];
            if (!eligible(record, kind, folder)) continue;
            if (!candidates.has(index)) candidates.set(index, { score: 0, words: new Set(), terms: new Set(), title: false, tags: false, body: false, fuzzy: [], prefixes: [] });
            const match = candidates.get(index), k = 1.2, lengthFactor = 0.25 + 0.75 * record.size / averageSize;
            const derivedBodyWeight = record.source.kind === 'connection' ? 0.4 : record.source.kind === 'board' ? 0.65 : 1;
            const body = counts.body ? derivedBodyWeight * counts.body * (k + 1) / (counts.body + k * lengthFactor) : 0;
            const titleLength = 0.75 + 0.25 * Math.max(1, record.titleSize / words.length);
            const title = counts.title ? 3.4 * counts.title * (k + 1) / (counts.title + k * titleLength) : 0;
            const tags = counts.tags ? 3.8 * counts.tags / (counts.tags + 0.6) : 0;
            match.score += idf(term) * weight * (body + title + tags + 0.55 * Math.min(1, counts.folder) + 0.25 * Math.min(1, counts.type));
            match.words.add(word); match.terms.add(term);
            match.title ||= counts.title > 0; match.tags ||= counts.tags > 0; match.body ||= counts.body > 0;
            if (prefix) match.prefixes.push(word + ' → ' + term);
            else if (weight < 1) match.fuzzy.push(word + ' → ' + term);
          }
        }
      }
      const phrase = tokenize(query), output = [];
      for (const [index, match] of candidates) {
        const record = records[index], reasons = [];
        match.score += 3 * match.words.size / words.length;
        if (match.words.size === words.length && words.length > 1) match.score += 1.5;
        if (match.title) reasons.push('Title match');
        if (match.tags) reasons.push('Tag match');
        if (match.body) reasons.push(record.source.kind === 'document' ? 'Matching document text' : 'Matching text');
        if (phrase.length >= 2 && phrase.length <= 14 && (phraseIn(record.positions.title, phrase) || phraseIn(record.positions.body, phrase))) {
          match.score += 3.5; reasons.unshift('Matching phrase');
        }
        if (match.fuzzy.length) reasons.push('Close spelling: ' + [...new Set(match.fuzzy)].join(', '));
        if (match.prefixes.length) reasons.push('Word beginning: ' + [...new Set(match.prefixes)].join(', '));
        if (!reasons.length) reasons.push('Project or file type match');
        // Boards and connections often inherit the titles of their source
        // cards. Keep primary content ahead for equal wording while retaining
        // strong title matches for a connector's own distinctive name.
        if (record.source.kind === 'connection') match.score *= 0.82;
        else if (record.source.kind === 'board') match.score *= 0.9;
        output.push(result(record, match.score, reasons, [...match.terms]));
      }
      return output.sort(sortResults).slice(0, maximum);
    }
    function related(sourceKey, { limit = 6 } = {}) {
      const target = byKey.get(typeof sourceKey === 'string' ? sourceKey : key(sourceKey));
      const maximum = bound(limit, 6, 100);
      if (!target || !maximum) return [];
      const targetTags = new Set(target.tags.map(normal));
      const topics = [...target.terms].map(([term, counts]) => ({ term, value: idf(term) * (3 * counts.title + 4 * counts.tags + Math.sqrt(counts.body)) })).filter(item => item.value > 0 && (idf(item.term) > 0.2 || byKey.size < 6)).sort((a, b) => b.value - a.value || compareText(a.term, b.term)).slice(0, 36);
      const candidates = new Map();
      const ensure = index => {
        if (!candidates.has(index)) candidates.set(index, { score: 0, terms: [], linked: false });
        return candidates.get(index);
      };
      for (const { term, value } of topics) {
        for (const [index, counts] of postings.get(term) || []) {
          const record = records[index];
          if (record === target || !eligible(record, 'all', 'all')) continue;
          const item = ensure(index);
          item.score += Math.min(6, value) * idf(term) * (1 + Number(counts.title > 0) + Number(counts.tags > 0));
          item.terms.push(term);
        }
      }
      for (const linkedKey of links.get(target.key) || []) {
        const record = byKey.get(linkedKey);
        if (!record || !eligible(record, 'all', 'all')) continue;
        const item = ensure(record.index);
        item.score += 20; item.linked = true;
      }
      return [...candidates].map(([index, match]) => {
        const record = records[index], reasons = [];
        const sharedTags = record.tags.filter(tag => targetTags.has(normal(tag)));
        if (match.linked) reasons.push('Linked in your workspace');
        if (sharedTags.length) { match.score += 8 * sharedTags.length; reasons.push('Shared tags: ' + sharedTags.slice(0, 3).join(', ')); }
        if (match.terms.length) reasons.push('Shared topics: ' + match.terms.slice(0, 4).join(', '));
        return result(record, match.score, reasons, match.terms.slice(0, 8));
      }).sort(sortResults).slice(0, maximum);
    }
    function summarize(selectedSources, { maxSentences = 5 } = {}) {
      const maximum = bound(maxSentences, 5, 20);
      if (!maximum) return { text: '', sentences: [], sourceKeys: [] };
      const chosen = [], seenSources = new Set();
      for (const source of Array.isArray(selectedSources) ? selectedSources : []) {
        const sourceKey = typeof source === 'string' ? source : key(source);
        const record = byKey.get(sourceKey);
        if (record && !seenSources.has(sourceKey)) { chosen.push(record); seenSources.add(sourceKey); }
      }
      const candidates = [], seenSentences = new Set();
      const segmenter = typeof Intl === 'object' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;
      chosen.forEach((record, sourceIndex) => {
        const body = String(record.source.body || '').replace(/<[^>]*>/g, ' ').replace(/^\s{0,3}(?:#{1,6}\s+|[-*•]\s+)/gm, '').replace(/[ \t]+/g, ' ');
        const sentences = segmenter ? [...segmenter.segment(body)].map(part => part.segment) : (body.match(/[^.!?]+(?:[.!?]+(?:\s|$)|$)/g) || []);
        sentences.forEach((value, position) => {
          const text = value.replace(/\s+/g, ' ').trim(), signature = normal(text).replace(/[^\p{L}\p{N}]+/gu, ' ');
          if (text.length < 25 || text.length > 1400 || seenSentences.has(signature)) return;
          const terms = [...new Set(tokenize(text))];
          if (terms.length < 4) return;
          seenSentences.add(signature);
          const weight = terms.reduce((sum, term) => {
            const counts = record.terms.get(term);
            return sum + idf(term) * (1 + Math.min(2, Math.log1p(counts?.body || 0)) + 1.3 * Number((counts?.title || 0) > 0));
          }, 0) / Math.sqrt(terms.length);
          candidates.push({ text, sourceKey: record.key, title: record.source.title || 'Untitled', sourceIndex, position, score: weight, terms: new Set(terms) });
        });
      });
      const picked = [], usedSources = new Set();
      while (picked.length < maximum && candidates.length) {
        let best = -1, bestScore = -Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          let similarity = 0;
          for (const prior of picked) {
            let overlap = 0;
            for (const term of candidate.terms) if (prior.terms.has(term)) overlap++;
            similarity = Math.max(similarity, overlap / (candidate.terms.size + prior.terms.size - overlap));
          }
          if (similarity > 0.86) continue;
          const score = candidate.score * (usedSources.has(candidate.sourceKey) ? 0.65 : 1) * (1 - 0.65 * similarity);
          if (score > bestScore) { best = i; bestScore = score; }
        }
        if (best < 0) break;
        const candidate = candidates.splice(best, 1)[0]; picked.push(candidate); usedSources.add(candidate.sourceKey);
      }
      picked.sort((a, b) => a.sourceIndex - b.sourceIndex || a.position - b.position);
      const sourceKeys = [...new Set(picked.map(item => item.sourceKey))];
      const sentences = picked.map(({ text, sourceKey, title }) => ({ text, sourceKey, title, citation: 'S' + (sourceKeys.indexOf(sourceKey) + 1) }));
      return { text: sentences.map(sentence => sentence.text + ' [' + sentence.citation + ']').join('\n\n'), sentences, sourceKeys };
    }
    function suggestTags(source, { limit = 5 } = {}) {
      const record = byKey.get(typeof source === 'string' ? source : key(source));
      if (!record) return [];
      const existing = new Set(tokenize(record.tags.join(' ')));
      return [...record.terms].filter(([term, counts]) => term.length > 3 && /\p{L}/u.test(term) && !existing.has(term) && (counts.title || counts.body)).map(([term, counts]) => ({ term, score: idf(term) * (3.5 * counts.title + Math.sqrt(counts.body)) })).sort((a, b) => b.score - a.score || compareText(a.term, b.term)).slice(0, bound(limit, 5, 20)).map(item => item.term);
    }
    function insights() {
      const active = [...byKey.values()].filter(record => !record.source.archived), buckets = new Map();
      for (const record of active) {
        if (record.source.kind !== 'note' && record.source.kind !== 'document') continue;
        const body = normal(record.source.body).replace(/\s+/g, ' ').trim();
        const name = normal(record.source.title).replace(/\s+/g, ' ').trim();
        let identity, reason;
        if (body.length >= 40) { identity = record.source.kind + ':body:' + fingerprint(body); reason = 'Same content'; }
        else if (record.source.kind === 'document' && name) { identity = 'document:name:' + name + ':' + normal(record.source.type); reason = 'Same file name'; }
        else continue;
        if (!buckets.has(identity)) buckets.set(identity, { reason, records: [] });
        buckets.get(identity).records.push(record);
      }
      const verified = [];
      for (const group of buckets.values()) {
        if (group.records.length < 2) continue;
        if (group.reason !== 'Same content') { verified.push(group); continue; }
        // Fingerprints keep the initial grouping compact; compare the actual
        // text before reporting a duplicate, even in the event of a collision.
        const exact = new Map();
        for (const record of group.records) {
          const text = normal(record.source.body).replace(/\s+/g, ' ').trim();
          if (!exact.has(text)) exact.set(text, []);
          exact.get(text).push(record);
        }
        for (const matches of exact.values()) if (matches.length > 1) verified.push({ reason: group.reason, records: matches });
      }
      const duplicateGroups = verified.map(group => ({ title: group.records[0].source.title || 'Untitled', reason: group.reason, sources: group.records.map(record => ({ ...record.source, key: record.key })) }));
      const readable = source => ['pdf', 'epub', 'txt', 'doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'].includes(String(source.type || '').toLowerCase()) || /\.(?:pdf|epub|txt|doc|xls|ppt|docx|xlsx|pptx)$/i.test(String(source.title || ''));
      const library = active.filter(record => record.source.kind === 'note' || record.source.kind === 'document');
      return {
        duplicateGroups,
        missingIndexedDocuments: active.filter(record => record.source.kind === 'document' && readable(record.source) && (record.source.indexed === false || !String(record.source.body || '').trim())).map(record => ({ ...record.source, key: record.key })),
        inboxCount: library.filter(record => !record.source.folder || normal(record.source.folder) === 'inbox').length,
        noteCount: active.filter(record => record.source.kind === 'note').length,
        documentCount: active.filter(record => record.source.kind === 'document').length,
        sourceCount: active.length
      };
    }
    return { search, related, summarize, suggestTags, insights, sync, syncDelta, upsert, remove, getStats };
  }
  return { create, tokenize, key };
});
