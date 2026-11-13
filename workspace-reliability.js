/* Recovery, portable backups, local document indexing, and office previews. */
(function () {
  'use strict';

  if (window.__notejectReliabilityLoaded) return;
  window.__notejectReliabilityLoaded = true;

  Object.assign(attachmentKinds, {
    doc: 'doc', xls: 'xls', ppt: 'ppt', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
    md: 'txt', markdown: 'txt', csv: 'txt', tsv: 'txt', json: 'txt', xml: 'txt',
    html: 'txt', htm: 'txt', log: 'txt', ini: 'txt', yaml: 'txt', yml: 'txt',
    js: 'txt', ts: 'txt', css: 'txt', py: 'txt', sh: 'txt', ps1: 'txt', sql: 'txt',
    rtf: 'txt'
  });
  const OFFICE_TYPES = ['doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'];
  const INDEX_VERSION = 3;
  const MAX_BACKUP_ENTRY_BYTES = 15 * 1024 * 1024 * 1024;
  const MAX_BACKUP_TOTAL_BYTES = 15 * 1024 * 1024 * 1024;
  const MAX_BACKUP_METADATA_BYTES = 64 * 1024 * 1024;
  const ZIP32_SENTINEL = 0xffffffff;

  workspacePageApp.trashProject = snapshot => stash('project', snapshot);

  const originalRestoreTrashEntry = restoreTrashEntry;
  restoreTrashEntry = function (entry) {
    if (entry?.type !== 'project') return originalRestoreTrashEntry(entry);
    const payload = entry.payload || {}, project = payload.project;
    if (!project?.folder) return false;
    const current = window.NotejectWorkspaceOrganizer.model.projects(data);
    if (current.some(item => item.folder.toLocaleLowerCase() === project.folder.toLocaleLowerCase())) {
      notify('A project already uses this folder name. Rename or remove it before restoring.');
      return false;
    }
    data.folders = Array.isArray(data.folders) ? data.folders : ['Inbox'];
    data.noteFolders = Array.isArray(data.noteFolders) ? data.noteFolders : ['Inbox'];
    data.folderProjects = data.folderProjects || { Inbox: 'folder-inbox' };
    if (payload.folderWasListed && !data.folders.includes(project.folder)) data.folders.push(project.folder);
    if (payload.noteFolderWasListed && !data.noteFolders.includes(project.folder)) data.noteFolders.push(project.folder);
    if (payload.folderProject) data.folderProjects[project.folder] = payload.folderProject;
    for (const note of data.notes) if ((payload.noteIds || []).includes(note.id)) note.folder = project.folder;
    for (const doc of data.docs) if ((payload.documentIds || []).includes(doc.id)) doc.folder = project.folder;
    for (const board of data.boards) if ((payload.folderBoards || []).includes(board.id)) board.folder = project.folder;
    data.workspace = data.workspace || {};
    data.workspace.projects = Array.isArray(data.workspace.projects) ? data.workspace.projects : [];
    const metadata = payload.projectMetadata || {
      id: project.id || 'folder:' + project.folder,
      folder: project.folder, name: project.name || project.folder,
      description: project.description || '', color: project.color || 'violet',
      boardIds: project.boardIds || []
    };
    data.workspace.projects.push({ ...metadata, folder: project.folder });
    data.trash = data.trash.filter(item => item.id !== entry.id);
    return true;
  };

  removeDiskFile = async function (doc) {
    if (window.NotejectAndroid || window.NotejectWebApp) { if (doc?.id) await removeStoredFile(doc.id); return; }
    if (!doc?.diskProject || !doc?.id) return;
    const response = await fetch(diskApiBase + '/api/files?project=' + encodeURIComponent(doc.diskProject) + '&id=' + encodeURIComponent(doc.id) + '&name=' + encodeURIComponent(doc.diskName || doc.name), { method: 'DELETE' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'Could not delete the stored file (HTTP ' + response.status + ').');
  };
  permanentlyDeleteTrashEntry = async function (entry) {
    if (!entry) return false;
    if (entry.type === 'document' && entry.payload?.item) {
      const doc = entry.payload.item;
      await removeDiskFile(doc);
      if (!window.NotejectAndroid && !window.NotejectWebApp) await removeStoredFile(doc.id);
      if(data.attachmentKeys)delete data.attachmentKeys[doc.id];
      window.NotejectAndroid?.forgetNativeReaderDocument?.(doc.id);
      searchTextCache.delete(doc.id);
      try { const db = await searchIndexDb(); db.transaction('texts', 'readwrite').objectStore('texts').delete(doc.id); } catch {}
    }
    if (entry.type === 'note' && entry.payload?.item) {
      const note = entry.payload.item, project = data.folderProjects?.[note.folder];
      if (project && !window.NotejectAndroid && !window.NotejectWebApp) {
        const response = await fetch(diskApiBase + '/api/project-notes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, id: note.id }) });
        if (!response.ok) throw Error('The project note copy could not be deleted. The item remains in Trash.');
      }
      await window.NotejectNoteMedia.releaseNoteImages(note, entry.id);
    }
    data.trash = data.trash.filter(current => current.id !== entry.id);
    return true;
  };

  renderTrash = function () {
    const entries = ensureTrash();
    return `<header class="page-heading"><div><div class="eyebrow">RECOVERY</div><h1>Trash</h1><p>Deleted items stay here until you permanently remove them.</p></div><button class="danger-button" data-action="empty-trash" ${entries.length ? '' : 'disabled'}>Empty trash</button></header><div class="trash-list">${entries.map(entry => {
      const p = entry.payload || {}, item = p.item || p.board || p.items?.[0] || {},
        label = item.title || item.name || p.project?.name || p.board?.name || (p.items?.length ? `${p.items.length} board card${p.items.length === 1 ? '' : 's'}` : 'Deleted item'),
        kind = entry.type === 'document' ? 'Document' : entry.type === 'note' ? 'Note' : entry.type === 'project' ? 'Project' : entry.type === 'board' ? 'Board' : 'Board card';
      return `<article class="trash-row"><span class="trash-type">${kind}</span><div><b>${esc(label)}</b><small>Deleted ${new Date(entry.deletedAt).toLocaleString(globalThis.document?.documentElement?.lang || undefined)}</small></div><button class="secondary" data-trash-restore="${esc(entry.id)}">Restore</button><button class="danger-button" data-trash-discard="${esc(entry.id)}">Delete permanently</button></article>`;
    }).join('') || '<div class="empty-list"><h3>Trash is empty</h3><p>Items you delete will be available to restore here.</p></div>'}</div>`;
  };

  const originalRenderBoardCanvas = renderBoardCanvas;
  renderBoardCanvas = function () {
    return originalRenderBoardCanvas().replace(
      '<button class="primary" data-action="new-note">',
      '<button type="button" class="secondary" data-rename-board>✎ Rename board</button><button class="primary" data-action="new-note">'
    );
  };
  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-rename-board]');
    if (!control) return;
    const board = activeBoard();
    if (!board) return;
    const name = await window.NotejectDialogs.prompt('Choose a name for this board.', board.name || 'Untitled board', { title: 'Rename board', input: { label: 'Board name' } });
    if (name === null) return;
    const next = name.trim().slice(0, 100);
    if (!next) { notify('Enter a board name.'); return; }
    if (data.boards.some(item => item.id !== board.id && item.name.trim().toLocaleLowerCase() === next.toLocaleLowerCase())) {
      notify('Another board already has that name.'); return;
    }
    board.name = next;
    save(); render(); notify('Board renamed');
  });

  function normalizeZipPath(path) {
    const parts = [];
    for (const part of decodePath(path).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { parts.pop(); continue; }
      parts.push(part);
    }
    return parts.join('/');
  }

  function zipNumber(view, offset) {
    const low = view.getUint32(offset, true), high = view.getUint32(offset + 4, true);
    if (high > 0x1fffff) throw Error('This ZIP64 archive is too large to process safely.');
    return high * 0x100000000 + low;
  }
  function setZipNumber(view, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0) throw Error('This ZIP64 archive is too large to process safely.');
    const high = Math.floor(value / 0x100000000), low = value - high * 0x100000000;
    view.setUint32(offset, low, true); view.setUint32(offset + 4, high, true);
  }

  async function readZipArchive(file) {
    if (file.size > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup is larger than the 15 GB safety limit. Split large attachments into separate backups.');
    const tailStart = Math.max(0, file.size - 65557), tail = new Uint8Array(await file.slice(tailStart).arrayBuffer()), tailView = new DataView(tail.buffer);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tailView.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw Error('This is not a supported ZIP archive.');
    const endAbsolute = tailStart + end;
    let count = tailView.getUint16(end + 10, true), directorySize = tailView.getUint32(end + 12, true), directoryOffset = tailView.getUint32(end + 16, true);
    if (count === 0xffff || directorySize === ZIP32_SENTINEL || directoryOffset === ZIP32_SENTINEL) {
      if (endAbsolute < 20) throw Error('The ZIP64 archive directory is damaged.');
      const locator = new DataView(await file.slice(endAbsolute - 20, endAbsolute).arrayBuffer());
      if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) throw Error('The ZIP64 archive directory is damaged.');
      const zip64Offset = zipNumber(locator, 8);
      if (zip64Offset > file.size - 56) throw Error('The ZIP64 archive directory is outside the backup file.');
      const zip64 = new DataView(await file.slice(zip64Offset, zip64Offset + 56).arrayBuffer());
      if (zip64.getUint32(0, true) !== 0x06064b50 || zipNumber(zip64, 4) < 44 || zip64.getUint32(16, true) !== 0 || zip64.getUint32(20, true) !== 0) throw Error('The ZIP64 archive directory is invalid or spans multiple disks.');
      const entriesOnDisk = zipNumber(zip64, 24), totalEntries = zipNumber(zip64, 32);
      if (entriesOnDisk !== totalEntries) throw Error('Multi-disk ZIP archives are not supported.');
      count = totalEntries; directorySize = zipNumber(zip64, 40); directoryOffset = zipNumber(zip64, 48);
    }
    if (count > 65534 || directorySize > MAX_BACKUP_METADATA_BYTES || directoryOffset + directorySize > file.size || !Number.isSafeInteger(directoryOffset + directorySize)) throw Error('The ZIP archive directory is too large or invalid.');
    const directory = new Uint8Array(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer()), view = new DataView(directory.buffer), entries = new Map();
    let offset = 0, totalExpanded = 0;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw Error('The ZIP archive directory is damaged.');
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), crc = view.getUint32(offset + 16, true), compressed32 = view.getUint32(offset + 20, true), uncompressed32 = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true), localOffset32 = view.getUint32(offset + 42, true);
      if (flags & 1) throw Error('Encrypted ZIP archives cannot be opened.');
      if (offset + 46 + nameLength + extraLength + commentLength > directory.length) throw Error('The ZIP archive directory is damaged.');
      const needsCompressed = compressed32 === ZIP32_SENTINEL, needsUncompressed = uncompressed32 === ZIP32_SENTINEL, needsOffset = localOffset32 === ZIP32_SENTINEL;
      let compressedSize = compressed32, uncompressedSize = uncompressed32, localOffset = localOffset32;
      if (needsCompressed || needsUncompressed || needsOffset) {
        const extraStart = offset + 46 + nameLength, extraEnd = extraStart + extraLength;
        let zip64Data = -1, zip64Length = 0;
        for (let cursor = extraStart; cursor + 4 <= extraEnd;) {
          const fieldId = view.getUint16(cursor, true), fieldLength = view.getUint16(cursor + 2, true), fieldData = cursor + 4;
          if (fieldData + fieldLength > extraEnd) throw Error('The ZIP archive has an invalid extra field.');
          if (fieldId === 0x0001) { zip64Data = fieldData; zip64Length = fieldLength; break; }
          cursor = fieldData + fieldLength;
        }
        if (zip64Data < 0) throw Error('The ZIP64 archive is missing its size information.');
        let cursor = zip64Data;
        const read64 = () => { if (cursor + 8 > zip64Data + zip64Length) throw Error('The ZIP64 archive size information is incomplete.'); const value = zipNumber(view, cursor); cursor += 8; return value; };
        if (needsUncompressed) uncompressedSize = read64();
        if (needsCompressed) compressedSize = read64();
        if (needsOffset) localOffset = read64();
      }
      if (![compressedSize, uncompressedSize, localOffset].every(Number.isSafeInteger) || uncompressedSize > MAX_BACKUP_ENTRY_BYTES || compressedSize > MAX_BACKUP_ENTRY_BYTES) throw Error('A backup entry is larger than the 15 GB per-file safety limit.');
      totalExpanded += uncompressedSize;
      if (!Number.isSafeInteger(totalExpanded) || totalExpanded > MAX_BACKUP_TOTAL_BYTES) throw Error('The expanded backup is larger than the 15 GB safety limit.');
      if (method === 0 && compressedSize !== uncompressedSize) throw Error('The ZIP archive has an invalid stored file size.');
      const nameBytes = directory.slice(offset + 46, offset + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes), key = normalizeZipPath(name);
      if (!key || name.endsWith('/')) { offset += 46 + nameLength + extraLength + commentLength; continue; }
      if (method !== 0 && method !== 8) throw Error('This ZIP archive uses an unsupported compression method.');
      const localHeader = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
      if (localHeader.getUint32(0, true) !== 0x04034b50) throw Error('The ZIP archive contains a damaged file entry.');
      const localNameLength = localHeader.getUint16(26, true), localExtraLength = localHeader.getUint16(28, true), dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > file.size) throw Error('The ZIP archive contains an incomplete file.');
      entries.set(key, { method, crc, size: uncompressedSize, blob: file.slice(dataStart, dataStart + compressedSize), decodedPromise: null });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  unzip = readZipArchive;
  zipBytes = async function (zip, name) {
    const key = normalizeZipPath(name), entry = zip.get(key) || zip.get(decodePath(name));
    if (!entry) throw Error('Missing archive entry ' + name);
    if (!entry.decodedPromise) entry.decodedPromise = (async () => {
      if (entry.size > MAX_BACKUP_METADATA_BYTES || entry.blob?.size > MAX_BACKUP_METADATA_BYTES) throw Error('Backup metadata is larger than the 64 MB processing limit.');
      const compressed = entry.blob ? new Uint8Array(await entry.blob.arrayBuffer()) : entry.compressed;
      if (entry.method === 0) return compressed.slice();
      if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw Error('This Windows web runtime cannot open compressed ZIP files. Update it and reopen the file.');
        let expanded = 0;
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(new TransformStream({
          transform(chunk, controller) { expanded += chunk.byteLength; if (expanded > entry.size || expanded > MAX_BACKUP_METADATA_BYTES) throw Error('A compressed backup entry expands beyond its declared safe size.'); controller.enqueue(chunk); }
        }));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        if (bytes.byteLength !== entry.size) throw Error('A compressed backup entry does not match its declared size.');
        return bytes;
      }
      throw Error('Unsupported ZIP compression method ' + entry.method);
    })().catch(error => { entry.decodedPromise = null; throw error; });
    return entry.decodedPromise;
  };

  async function zipEntryBlob(zip, name, type = 'application/octet-stream') {
    const entry = zip.get(normalizeZipPath(name));
    if (!entry) throw Error('Backup is missing attachment ' + name + '.');
    let blob;
    if (entry.method === 0 && entry.blob) blob = entry.blob.slice(0, entry.blob.size, type);
    else if (entry.method === 8 && entry.blob) blob = await inflateZipEntry(entry, type);
    else blob = new Blob([await zipBytes(zip, name)], { type });
    if (Number.isFinite(entry.crc) && await crc32Blob(blob) !== entry.crc) throw Error('The backup file ' + name + ' failed its integrity check.');
    return blob;
  }

  async function inflateZipEntry(entry, type) {
    if (entry.size > MAX_BACKUP_ENTRY_BYTES) throw Error('A compressed backup entry exceeds the 15 GB per-file safety limit.');
    if (typeof DecompressionStream === 'undefined') throw Error('This device cannot open compressed ZIP attachments. Update Noteject and try again.');
    let expanded = 0;
    const stream = entry.blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(new TransformStream({
      transform(chunk, controller) {
        expanded += chunk.byteLength;
        if (!Number.isSafeInteger(expanded) || expanded > entry.size || expanded > MAX_BACKUP_ENTRY_BYTES) throw Error('A compressed backup entry expands beyond its declared safe size.');
        controller.enqueue(chunk);
      }
    }));
    const blob = await new Response(stream).blob();
    if (expanded !== entry.size) throw Error('The compressed backup file does not match its declared size.');
    return blob.slice(0, blob.size, type);
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table;
  })();
  async function crc32Blob(blob) {
    let crc = 0xffffffff;
    for (let start = 0; start < blob.size; start += 1024 * 1024) {
      const bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + 1024 * 1024)).arrayBuffer());
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function dosDateTime(date = new Date()) {
    return { date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(), time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2) };
  }
  function zipHeader(nameBytes, size, crc, offset, central, dateTime) {
    const zip64Size = size >= ZIP32_SENTINEL, zip64Offset = central && offset >= ZIP32_SENTINEL;
    const zip64Values = (zip64Size ? 16 : 0) + (zip64Offset ? 8 : 0), extraLength = zip64Values ? zip64Values + 4 : 0;
    const buffer = new ArrayBuffer((central ? 46 : 30) + nameBytes.length + extraLength), view = new DataView(buffer), u16 = (p, v) => view.setUint16(p, v, true), u32 = (p, v) => view.setUint32(p, v, true);
    let extraOffset = central ? 46 + nameBytes.length : 30 + nameBytes.length;
    if (zip64Values) {
      u16(extraOffset, 0x0001); u16(extraOffset + 2, zip64Values); extraOffset += 4;
      if (zip64Size) { setZipNumber(view, extraOffset, size); setZipNumber(view, extraOffset + 8, size); extraOffset += 16; }
      if (zip64Offset) { setZipNumber(view, extraOffset, offset); }
    }
    if (central) {
      u32(0, 0x02014b50); u16(4, zip64Values ? 45 : 20); u16(6, zip64Values ? 45 : 20); u16(8, 0x0800); u16(10, 0); u16(12, dateTime.time); u16(14, dateTime.date); u32(16, crc); u32(20, zip64Size ? ZIP32_SENTINEL : size); u32(24, zip64Size ? ZIP32_SENTINEL : size); u16(28, nameBytes.length); u16(30, extraLength); u16(32, 0); u16(34, 0); u16(36, 0); u32(38, 0); u32(42, zip64Offset ? ZIP32_SENTINEL : offset); new Uint8Array(buffer, 46).set(nameBytes);
    } else {
      u32(0, 0x04034b50); u16(4, zip64Size ? 45 : 20); u16(6, 0x0800); u16(8, 0); u16(10, dateTime.time); u16(12, dateTime.date); u32(14, crc); u32(18, zip64Size ? ZIP32_SENTINEL : size); u32(22, zip64Size ? ZIP32_SENTINEL : size); u16(26, nameBytes.length); u16(28, extraLength); new Uint8Array(buffer, 30).set(nameBytes);
    }
    return new Uint8Array(buffer);
  }
  function zipEnd(count, directorySize, directoryOffset) {
    const needsZip64 = count >= 0xffff || directorySize >= ZIP32_SENTINEL || directoryOffset >= ZIP32_SENTINEL;
    const buffer = new ArrayBuffer(needsZip64 ? 98 : 22), view = new DataView(buffer);
    if (!needsZip64) {
      view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true); view.setUint16(8, count, true); view.setUint16(10, count, true); view.setUint32(12, directorySize, true); view.setUint32(16, directoryOffset, true); view.setUint16(20, 0, true);
      return new Uint8Array(buffer);
    }
    const zip64Offset = directoryOffset + directorySize;
    view.setUint32(0, 0x06064b50, true); setZipNumber(view, 4, 44); view.setUint16(12, 45, true); view.setUint16(14, 45, true); view.setUint32(16, 0, true); view.setUint32(20, 0, true); setZipNumber(view, 24, count); setZipNumber(view, 32, count); setZipNumber(view, 40, directorySize); setZipNumber(view, 48, directoryOffset);
    view.setUint32(56, 0x07064b50, true); view.setUint32(60, 0, true); setZipNumber(view, 64, zip64Offset); view.setUint32(72, 1, true);
    view.setUint32(76, 0x06054b50, true); view.setUint16(80, 0, true); view.setUint16(82, 0, true); view.setUint16(84, 0xffff, true); view.setUint16(86, 0xffff, true); view.setUint32(88, ZIP32_SENTINEL, true); view.setUint32(92, ZIP32_SENTINEL, true); view.setUint16(96, 0, true);
    return new Uint8Array(buffer);
  }

  // Trash documents remain restorable assets and belong in portable backups.
  function backupDocuments(workspace) {
    const docs = [...workspace.docs, ...(workspace.trash || []).filter(entry => entry?.type === 'document').map(entry => entry.payload?.item)];
    if (docs.some(doc => !doc || typeof doc.id !== 'string' || typeof doc.name !== 'string' || typeof doc.type !== 'string')) throw Error('The backup has an invalid document or Trash entry.');
    if (new Set(docs.map(doc => doc.id)).size !== docs.length) throw Error('The workspace has duplicate document IDs. Resolve these before backing up.');
    const byId = new Map(docs.map(doc => [doc.id, doc]));
    for (const asset of window.NotejectNoteMedia.assetsForWorkspace(workspace)) {
      if (!asset || !/^note-image-[a-zA-Z0-9_-]+$/.test(asset.id || '') || typeof asset.name !== 'string' || asset.type !== 'image') throw Error('A note has invalid image attachment metadata.');
      const existing = byId.get(asset.id);
      if (existing && (existing.name !== asset.name || existing.size !== asset.size || existing.diskProject !== asset.diskProject)) throw Error('Two image attachments have conflicting metadata.');
      if (!existing) byId.set(asset.id, asset);
    }
    return [...byId.values()];
  }
  exportWorkspaceBackup = async function ({ download = true, silent = false, signal } = {}) {
    try {
      const snapshotData = data, snapshotEpoch = attachmentMutationEpoch;
      const assertSnapshot = () => {
        signal?.throwIfAborted();
        if (data !== snapshotData || attachmentMutationsInFlight || attachmentMutationEpoch !== snapshotEpoch) throw Error('A document changed while the backup was being prepared. No backup was exported. Wait for file changes to finish, then export again.');
      };
      assertSnapshot();
      // Capture metadata and file bindings before the first await. Later edits
      // must not change either the manifest or the attachment set being exported.
      const sources = backupDocuments(data).map(doc => ({ ...doc }));
      if (sources.length > 65530) throw Error('This workspace has too many files for one backup.');
      const workspace = JSON.parse(JSON.stringify({ ...data, backupVersion: 2, exportedAt: new Date().toISOString() }, (key, value) => key === 'blob' || key === 'localUrl' ? undefined : value));
      const entries = [{ name: 'manifest.json', blob: new Blob([JSON.stringify({ format: 'noteject-portable-backup', version: 1, workspace, attachments: [] })], { type: 'application/json' }) }];
      const attachmentRecords = []; let estimatedAttachmentBytes = 0;
      for (const doc of sources) {
        const estimate = Number(doc.size);
        if (Number.isFinite(estimate) && estimate > MAX_BACKUP_ENTRY_BYTES) throw Error('“' + doc.name + '” is larger than the 15 GB per-file backup limit.');
        if (Number.isFinite(estimate)) { estimatedAttachmentBytes += estimate; if (estimatedAttachmentBytes > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup would exceed the 15 GB safety limit. Remove large attachments or back them up separately.'); }
      }
      const files = await Promise.all(sources.map(doc => getDocumentBlob(doc, attachmentImports.resolve(doc.id))));
      assertSnapshot();
      for (let index = 0; index < sources.length; index++) {
        const doc = sources[index], estimate = Number(doc.size), blob = files[index];
        if (!blob) throw Error('Could not include “' + doc.name + '”. Reconnect the original file and export the backup again.');
        if (blob.size > MAX_BACKUP_ENTRY_BYTES) throw Error('“' + doc.name + '” is larger than the 15 GB per-file backup limit.');
        estimatedAttachmentBytes += blob.size - (Number.isFinite(estimate) ? estimate : 0);
        if (estimatedAttachmentBytes > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup would exceed the 15 GB safety limit. Remove large attachments or back them up separately.');
        const path = 'attachments/' + index;
        attachmentRecords.push({ documentId: doc.id, path, name: doc.name, type: blob.type || 'application/octet-stream', size: blob.size });
        entries.push({ name: path, blob });
      }
      const manifest = new Blob([JSON.stringify({ format: 'noteject-portable-backup', version: 1, workspace, attachments: attachmentRecords })], { type: 'application/json' });
      entries[0].blob = manifest;
      let offset = 0;
      const localParts = [], centralParts = [], when = dosDateTime();
      for (const item of entries) {
        const nameBytes = new TextEncoder().encode(item.name);
        if (item.blob.size > MAX_BACKUP_ENTRY_BYTES) throw Error('“' + item.name + '” is larger than the 15 GB per-file backup limit.');
        if (!Number.isSafeInteger(offset + item.blob.size) || offset + item.blob.size > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup would exceed the 15 GB safety limit. Remove large attachments or back them up separately.');
        const crc = await crc32Blob(item.blob), local = zipHeader(nameBytes, item.blob.size, crc, 0, false, when), central = zipHeader(nameBytes, item.blob.size, crc, offset, true, when);
        localParts.push(local, item.blob); centralParts.push(central);
        offset += local.length + item.blob.size;
      }
      const directoryOffset = offset, directorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
      const endRecord = zipEnd(entries.length, directorySize, directoryOffset);
      if (!Number.isSafeInteger(directoryOffset + directorySize + endRecord.byteLength) || directoryOffset + directorySize + endRecord.byteLength > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup would exceed the 15 GB safety limit. Remove large attachments or back them up separately.');
      const archive = new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
      // File replacement/deletion may finish during reads or CRC calculation.
      // Only publish an archive whose metadata and bytes share one snapshot.
      assertSnapshot();
      if (!download) return archive;
      const filename = 'noteject-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
      if (window.NotejectAndroid) {
        if (!window.NotejectAndroidFiles?.save) throw Error('Update the Android app to enable saving backups.');
        const result = await window.NotejectAndroidFiles.save(archive, filename);
        if (result?.status !== 'saved') return;
      } else {
        const url = URL.createObjectURL(archive), anchor = document.createElement('a');
        anchor.href = url; anchor.download = filename; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      notify('Portable backup exported with ' + sources.length + ' original file' + (sources.length === 1 ? '' : 's') + ' (including Trash)');
    } catch (error) { if (silent) throw error; notify(error.message || 'Could not export a portable backup'); }
  };

  const originalLoadWorkspaceBackup = loadWorkspaceBackup;
  loadWorkspaceBackup = async function (file, options = {}) {
    const { signal } = options;
    if (!file) return originalLoadWorkspaceBackup(file, options);
    const created = [], restoredLocalUrls = [], previousData = data, previousRecovery = storageRecovery;
    let importSession = null;
    let workspaceCommitted = false, workspaceReplaced = false, rollbackSaveFailed = false;
    try {
      const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      signal?.throwIfAborted();
      // Android document providers can omit the extension or report generic MIME.
      if (signature[0] !== 0x50 || signature[1] !== 0x4b) return originalLoadWorkspaceBackup(file, options);
      if (file.size > MAX_BACKUP_TOTAL_BYTES) throw Error('This backup is larger than the 15 GB safety limit. Split large attachments into separate backups.');
      const zip = await readZipArchive(file), metadata = zip.get('manifest.json');
      if (!metadata || metadata.size > MAX_BACKUP_METADATA_BYTES) throw Error('Backup metadata is missing or larger than the 64 MB processing limit.');
      // Workspace metadata needs the same integrity check as its attachments.
      const manifest = JSON.parse(await (await zipEntryBlob(zip, 'manifest.json', 'application/json')).text());
      signal?.throwIfAborted();
      if (manifest?.format !== 'noteject-portable-backup' || manifest.version !== 1) throw Error('This is not a supported Noteject portable backup.');
      const restored = normalizeWorkspaceBackup(manifest.workspace), documents = backupDocuments(restored);
      if (!Array.isArray(manifest.attachments)) throw Error('The backup has an invalid attachment list.');
      const attachments = new Map(manifest.attachments.map(item => [item?.documentId, item]));
      if (manifest.attachments.length !== attachments.size || documents.length !== attachments.size || documents.some(doc => !attachments.has(doc.id))) throw Error('The backup does not include every document attachment, including files in Trash. Export a new backup from the original device.');
      restored.attachmentImportId = id();
       if (!await window.NotejectWorkspaceUX.confirmBackup(file, restored, attachments.size)) return null;
      signal?.throwIfAborted();
      if (!previousRecovery && !workspaceStore.flush()) throw Error('Your current workspace could not be saved. The backup was not loaded. Free some device storage and try again.');
      if (window.NotejectAndroid || window.NotejectWebApp) {
        importSession = await attachmentImports.begin();
        restored.attachmentKeys = Object.create(null);
        restored.attachmentImportId = importSession.id;
      }
      // Restore into fresh on-disk project IDs. A failed or repeated restore must never
      // overwrite or delete attachments from the currently open workspace.
      const storageIds = new Map(), suffix = id().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      const isolateStorage = oldId => {
        const key = String(oldId || 'folder-inbox');
        if (!storageIds.has(key)) storageIds.set(key, 'restore-' + suffix + '-' + storageIds.size);
        return storageIds.get(key);
      };
      const originalFolderProjects = restored.folderProjects || {};
      restored.folderProjects = Object.fromEntries(Object.entries(originalFolderProjects).map(([folder, project]) => [folder, isolateStorage(project)]));
      for (const doc of documents) doc.diskProject = isolateStorage(doc.diskProject || originalFolderProjects[doc.folder] || 'folder-inbox');
      for (const doc of documents) {
        const record = attachments.get(doc.id);
        if (!record || !/^attachments\/\d+$/.test(record.path || '')) throw Error('The backup has a missing or invalid file record for “' + doc.name + '”.');
        const blob = await zipEntryBlob(zip, record.path, record.type || 'application/octet-stream');
        signal?.throwIfAborted();
        if (blob.size !== Number(record.size)) throw Error('The backup file for “' + doc.name + '” is incomplete.');
        if (window.NotejectAndroid || window.NotejectWebApp) {
          restored.attachmentKeys[doc.id] = await attachmentImports.stage(importSession, doc.id, blob);
          // Previews and media elements need a live URL immediately after restore.
          // The workspace serializer omits these values; IndexedDB retains the original.
          doc.blob = blob;
          doc.localUrl = URL.createObjectURL(blob);
          delete doc.nativeRecording; delete doc.nativeAudio; delete doc.audioRecordingId;
          restoredLocalUrls.push(doc.localUrl);
        } else {
          // Track before the request: the server may finish writing even if its response is lost.
          created.push(doc);
          const result = await saveDiskFile(blob, doc); doc.diskName = result.name || doc.name;
        }
      }
      // Duplicated notes may share a binary image; all copies need its restored binding.
      window.NotejectNoteMedia.syncAssetBindings(restored, documents);
      // File restoration can take time. Save any edits made while it was running
      // before replacing the workspace object used by the persistence serializer.
      if (!previousRecovery && !workspaceStore.flush()) throw Error('Your current workspace could not be saved. The backup was not loaded.');
      if (importSession) await attachmentImports.checkpoint(importSession);
      signal?.throwIfAborted();
      data = restored; workspaceReplaced = true;
      // Explicitly loading a backup is also the recovery path for damaged metadata.
      // Keep that protection until all attachments have been restored successfully.
      storageRecovery = null;
      workspaceStore.schedule();
      if (!workspaceStore.flush()) throw Error('The restored workspace could not be saved. Your previous workspace has been kept. Free some device storage and try again.');
      workspaceCommitted = true;
      if (importSession) await attachmentImports.commit(importSession);
      await resetImportedTextIndexes(restored.docs);
      view = 'home'; data.selected = null; query = ''; byId('search').value = ''; boardSelection.clear(); selectedDocs.clear(); selectedNotes.clear(); render(); hydrateSearchIndex();
       notify('Portable backup loaded: ' + data.notes.length + ' notes, ' + data.docs.length + ' documents');
       return true;
    } catch (error) {
      if (!workspaceCommitted) {
        restoredLocalUrls.forEach(url => URL.revokeObjectURL(url));
        data = previousData;
        storageRecovery = previousRecovery;
        if (workspaceReplaced && !previousRecovery) {
          workspaceStore.schedule();
          rollbackSaveFailed = !workspaceStore.flush();
        }
        await Promise.all([
          ...(window.NotejectWebApp ? created.map(doc => removeStoredFile(doc.id).catch(() => {})) : created.map(doc => fetch(diskApiBase + '/api/files?project=' + encodeURIComponent(doc.diskProject) + '&id=' + encodeURIComponent(doc.id) + '&name=' + encodeURIComponent(doc.name), { method: 'DELETE' }).catch(() => {}))),
          importSession ? attachmentImports.abort(importSession).catch(() => {}) : Promise.resolve()
        ]);
      }
       notify((error.message || 'Could not load this portable backup') + (rollbackSaveFailed ? ' Your previous workspace is open, but saving is still unavailable.' : ''));
       return false;
    }
  };

  function parseXml(source, label) {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.querySelector('parsererror')) throw Error('Could not read ' + label + ' inside this file.');
    return doc;
  }
  const descendants = (node, name) => [...node.getElementsByTagName('*')].filter(item => item.localName === name);
  const innerText = node => descendants(node, 't').map(item => item.textContent || '').join('');
  const textOfParagraph = paragraph => {
    let out = '';
    const walk = node => {
      for (const child of node.childNodes || []) {
        if (child.nodeType === 3) continue;
        if (child.localName === 't') out += child.textContent || '';
        else if (child.localName === 'tab') out += '\t';
        else if (child.localName === 'br' || child.localName === 'cr') out += '\n';
        else walk(child);
      }
    };
    walk(paragraph); return out.trim();
  };
  function officeParagraphs(xml) { return descendants(xml, 'p').map(textOfParagraph).filter(Boolean); }
  function officeTextHtml(paragraphs) { return paragraphs.length ? paragraphs.map(line => '<p>' + esc(line) + '</p>').join('') : '<p class="office-empty">No readable text was found in this file.</p>'; }

  const localScriptJobs = new Map();
  function loadLocalScript(path, ready) {
    if (ready()) return Promise.resolve();
    if (!localScriptJobs.has(path)) {
      const job = new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.async = true; script.src = new URL(path, document.baseURI).href;
        script.onload = () => ready() ? resolve() : reject(Error('The local document preview engine did not start.'));
        script.onerror = () => reject(Error('The local document preview engine could not be loaded.'));
        document.head.append(script);
      }).catch(error => { localScriptJobs.delete(path); throw error; });
      localScriptJobs.set(path, job);
    }
    return localScriptJobs.get(path);
  }

  async function parseLegacyOfficeDocument(type, blob) {
    await loadLocalScript('./vendor/office/officeparser.browser.js', () => !!(window.docstream || window.officeParser));
    const parser = window.docstream || window.officeParser;
    const parseOffice = parser?.parseOffice || parser?.OfficeParser?.parseOffice;
    if (typeof parseOffice !== 'function') throw Error('The local Office preview engine did not load. Close and reopen noteject.');
    const ast = await parseOffice.call(parser?.OfficeParser || parser, await blob.arrayBuffer(), { outputErrorToConsole: false });
    const text = String(ast?.toText?.() || '').replace(/\u0000/g, '').trim();
    const labels = { doc: 'Word 97–2003', xls: 'Excel 97–2003', ppt: 'PowerPoint 97–2003' };
    const body = text ? '<pre class="office-legacy-preview">' + esc(text.slice(0, 1000000)) + '</pre>' : '<p class="office-empty">No readable content was found in this file.</p>';
    return { text, html: '<section class="office-legacy-document"><div class="office-legacy-label">' + labels[type] + ' · Local text preview</div>' + body + '</section>' };
  }

  async function parseOfficeDocument(type, blob) {
    if (['doc', 'xls', 'ppt'].includes(type)) return parseLegacyOfficeDocument(type, blob);
    const zip = await unzip(blob);
    if (type === 'docx') {
      const xml = parseXml(await zipText(zip, 'word/document.xml'), 'Word document'), paragraphs = officeParagraphs(xml);
      return { text: paragraphs.join('\n'), html: '<article class="office-text-preview">' + officeTextHtml(paragraphs) + '</article>' };
    }
    if (type === 'pptx') {
      const slides = [...zip.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
      const blocks = [];
      for (let index = 0; index < slides.length; index++) {
        const xml = parseXml(await zipText(zip, slides[index]), 'presentation slide'), paragraphs = officeParagraphs(xml);
        blocks.push({ title: 'Slide ' + (index + 1), paragraphs });
      }
      const text = blocks.map(slide => slide.title + '\n' + slide.paragraphs.join('\n')).join('\n\n');
      const html = blocks.length ? '<div class="office-slide-list">' + blocks.map(slide => '<section class="office-slide"><small>' + slide.title + '</small>' + officeTextHtml(slide.paragraphs) + '</section>').join('') + '</div>' : '<p class="office-empty">No readable slides were found.</p>';
      return { text, html };
    }
    const shared = zip.has('xl/sharedStrings.xml') ? descendants(parseXml(await zipText(zip, 'xl/sharedStrings.xml'), 'spreadsheet strings'), 'si').map(innerText) : [];
    const workbook = zip.has('xl/workbook.xml') ? parseXml(await zipText(zip, 'xl/workbook.xml'), 'spreadsheet workbook') : null;
    const relationships = zip.has('xl/_rels/workbook.xml.rels') ? parseXml(await zipText(zip, 'xl/_rels/workbook.xml.rels'), 'spreadsheet links') : null;
    const relationshipTargets = new Map(descendants(relationships || document.implementation.createDocument('', '', null), 'Relationship').map(rel => [rel.getAttribute('Id'), normalizeZipPath('xl/' + rel.getAttribute('Target'))]));
    const sheetNodes = workbook ? descendants(workbook, 'sheet') : [];
    const sheets = sheetNodes.map((sheet, index) => ({ name: sheet.getAttribute('name') || 'Sheet ' + (index + 1), path: relationshipTargets.get(sheet.getAttribute('r:id')) || relationshipTargets.get(sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')) })).filter(sheet => sheet.path && zip.has(sheet.path));
    if (!sheets.length) sheets.push(...[...zip.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort().map((path, index) => ({ name: 'Sheet ' + (index + 1), path })));
    const rendered = [], textBlocks = [];
    for (const sheet of sheets.slice(0, 20)) {
      const xml = parseXml(await zipText(zip, sheet.path), 'spreadsheet sheet'), rows = descendants(xml, 'row').slice(0, 1000), matrix = [];
      for (const row of rows) {
        const cells = [...row.children].filter(cell => cell.localName === 'c'), values = [];
        for (const cell of cells) {
          const ref = cell.getAttribute('r') || '', letters = (ref.match(/^[A-Z]+/i) || ['A'])[0].toUpperCase(); let col = 0;
          for (const char of letters) col = col * 26 + char.charCodeAt(0) - 64;
          col = Math.min(39, Math.max(1, col) - 1);
          const valueNode = [...cell.children].find(node => node.localName === 'v'), raw = valueNode?.textContent || '';
          const value = cell.getAttribute('t') === 's' ? shared[Number(raw)] || '' : cell.getAttribute('t') === 'inlineStr' ? innerText(cell) : raw;
          values[col] = value;
        }
        if (values.length) matrix.push(values.map(value => String(value || '')));
      }
      const content = matrix.map(row => row.join('\t')).join('\n'); textBlocks.push(sheet.name + '\n' + content);
      const table = matrix.length ? '<table><tbody>' + matrix.map((row, i) => '<tr>' + row.map(cell => '<' + (i === 0 ? 'th' : 'td') + '>' + esc(cell) + '</' + (i === 0 ? 'th' : 'td') + '>').join('') + '</tr>').join('') + '</tbody></table>' : '<p class="office-empty">No readable cells were found.</p>';
      rendered.push('<section class="office-sheet"><h2>' + esc(sheet.name) + '</h2>' + table + '</section>');
    }
    return { text: textBlocks.join('\n\n'), html: rendered.join('') || '<p class="office-empty">No readable sheets were found.</p>' };
  }

  const originalReaderBody = readerBody;
  readerBody = function (doc) {
    if (OFFICE_TYPES.includes(doc?.type)) return '<article id="office-reader-content" class="office-reader-content"><p>Preparing document preview…</p></article>';
    return originalReaderBody(doc);
  };
  const originalOpenDocument = openDocument;
  openDocument = async function (docId, fragment = null) {
    const doc = data.docs.find(item => item.id === docId), ext = doc?.name?.split('.').pop()?.toLowerCase();
    if (doc && doc.type === 'file' && OFFICE_TYPES.includes(ext)) { doc.type = ext; save(); }
    const opened = await originalOpenDocument(docId, fragment);
    const current = data.docs.find(item => item.id === docId);
    if (!current || !OFFICE_TYPES.includes(current.type) || view !== 'reader' || data.selected?.id !== docId) return opened;
    const token = readerLoadToken, area = document.querySelector('#office-reader-content');
    if (area) area.innerHTML = '<p>Opening this file…</p>';
    try {
      const blob = await getDocumentBlob(current);
      if (!blob) throw Error('The original file is not available in project storage.');
      const parsed = await parseOfficeDocument(current.type, blob);
      if (token !== readerLoadToken || view !== 'reader' || data.selected?.id !== docId) return;
      current.blob = blob; readingText = parsed.text.slice(0, 1000000);
      if (readingText.trim()) await rememberDocumentText(docId, readingText); else await forgetDocumentText(docId);
      current.searchTextVersion = INDEX_VERSION; current.searchTextEmpty = !readingText.trim(); save();
      const target = document.querySelector('#office-reader-content'); if (target) { target.innerHTML = parsed.html; target.dataset.readerReady = 'true'; }
      refreshReaderSearch();
    } catch (error) {
      if (token !== readerLoadToken || view !== 'reader' || data.selected?.id !== docId) return;
      const target = document.querySelector('#office-reader-content');
      if (target) target.innerHTML = '<div class="office-preview-error"><h2>Preview could not be opened</h2><p>' + esc(error.message || 'This office file may be damaged.') + '</p></div>';
    }
  };

  let ocrWorkerPromise = null, ocrNoticeShown = false;
  const pdfPageTextJobs = new Map();
  async function getOcrWorker(valid = () => true) {
    if (!valid()) return null;
    await loadLocalScript('./vendor/ocr/tesseract.min.js', () => !!window.Tesseract?.createWorker);
    if (!valid()) return null;
    if (!window.Tesseract?.createWorker) throw Error('The on-device OCR engine did not load.');
    if (!ocrWorkerPromise) {
      const base = new URL('./vendor/ocr/', document.baseURI).href;
      const pending = Promise.resolve(window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base + 'tesseract-core.wasm.js',
        langPath: base + 'tessdata/', gzip: true, workerBlobURL: false, logger: () => {}
      }));
      ocrWorkerPromise = pending;
      pending.catch(() => { if (ocrWorkerPromise === pending) ocrWorkerPromise = null; });
    }
    return ocrWorkerPromise;
  }
  function stopOcrWorker() {
    const pending = ocrWorkerPromise;
    ocrWorkerPromise = null;
    if (pending) pending.then(worker => worker?.terminate()).catch(() => {});
  }
  // The Reader requests OCR only for a text-poor page needed by an active tool.
  // Opening a PDF never starts an OCR worker or reads the rest of the book.
  window.NotejectPdfText = {
    async recognizePage(page, existingText = '', { valid = () => true, signal } = {}) {
      const live = () => !signal?.aborted && valid();
      if (!live() || String(existingText).replace(/\s/g, '').length >= 24) return existingText;
      let canvas, renderTask;
      const cancelled = {}, cancellation = new Promise(resolve => {
        cancelled.resolve = () => resolve(cancelled);
      });
      const abort = () => {
        try { renderTask?.cancel(); } catch {}
        stopOcrWorker();
        cancelled.resolve();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!live()) return existingText;
        const baseViewport = page.getViewport({ scale: 1 });
        const width = Math.max(1, baseViewport.width), height = Math.max(1, baseViewport.height);
        const scale = Math.min(2, 1800 / Math.max(width, height), Math.sqrt(2000000 / (width * height)));
        const viewport = page.getViewport({ scale });
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw Error('Could not create a canvas for the scanned page.');
        if (!live()) return existingText;
        renderTask = page.render({ canvasContext: context, viewport });
        await Promise.race([renderTask.promise, cancellation]);
        if (!live()) return existingText;
        if (!ocrNoticeShown) { notify('Reading scanned PDF pages with on-device OCR…'); ocrNoticeShown = true; }
        const worker = await Promise.race([getOcrWorker(live), cancellation]);
        if (!live() || !worker || worker === cancelled) return existingText;
        const result = await Promise.race([worker.recognize(canvas), cancellation]);
        if (!live() || result === cancelled) return existingText;
        const text = String(result?.data?.text || '').trim();
        return text ? (existingText ? existingText + '\n' + text : text) : existingText;
      } catch (error) {
        if (live()) console.debug('Local PDF OCR skipped page', page.pageNumber, error?.message || error);
        return existingText;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }
  };
  async function extractPdfPages(blob, docId) {
    if (pdfPageTextJobs.has(docId)) return pdfPageTextJobs.get(docId);
    const job = extractPdfPagesInternal(blob, docId).finally(() => pdfPageTextJobs.delete(docId));
    pdfPageTextJobs.set(docId, job); return job;
  }
  async function extractPdfPagesInternal(blob, docId) {
    const activePdf = docId && pdfDoc?.documentId === docId && pdfDoc.doc ? pdfDoc : null;
    let pdf, ownsPdf = false;
    if (activePdf) pdf = activePdf.doc;
    else {
      const engine = await window.NotejectMuPdf.open({ blob, documentId: docId, cacheKey: String(docId || '') + ':' + blob.size, mobile: !!window.NotejectAndroid });
      pdf = engine.document; ownsPdf = true;
    }
    const pages = [], errors = []; let scannedPages = 0, totalLength = 0;
    try {
      if (!activePdf && pdf.numPages > 120) {
        const deferred = data.docs.find(doc => doc.id === docId);
        if (deferred) { deferred.readerPages = pdf.numPages; deferred.searchTextDeferred = true; deferred.searchTextVersion = INDEX_VERSION; }
        return null;
      }
      for (let number = 1; number <= pdf.numPages && totalLength < 1000000; number++) {
        const page = await pdf.getPage(number);
        try {
          const content = await page.getTextContent();
          let pageText = content.items.map(item => item.str || '').filter(Boolean).join(' ').trim();
          if (pageText.replace(/\s/g, '').length < 24) {
            if (!ocrNoticeShown) { notify('Reading scanned PDF pages with on-device OCR…'); ocrNoticeShown = true; }
            let canvas;
            try {
              const worker = await getOcrWorker(), baseViewport = page.getViewport({ scale: 1 });
              const scale = Math.max(0.5, Math.min(2, 2200 / Math.max(baseViewport.width, baseViewport.height)));
              const viewport = page.getViewport({ scale });
              canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
              const context = canvas.getContext('2d', { willReadFrequently: true });
              if (!context) throw Error('Could not create a canvas for the scanned page.');
              await page.render({ canvasContext: context, viewport }).promise;
              const result = await worker.recognize(canvas), ocrText = String(result?.data?.text || '').trim();
              if (ocrText) { pageText = pageText ? pageText + '\n' + ocrText : ocrText; scannedPages++; }
            } catch (error) { errors.push(error); console.debug('Local PDF OCR skipped page', number, error?.message || error); }
            finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
          }
          pages.push(pageText); totalLength += pageText.length + 2;
        } finally {
          if (activePdf) { if (activePdf === pdfDoc) pdfReader?.releaseIndexedPage?.(number, page); }
          else page.cleanup();
        }
        if (number % 4 === 0) await new Promise(resolve => setTimeout(resolve, window.NotejectAndroid ? 45 : 0));
      }
    } finally { if (ownsPdf) await pdf.destroy(); }
    if (scannedPages) notify('On-device OCR made ' + scannedPages + ' scanned PDF page' + (scannedPages === 1 ? '' : 's') + ' searchable.');
    else if (errors.length && ocrNoticeShown) notify('On-device OCR could not read some scanned pages.');
    return pages;
  }
  const originalIndexPdfText = indexPdfText;
  indexPdfText = async function (doc, state, token) {
    await originalIndexPdfText(doc, state, token);
    if (token !== readerLoadToken || state !== pdfDoc || !state.indexComplete) return;
    doc.searchTextVersion = INDEX_VERSION; doc.searchTextEmpty = !state.text.join('\n\n').trim();
    delete doc.searchTextDeferred; save();
  };
  async function extractDocumentText(doc, blob = null) {
    blob = blob || await getDocumentBlob(doc);
    if (!blob) return '';
    if (doc.type === 'txt') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return (bytes[0] === 255 && bytes[1] === 254 ? new TextDecoder('utf-16le').decode(bytes.subarray(2)) : bytes[0] === 254 && bytes[1] === 255 ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')).slice(0, 1000000);
    }
    if (doc.type === 'pdf') {
      const pages = await extractPdfPages(blob, doc.id);
      if (!Array.isArray(pages)) return '';
      if (pdfDoc?.documentId === doc.id) {
        pdfDoc.text = pages;
        readingText = pages.map((text, index) => '[Page ' + (index + 1) + ']\n' + text).join('\n\n').slice(0, 1000000);
        refreshReaderSearch();
      }
      return pages.map((text, index) => '[Page ' + (index + 1) + ']\n' + text).join('\n\n').slice(0, 1000000);
    }
    if (doc.type === 'epub') {
      const chapters = await readEpub(blob), output = [];
      for (const chapter of chapters) {
        const parsed = parseEpubChapter(await zipText(chapter.zip, chapter.path));
        parsed.document.querySelectorAll('script,style,nav').forEach(node => node.remove());
        output.push((parsed.document.body?.textContent || '').replace(/\s+/g, ' ').trim());
        if (output.join('\n').length >= 1000000) break;
      }
      return output.join('\n\n').slice(0, 1000000);
    }
    if (OFFICE_TYPES.includes(doc.type)) return (await parseOfficeDocument(doc.type, blob)).text.slice(0, 1000000);
    return '';
  }

  async function forgetDocumentText(docId) {
    searchTextCache.delete(docId);
    try { const db = await searchIndexDb(); db.transaction('texts', 'readwrite').objectStore('texts').delete(docId); } catch {}
  }
  let indexing = false, indexAgain = false;
  async function indexMissingDocuments() {
    if (indexing) { indexAgain = true; return; }
    indexing = true;
    try {
      do {
        indexAgain = false;
        let dataChanged = false;
        for (const doc of [...data.docs]) {
          const ext = doc.name?.split('.').pop()?.toLowerCase();
          if (doc.type === 'file' && OFFICE_TYPES.includes(ext)) { doc.type = ext; dataChanged = true; }
          if (doc.type === 'pdf') {
            if (!doc.searchTextDeferred && !(doc.searchTextVersion >= INDEX_VERSION && (searchTextCache.has(doc.id) || doc.searchTextEmpty))) {
              doc.searchTextDeferred = true; dataChanged = true;
            }
            continue;
          }
          if (doc.searchTextDeferred || (doc.searchTextVersion >= INDEX_VERSION && (searchTextCache.has(doc.id) || doc.searchTextEmpty))) continue;
          if (!['pdf', 'epub', 'txt', ...OFFICE_TYPES].includes(doc.type)) continue;
          try {
            const blob = await getDocumentBlob(doc);
            if (!blob) continue;
            const text = await extractDocumentText(doc, blob);
            if (!data.docs.includes(doc)) continue;
            if (doc.searchTextDeferred) { dataChanged = true; continue; }
            if (text.trim()) await rememberDocumentText(doc.id, text);
            else await forgetDocumentText(doc.id);
            doc.searchTextVersion = INDEX_VERSION; doc.searchTextEmpty = !text.trim(); dataChanged = true;
          } catch (error) { console.debug('Local indexing skipped for', doc.name, error?.message || error); }
        }
        if (dataChanged) { save(); if (view === 'library') render(); }
      } while (indexAgain);
      if (view === 'search') render(); else if (view === 'smart') smartEngine.refresh();
    } finally { indexing = false; }
  }
  const originalHydrateSearchIndex = hydrateSearchIndex;
  hydrateSearchIndex = async function () { try { await originalHydrateSearchIndex(); } finally { setTimeout(indexMissingDocuments, 300); } };
  let activeImportRun = null;
  function importProgressMarkup(run) {
    const saved = run.saved, failed = run.failed, cancelled = run.cancelledCount;
    const remaining = Math.max(0, run.total - run.completed);
    const progress = run.current && run.running
      ? '<progress max="' + run.total + '" aria-label="Saving file ' + (run.completed + 1) + ' of ' + run.total + '"></progress>'
      : '<progress max="' + run.total + '" value="' + run.completed + '" aria-label="' + run.completed + ' of ' + run.total + ' files processed"></progress>';
    const shownResults = run.results.slice(-100);
    const rows = shownResults.map(item => '<li class="ip-result ip-' + item.status + '"><span>' + esc(item.name) + '</span><small>' + esc(item.status === 'failed' ? item.error : item.status === 'saved' ? 'Saved' : 'Cancelled') + '</small></li>').join('');
    return '<section class="ip-card" role="region" aria-label="File import status" aria-live="polite">' +
      '<header><div><small>' + (run.running ? 'IMPORTING FILES' : run.cancelled ? 'IMPORT CANCELLED' : 'IMPORT COMPLETE') + '</small><b>' + (run.running ? 'Adding ' + run.total + ' files' : saved + ' file' + (saved === 1 ? '' : 's') + ' saved') + '</b></div>' +
      '<button type="button" class="ip-close" data-import-close ' + (run.running ? 'disabled title="Cancel the import before closing"' : 'aria-label="Close import results"') + '>×</button></header>' +
      (run.current ? '<p class="ip-current">' + (run.cancelRequested ? 'Stopping after this file…' : 'Saving file ' + (run.completed + 1) + ' of ' + run.total + ': <b>' + esc(run.current) + '</b>') + '</p>' : '<p class="ip-current">' + (run.running ? 'Preparing the next file…' : saved + ' saved · ' + failed + ' failed' + (cancelled ? ' · ' + cancelled + ' cancelled' : '') + (remaining ? ' · ' + remaining + ' not started' : '')) + '</p>') +
      progress +
      '<div class="ip-counts"><span>' + saved + ' saved</span><span>' + failed + ' failed</span><span>' + remaining + ' remaining</span></div>' +
      (rows ? '<details class="ip-results"' + (run.running ? '' : ' open') + '><summary>File results · ' + run.results.length + ' of ' + run.total + '</summary>' + (run.results.length > shownResults.length ? '<small>Showing the latest 100. Save results for the full list.</small>' : '') + '<ol>' + rows + '</ol></details>' : '') +
      '<footer>' + (run.running ? '<button type="button" class="danger-button" data-import-cancel ' + (run.cancelRequested ? 'disabled' : '') + '>' + (run.cancelRequested ? 'Cancelling…' : 'Cancel import') + '</button>' : '') +
      (!run.running && failed ? '<button type="button" class="secondary" data-import-retry>Retry failed · ' + failed + '</button>' : '') +
      (!run.running && run.results.length ? '<button type="button" class="secondary" data-import-report>Save results</button>' : '') +
      '</footer><small class="ip-hint">Large files may take longer. You can keep using the workspace while the current file saves.</small></section>';
  }
  function renderImportProgress(run) {
    let panel = document.getElementById('noteject-import-progress');
    if (!panel) { panel = document.createElement('aside'); panel.id = 'noteject-import-progress'; panel.className = 'noteject-import-progress'; document.body.append(panel); }
    panel.innerHTML = importProgressMarkup(run);
    panel.querySelector('[data-import-cancel]')?.addEventListener('click', () => {
      if (!run.running || run.cancelRequested) return;
      run.cancelRequested = true; run.controller.abort(); renderImportProgress(run);
    });
    panel.querySelector('[data-import-close]')?.addEventListener('click', () => panel.remove());
    panel.querySelector('[data-import-retry]')?.addEventListener('click', () => {
      const retry = run.results.filter(item => item.status === 'failed').map(item => item.file);
      panel.remove(); importFiles(retry, run.dropAt, { boardId: run.boardId, placeOnBoard: run.placeOnBoard });
    });
    panel.querySelector('[data-import-report]')?.addEventListener('click', () => {
      const report = ['Status\tFile\tDetails', ...run.results.map(item => [item.status, item.name, item.error || ''].join('\t'))].join('\r\n');
      const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a');
      link.href = url; link.download = 'noteject-import-results-' + new Date().toISOString().slice(0, 10) + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }
  importFiles = async function (files, dropAt = null, options = {}) {
    const batch = Array.from(files || []).filter(file => file && typeof file.name === 'string');
    if (!batch.length) { notify('No files selected'); return; }
    if (activeImportRun?.running) { notify('Wait for the current file import to finish or cancel it first.'); return; }
    const board = data.boards.find(item => item.id === options.boardId) || activeBoard();
    const placeOnBoard = options.placeOnBoard ?? (view === 'board' || !!dropAt);
    const run = activeImportRun = { total: batch.length, completed: 0, saved: 0, failed: 0, cancelledCount: 0, current: '', results: [], dropAt, boardId: board?.id, placeOnBoard, running: true, cancelRequested: false, cancelled: false, controller: new AbortController() };
    renderImportProgress(run);
    for (const file of batch) {
      if (run.cancelRequested) break;
      run.current = file.name; renderImportProgress(run);
      const ext = file.name.toLowerCase().split('.').pop();
      const type = attachmentKinds[ext] || (file.type?.startsWith('image/') ? 'image' : file.type?.startsWith('video/') ? 'video' : file.type?.startsWith('audio/') ? 'audio' : file.type === 'text/plain' ? 'txt' : 'file');
      const folder = libraryFolder === 'All documents' ? 'Inbox' : libraryFolder;
      data.folderProjects = data.folderProjects || {};
      data.folderProjects.Inbox = data.folderProjects.Inbox || 'folder-inbox';
      const doc = { id: id(), name: file.name, type, size: file.size, added: Date.now(), folder, favorite: false, diskProject: data.folderProjects[folder] || projectFolder(board) };
      try {
        if (window.NotejectAndroid || window.NotejectWebApp) {
          await storeFile(doc.id, file);
          doc.blob = file; doc.localUrl = URL.createObjectURL(file);
        } else {
          const url = diskApiBase + '/api/files?project=' + encodeURIComponent(doc.diskProject) + '&id=' + encodeURIComponent(doc.id) + '&name=' + encodeURIComponent(doc.name);
          const response = await fetch(url, { method: 'POST', body: file, signal: run.controller.signal });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(result.error || 'Project-file service returned HTTP ' + response.status);
          doc.diskName = result.name || doc.name;
          if (['pdf', 'epub', 'txt'].includes(type)) doc.blob = file;
        }
        data.docs.push(doc);
        const offset = run.results.filter(item => item.status === 'saved').length;
        const x = dropAt ? dropAt.x + (offset % 4) * 230 : 140 + Math.random() * 270;
        const y = dropAt ? dropAt.y + Math.floor(offset / 4) * 180 : 100 + Math.random() * 180;
        if (placeOnBoard && board) board.items.push({ type: 'doc', id: doc.id, x, y });
        run.results.push({ file, name: file.name, status: 'saved', error: '' });
        run.saved++;
        save();
      } catch (error) {
        const aborted = run.cancelRequested || error?.name === 'AbortError';
        run.results.push({ file, name: file.name, status: aborted ? 'cancelled' : 'failed', error: aborted ? 'Cancelled before this file finished saving.' : String(error?.message || 'Could not save file').slice(0, 300) });
        if (aborted) run.cancelledCount++; else run.failed++;
        if (aborted) run.cancelled = true;
      }
      run.completed++; run.current = ''; renderImportProgress(run);
      if (run.cancelled) break;
    }
    run.running = false; run.current = ''; run.cancelled = run.cancelled || run.cancelRequested;
    if (run.results.some(item => item.status === 'saved')) { render(); setTimeout(indexMissingDocuments, 50); }
    activeImportRun = null; renderImportProgress(run);
    const saved = run.saved, failed = run.failed, remaining = run.total - run.completed;
    notify(saved + ' saved · ' + failed + ' failed' + (run.cancelled ? ' · import cancelled' : '') + (remaining ? ' · ' + remaining + ' not started' : ''));
  };
  async function ensureProjectStorage(folder) {
    data.folderProjects = data.folderProjects || { Inbox: 'folder-inbox' };
    if (data.folderProjects[folder]) return data.folderProjects[folder];
    const slug = String(folder).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'project';
    const project = 'project-' + slug + '-' + id().slice(0, 8);
    if (!window.NotejectAndroid && !window.NotejectWebApp) {
      const response = await fetch(diskApiBase + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || 'Could not prepare storage for this project.');
    }
    data.folderProjects[folder] = project;
    return project;
  }

  async function moveDocumentToProject(doc, folder, targetProject) {
    if (!window.NotejectAndroid && !window.NotejectWebApp) {
      if (doc.diskProject && doc.diskProject !== targetProject) {
        const response = await fetch(diskApiBase + '/api/files/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromProject: doc.diskProject, toProject: targetProject, id: doc.id, name: doc.diskName || doc.name }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || 'Could not move the attachment (HTTP ' + response.status + ').');
        doc.diskName = result.name || doc.diskName || doc.name;
      } else if (!doc.diskProject) {
        const blob = await getDocumentBlob(doc);
        if (!blob) throw Error('The original file is not available on this device.');
        const result = await saveDiskFile(blob, { ...doc, diskProject: targetProject });
        doc.diskName = result.name || doc.name;
      }
    }
    doc.folder = folder;
    doc.diskProject = targetProject;
  }

  let inboxMoveRunning=false;
  async function moveInboxItems(selected, folder, button) {
    if(inboxMoveRunning)return;
    if(!folder){notify('Choose a destination project first.');return;}
    selected=selected.filter(key=>key.startsWith('note:')?data.notes.some(note=>note.id===key.slice(5)&&(note.folder||'Inbox')==='Inbox'&&!note.archived):key.startsWith('document:')&&data.docs.some(doc=>doc.id===key.slice(9)&&(doc.folder||'Inbox')==='Inbox'));
    if(!selected.length)return;
    inboxMoveRunning=true;selected.forEach(key=>inboxSelection.add(key));
    const inboxRoot=document.querySelector('[data-inbox-root]');if(inboxRoot)inboxRoot.inert=true;
    if(button)button.disabled=true;
    const noteIds = new Set(selected.filter(key => key.startsWith('note:')).map(key => key.slice(5)));
    const docIds = new Set(selected.filter(key => key.startsWith('document:')).map(key => key.slice(9)));
    const canonical = [...(data.folders || []), ...(data.noteFolders || [])].find(name => name.toLocaleLowerCase() === folder.toLocaleLowerCase()) || folder;
    data.folders = data.folders || ['Inbox']; data.noteFolders = data.noteFolders || ['Inbox'];
    if (!data.folders.includes(canonical)) data.folders.push(canonical);
    if (!data.noteFolders.includes(canonical)) data.noteFolders.push(canonical);
    let movedDocs = 0, movedNotes = 0; const failures = [];
    try {
      const targetProject = await ensureProjectStorage(canonical);
      for (const doc of data.docs.filter(item => docIds.has(item.id))) {
        try { await moveDocumentToProject(doc, canonical, targetProject); movedDocs++; inboxSelection.delete('document:' + doc.id); save(); }
        catch (error) { failures.push((doc.name || 'File') + ': ' + (error.message || 'could not move')); }
      }
      const notesToMove = data.notes.filter(note => noteIds.has(note.id) && (note.folder || 'Inbox') !== canonical);
      if (window.NotejectAndroid) {
        for (const note of notesToMove) { note.folder = canonical; note.updated = Date.now(); movedNotes++; inboxSelection.delete('note:' + note.id); }
      } else if (notesToMove.length) {
        if (await moveNotesToFolder(notesToMove.map(note => note.id), canonical)) {
          movedNotes = notesToMove.length;
          for (const note of notesToMove) inboxSelection.delete('note:' + note.id);
        } else failures.push(notesToMove.length + ' note' + (notesToMove.length === 1 ? ' could not be moved' : 's could not be moved'));
      }
      save(); render();
      const count = movedDocs + movedNotes;
      if (!count && !failures.length) notify('The selected items are already in ' + canonical + '.');
      else notify(count + ' item' + (count === 1 ? '' : 's') + ' moved to ' + canonical + (failures.length ? ' · ' + failures.length + ' not moved: ' + failures[0].slice(0, 140) : ''));
    } catch (error) { if(button)button.disabled = false; notify(error.message || 'Could not prepare the destination project.'); } finally { inboxMoveRunning=false; if(inboxRoot?.isConnected)inboxRoot.inert=false; }
  }
  window.NotejectInboxMoves=Object.freeze({move:moveInboxItems});
  document.addEventListener('click', async event => {
    const button=event.target?.closest?.('[data-inbox-move]');if(!button)return;
    event.preventDefault();event.stopImmediatePropagation();
    await moveInboxItems([...inboxSelection],document.querySelector('#inbox-destination')?.value,button);
  }, true);

  document.addEventListener('click', async event => {
    const button = event.target?.closest?.('#move-confirm');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.disabled) return;
    const overlay = button.closest('#move-documents-overlay'), folder = overlay?.querySelector('#move-folder-select')?.value;
    if (!overlay || !folder) { notify('Choose a destination project.'); return; }
    button.disabled = true; button.textContent = 'Moving…';
    let moved = 0; const failures = [];
    try {
      const targetProject = await ensureProjectStorage(folder), ids = new Set(selectedDocs);
      for (const doc of data.docs.filter(item => ids.has(item.id))) {
        try { await moveDocumentToProject(doc, folder, targetProject); moved++; save(); }
        catch (error) { failures.push((doc.name || 'File') + ': ' + (error.message || 'could not move')); }
      }
      libraryFolder = folder; selectedDocs.clear(); overlay.remove(); render();
      if (failures.length) notify(moved + ' moved · ' + failures.length + ' could not move: ' + failures[0].slice(0, 150));
      else notify(moved + ' document' + (moved === 1 ? '' : 's') + ' moved to ' + folder);
    } catch (error) { button.disabled = false; button.textContent = 'Move documents'; notify(error.message || 'Could not move these documents.'); }
  }, true);

  document.addEventListener('click', async event => {
    const button = event.target?.closest?.('[data-trash-discard]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const entry = ensureTrash().find(item => item.id === button.dataset.trashDiscard);
    if (!entry || !await window.NotejectDialogs.confirm('Permanently delete this item? This cannot be undone.')) return;
    button.disabled = true;
    try { await permanentlyDeleteTrashEntry(entry); save(); render(); notify('Item permanently deleted'); }
    catch (error) { button.disabled = false; notify(error.message || 'The file could not be deleted. It remains in Trash.'); }
  }, true);

  function showStorageRecovery() {
    if (!storageRecovery || document.getElementById('workspace-recovery-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'workspace-recovery-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:24px;background:rgba(7,9,14,.82);backdrop-filter:blur(8px)';
    overlay.innerHTML = '<section role="alertdialog" aria-modal="true" aria-labelledby="workspace-recovery-title" style="width:min(560px,100%);padding:28px;border:1px solid #45485b;border-radius:18px;background:#1b1d25;color:#f4f2ff;box-shadow:0 24px 80px #0009"><div style="color:#c0a7ff;font-size:12px;font-weight:700;letter-spacing:.12em">WORKSPACE RECOVERY</div><h2 id="workspace-recovery-title" style="margin:10px 0">Your saved workspace needs recovery</h2><p id="workspace-recovery-reason" style="color:#c3c2ce;line-height:1.5"></p><p style="color:#c3c2ce;line-height:1.5">Noteject has paused automatic saving so the damaged workspace data is not overwritten. Download a copy first, then load a backup or deliberately start an empty workspace.</p><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:22px"><button type="button" class="secondary" data-recovery-download>Download damaged data</button><button type="button" class="secondary" data-recovery-backup>Load backup…</button><button type="button" class="primary" data-recovery-empty>Start empty</button></div></section>';
    overlay.querySelector('#workspace-recovery-reason').textContent = storageRecovery.reason || 'The saved workspace could not be read.';
    overlay.querySelector('[data-recovery-download]').onclick = () => {
      if (typeof storageRecovery?.raw !== 'string') { notify('The damaged data could not be copied.'); return; }
      const url = URL.createObjectURL(new Blob([storageRecovery.raw], { type: 'text/plain;charset=utf-8' })), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'noteject-damaged-workspace.txt'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    overlay.querySelector('[data-recovery-backup]').onclick = () => document.getElementById('backup-picker')?.click();
    overlay.querySelector('[data-recovery-empty]').onclick = async () => {
      if (!await window.NotejectDialogs.confirm('Start with an empty workspace? The damaged saved data will be replaced. Download a copy first if you may need it.')) return;
      const previous = storageRecovery; storageRecovery = null; data = structuredClone(initial);
      workspaceStore.schedule();
      if (!workspaceStore.flush()) { storageRecovery = previous; notify('The empty workspace could not be saved. Your previous data is still protected.'); return; }
      overlay.remove(); view = 'home'; render(); notify('Started a new empty workspace');
    };
    document.body.append(overlay);
  }

  const loadBackupWithRecovery = loadWorkspaceBackup;
  loadWorkspaceBackup = async function (file, options) {
    const before = data, previousRecovery = storageRecovery;
    const restored = await loadBackupWithRecovery(file, options);
    if (!previousRecovery || data === before) return restored;
    storageRecovery = null;
    if (!workspaceStore.flush()) {
      storageRecovery = previousRecovery;
      notify('The backup was opened, but Noteject could not save it. Your previous data is still protected.');
      showStorageRecovery();
      return false;
    }
    document.getElementById('workspace-recovery-overlay')?.remove();
    return restored;
  };

  if (storageRecovery) showStorageRecovery();

  const backupButton = document.getElementById('backup');
  if (backupButton) backupButton.onclick = () => exportWorkspaceBackup();
  setTimeout(indexMissingDocuments, 500);
})();
