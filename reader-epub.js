/* EPUB package metadata and the book's own contents navigation. */
(function (root) {
  'use strict';

  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const EPUB_NS = 'http://www.idpf.org/2007/ops';
  const localName = node => String(node?.localName || node?.nodeName || '').split(':').pop().toLowerCase();
  const children = (node, name) => [...(node?.children || [])].filter(child => localName(child) === name);
  const descendants = (node, name) => [...(node?.getElementsByTagName?.('*') || [])].filter(child => localName(child) === name);
  const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
  const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
  const tokenList = value => String(value || '').toLowerCase().split(/\s+/).filter(Boolean);

  function canonicalPath(value) {
    const parts = [];
    for (const part of decode(String(value || '').replace(/\\/g, '/')).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  }

  function resolveTarget(base, href) {
    const raw = String(href || '').trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
    const hashAt = raw.indexOf('#');
    const anchor = hashAt >= 0 ? decode(raw.slice(hashAt + 1)) : '';
    const pathname = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).split('?')[0];
    const basePath = String(base || '').replace(/\\/g, '/');
    const directory = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
    return { path: pathname ? canonicalPath(pathname.startsWith('/') ? pathname : directory + pathname) : canonicalPath(basePath), anchor };
  }

  function elementBase(element, documentPath) {
    const ancestors = [];
    for (let node = element; node?.nodeType === 1; node = node.parentElement) ancestors.unshift(node);
    let base = documentPath;
    for (const ancestor of ancestors) {
      const value = ancestor.getAttributeNS?.(XML_NS, 'base') || ancestor.getAttribute?.('xml:base');
      if (!value) continue;
      const target = resolveTarget(base, value);
      if (target) base = target.path + (value.endsWith('/') ? '/' : '');
    }
    return base;
  }

  function parseXml(source) {
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (descendants(document, 'parsererror').length) throw Error('The EPUB navigation document is malformed.');
    return document;
  }

  async function defaultReadText(zip, path) {
    if (typeof root.zipText === 'function') return root.zipText(zip, path);
    const key = canonicalPath(path);
    const entry = zip.get(key) || [...zip.entries()].find(([name]) => canonicalPath(name) === key)?.[1];
    if (!entry) throw Error('Missing EPUB entry ' + key);
    if (typeof entry === 'string') return entry;
    if (entry instanceof Blob) return entry.text();
    let bytes;
    if (entry instanceof Uint8Array || entry instanceof ArrayBuffer) bytes = entry;
    else if (entry.method === 0) bytes = entry.compressed;
    else if (entry.method === 8) {
      const stream = new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = await new Response(stream).arrayBuffer();
    } else throw Error('Unsupported EPUB navigation compression.');
    const prefix = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(bytes.byteLength, 160));
    const declaration = new TextDecoder().decode(prefix).match(/<\?xml[^>]*encoding\s*=\s*['"]([^'"]+)/i)?.[1];
    try { return new TextDecoder(declaration || 'utf-8').decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  }

  function fallbackLabel(entry, index) {
    const supplied = entry?.label || entry?.title;
    if (supplied) return String(supplied);
    const name = canonicalPath(entry?.path).split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    return /^(?:cover|title|titlepage|copyright|contents|toc|index|preface|introduction)$/i.test(name) ? name[0].toUpperCase() + name.slice(1) : 'Section ' + (index + 1);
  }

  function flatten(items) {
    const output = [];
    const visit = (list, depth) => { for (const item of list || []) { output.push({ ...item, depth }); if (item.children?.length) visit(item.children, depth + 1); } };
    visit(items, 0);
    return output;
  }

  async function navigation(zip, spineEntries, options = {}) {
    const spine = Array.isArray(spineEntries) ? spineEntries : [];
    const spineIndex = new Map(spine.map((entry, index) => [canonicalPath(entry.path), index]));
    const fallbackItems = spine.map((entry, index) => ({ label: fallbackLabel(entry, index), path: canonicalPath(entry.path), anchor: '', index }));
    const result = { title: '', author: '', language: '', direction: '', items: fallbackItems, flatItems: fallbackItems.map(item => ({ ...item, depth: 0 })), spineLabels: fallbackItems.map(item => item.label) };
    if (!zip?.get || !spine.length) return result;
    const readText = options.readText || defaultReadText;
    const cached = new Map();
    const read = path => { const key = canonicalPath(path); if (!cached.has(key)) cached.set(key, Promise.resolve().then(() => readText(zip, key))); return cached.get(key); };
    let opf, opfPath;
    try {
      const container = parseXml(await read('META-INF/container.xml'));
      const rootfiles = descendants(container, 'rootfile');
      const rootfile = rootfiles.find(node => /oebps-package\+xml/i.test(node.getAttribute('media-type') || '')) || rootfiles[0];
      opfPath = canonicalPath(rootfile?.getAttribute('full-path'));
      if (!opfPath) return result;
      opf = parseXml(await read(opfPath));
    } catch { return result; }

    const metadata = descendants(opf, 'metadata')[0];
    result.title = text(descendants(metadata, 'title')[0]);
    result.author = descendants(metadata, 'creator').map(text).filter(Boolean).join(', ');
    result.language = text(descendants(metadata, 'language')[0]);
    const spineNode = descendants(opf, 'spine')[0];
    result.direction = spineNode?.getAttribute('page-progression-direction') || '';
    const manifest = descendants(opf, 'manifest')[0];
    const manifestItems = descendants(manifest, 'item').map(element => ({
      id: element.getAttribute('id'),
      target: resolveTarget(elementBase(element, opfPath), element.getAttribute('href')),
      type: String(element.getAttribute('media-type') || '').toLowerCase(),
      properties: tokenList(element.getAttribute('properties'))
    })).filter(item => item.target);
    const candidates = [];
    for (const item of manifestItems.filter(item => item.properties.includes('nav'))) candidates.push({ path: item.target.path, kind: 'html' });
    const ncxId = spineNode?.getAttribute('toc');
    const ncx = manifestItems.find(item => item.id === ncxId) || manifestItems.find(item => item.type === 'application/x-dtbncx+xml');
    if (ncx) candidates.push({ path: ncx.target.path, kind: 'ncx' });
    for (const reference of descendants(opf, 'reference').filter(node => tokenList(node.getAttribute('type')).includes('toc'))) {
      const target = resolveTarget(elementBase(reference, opfPath), reference.getAttribute('href'));
      if (target) candidates.push({ path: target.path, kind: 'html' });
    }
    if (!ncx) for (const path of zip.keys()) if (/\.ncx$/i.test(path)) { candidates.push({ path: canonicalPath(path), kind: 'ncx' }); break; }

    let count = 0;
    const makeItem = (label, raw, base, descendants) => {
      const target = resolveTarget(base, raw);
      const index = target ? (spineIndex.get(target.path) ?? -1) : -1;
      const nested = descendants?.filter(Boolean) || [];
      if (index < 0 && !nested.length) return null;
      return { label: label || (index >= 0 ? result.spineLabels[index] : 'Contents'), path: target?.path || '', anchor: target?.anchor || '', index, ...(nested.length ? { children: nested } : {}) };
    };
    const readHtmlList = (list, path, depth = 0) => {
      if (!list || depth > 20) return [];
      return children(list, 'li').map(li => {
        if (++count > 5000) return null;
        const labelNode = [...li.children].find(node => ['a', 'span'].includes(localName(node))) || [...li.children].find(node => !['ol', 'ul'].includes(localName(node)));
        const link = localName(labelNode) === 'a' ? labelNode : descendants(labelNode, 'a')[0];
        const nested = [...children(li, 'ol'), ...children(li, 'ul')].flatMap(child => readHtmlList(child, path, depth + 1));
        return makeItem(text(labelNode), link?.getAttribute('href'), elementBase(link || li, path), nested);
      }).filter(Boolean);
    };
    const readNcxList = (parent, path, depth = 0) => {
      if (!parent || depth > 20) return [];
      return children(parent, 'navpoint').map(point => {
        if (++count > 5000) return null;
        const content = children(point, 'content')[0];
        return makeItem(text(children(point, 'navlabel')[0]), content?.getAttribute('src'), elementBase(content || point, path), readNcxList(point, path, depth + 1));
      }).filter(Boolean);
    };

    const tried = new Set();
    for (const candidate of candidates) {
      if (tried.has(candidate.path)) continue;
      tried.add(candidate.path);
      try {
        const source = await read(candidate.path);
        let document;
        try { document = parseXml(source); } catch { if (candidate.kind === 'ncx') continue; document = new DOMParser().parseFromString(source, 'text/html'); }
        count = 0;
        let items;
        if (candidate.kind === 'ncx') {
          items = readNcxList(descendants(document, 'navmap')[0], candidate.path);
          result.title ||= text(descendants(document, 'doctitle')[0]);
          result.author ||= text(descendants(document, 'docauthor')[0]);
        } else {
          const navs = descendants(document, 'nav');
          const nav = navs.find(node => tokenList(node.getAttributeNS?.(EPUB_NS, 'type') || node.getAttribute('epub:type')).includes('toc')) || navs.find(node => tokenList(node.getAttribute('role')).includes('doc-toc')) || navs[0];
          const list = nav ? [...children(nav, 'ol'), ...children(nav, 'ul')][0] || descendants(nav, 'ol')[0] : descendants(document, 'ol')[0] || descendants(document, 'ul')[0];
          items = readHtmlList(list, candidate.path);
          if (!items.length && !nav) items = descendants(document, 'a').map(link => makeItem(text(link), link.getAttribute('href'), elementBase(link, candidate.path), [])).filter(Boolean);
        }
        const flatItems = flatten(items);
        if (!flatItems.some(item => item.index >= 0)) continue;
        result.items = items;
        result.flatItems = flatItems;
        for (let index = 0; index < spine.length; index++) {
          const target = flatItems.find(item => item.index === index && !item.anchor) || flatItems.find(item => item.index === index);
          if (target?.label) result.spineLabels[index] = target.label;
        }
        break;
      } catch { /* An optional contents file must not stop a readable EPUB opening. */ }
    }
    return result;
  }

  function normalizePreferences(value = {}) {
    value = value && typeof value === 'object' ? value : {};
    const finite = (number, fallback, min, max) => Number.isFinite(Number(number)) ? Math.min(max, Math.max(min, Number(number))) : fallback;
    return {
      fontSize: finite(value.fontSize, 18, 12, 32),
      lineHeight: finite(value.lineHeight, 1.75, 1.2, 2.4),
      theme: ['paper', 'sepia', 'night'].includes(value.theme) ? value.theme : 'paper',
      width: ['narrow', 'comfortable', 'wide'].includes(value.width) ? value.width : 'comfortable',
      font: ['serif', 'sans'].includes(value.font) ? value.font : 'serif'
    };
  }

  root.NotejectEpubReader = Object.freeze({ navigation, flatten, canonicalPath, resolveTarget, normalizePreferences });
})(typeof window === 'undefined' ? globalThis : window);
