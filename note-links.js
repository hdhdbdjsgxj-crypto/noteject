/* Note links stay in the note's ordinary text, including exports and backups. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function normalize(value) {
    let text = String(value || '').trim();
    if (!text || text.length > 8000 || /[\u0000-\u0020\u007f<>]/.test(text)) return null;
    if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(text) && !text.includes('://')) text = 'mailto:' + text;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
    try {
      const url = new URL(text);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
      if (['http:', 'https:'].includes(url.protocol) && (!url.hostname || url.username || url.password)) return null;
      if (['mailto:', 'tel:'].includes(url.protocol) && !url.pathname) return null;
      return url.href;
    } catch { return null; }
  }
  const labelText = value => String(value).replace(/\\([\\`*$#>\-\[\]])/g, '$1');
  // New links carry an ID so equal titles in different projects stay distinct.
  // Existing [[Title]] links continue to resolve as before.
  function parseWiki(value) {
    const raw = String(value || '').trim(), match = raw.match(/^note:([^|]+)\|([\s\S]*)$/);
    if (match) try { return { raw, id: decodeURIComponent(match[1]), label: match[2] || 'Untitled note' }; } catch {}
    return { raw, id: null, label: raw };
  }
  function resolveWiki(value, items) {
    const ref = parseWiki(value);
    return (items || []).find(item => ref.id ? String(item.id) === ref.id : String(item.title || item.name || '').trim().toLocaleLowerCase() === ref.label.toLocaleLowerCase()) || null;
  }
  function wikiReference(note) {
    const title = String(note.title || 'Untitled note').replace(/[\[\]\r\n]/g, ' ');
    return 'note:' + encodeURIComponent(note.id) + '|' + title;
  }
  function wikiHtml(value) {
    const ref = parseWiki(value);
    return '<strong class="note-wiki-link" data-note-wiki="' + escape(ref.raw) + '">' + escape(ref.label) + '</strong>';
  }
  function labelHtml(value) {
    const literals = [], nonce = '\uE002' + crypto.randomUUID().replaceAll('-', '') + ':';
    const source = String(value).replace(/\\([\\`*$#>\-\[\]])/g, (_, character) => {
      const key = nonce + literals.length + '\uE003'; literals.push(escape(character)); return key;
    });
    const formatted = escape(source).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return formatted.replace(new RegExp(nonce + '(\\d+)\uE003', 'g'), (_, index) => literals[Number(index)] || '');
  }
  function html(label, value, formatted = false) {
    const href = normalize(value);
    return href ? '<a class="note-hyperlink" data-note-link href="' + escape(href) + '" target="_blank" rel="noopener noreferrer">' + (formatted ? labelHtml(label || href) : escape(label || href)) + '</a>' : escape(label || value);
  }
  function trimBare(value) {
    let text = value.replace(/[.,!?;:]+$/, '');
    for (const [open, close] of [['(', ')'], ['{', '}']]) {
      while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1);
    }
    return text.replace(/[.,!?;:]+$/, '');
  }
  function protect(value) {
    const source = String(value || ''), pieces = [];
    const nonce = '\uE000link' + crypto.randomUUID().replaceAll('-', '') + ':';
    const token = content => { const key = nonce + pieces.length + '\uE001'; pieces.push(content); return key; };
    // Code, image references, equations and wiki links retain their existing meanings.
    const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]+`|!\[[^\]\n]*\]\(noteject-image:[^)\n]+\)|\[\[[^\]\n]*\]\]|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)|\$(?=\S)[^$\n]+?\$|\\.|(?<named>\[(?:\\.|[^\]\\\n])+\]\((?:<[^>\n]+>|(?:\\.|[^()\s]|\([^()\s]*\))+)\))|<(?<auto>https?:\/\/[^<>\s]+)>|(?<bare>(?:https?:\/\/|www\.)[^\s<>"'\[\]`*\uE000\uE001]+)/gi;
    const protectedSource = source.replace(pattern, (whole, ...args) => {
      const groups = args.at(-1), offset = args.at(-3);
      if (whole.startsWith('[[')) return token(wikiHtml(whole.slice(2, -2)));
      if (groups.named) {
        if (source[offset - 1] === '!') return whole;
        const match = whole.match(/^\[((?:\\.|[^\]\\\n])+)\]\(([\s\S]+)\)$/);
        if (!match) return whole;
        const destination = match[2].startsWith('<') ? match[2].slice(1, -1) : match[2].replace(/\\([()\\])/g, '$1');
        return normalize(destination) ? token(html(match[1], destination, true)) : whole;
      }
      if (groups.auto) return normalize(groups.auto) ? token(html(groups.auto, groups.auto)) : whole;
      if (groups.bare) {
        const bare = trimBare(whole);
        return normalize(bare) ? token(html(bare, bare)) + whole.slice(bare.length) : whole;
      }
      return whole;
    });
    return {
      source: protectedSource,
      restore: rendered => String(rendered).replace(new RegExp(nonce + '(\\d+)\uE001', 'g'), (_, index) => pieces[Number(index)] || '')
    };
  }
  function preview(value) {
    return String(value || '').replace(/\[\[([^\]\n]+)\]\]/g, (_, ref) => parseWiki(ref).label).replace(/(?<!!)\[((?:\\.|[^\]\\\n])+)\]\((?:<[^>\n]+>|(?:\\.|[^()\s]|\([^()\s]*\))+)\)/g, (_, label) => labelText(label));
  }
  window.NotejectNoteLinks = Object.freeze({ normalize, html, protect, preview, parseWiki, resolveWiki, wikiReference, wikiHtml });
})();
