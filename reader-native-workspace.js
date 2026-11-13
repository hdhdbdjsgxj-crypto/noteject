/* Workspace data contract for the shared native PDF/DjVu Reader. */
(function (global) {
  'use strict';
  function create(app) {
    let opening = null, eventQueue = Promise.resolve();
    const applied = () => app.getData().nativeReaderAppliedEvents ||= [];
    function acknowledge(event) { if (event.eventId) global.NotejectNativeReader?.acknowledge([event.eventId]); }
    async function commitEvent(event) {
      const data = app.getData();
      app.save();
      if (!app.flush()) throw new Error('Reader changes are kept on this device and will retry saving to the workspace.');
      const noteId = data.nativeReaderPendingNotes?.[event.eventId];
      const note = noteId && data.notes.find(item => item.id === noteId);
      if (note) await app.persistNote(note);
      if (noteId) {
        delete data.nativeReaderPendingNotes[event.eventId]; app.save();
        if (!app.flush()) throw new Error('The passage is saved in Notes; its workspace update will retry.');
      }
      acknowledge(event);
      if (event.type === 'closed') app.refresh();
      if (event.type === 'editNote') app.editNote?.(event.id);
    }
    async function applyEventNow(event) {
      if (!event || typeof event !== 'object' || !event.eventId || typeof event.documentId !== 'string') return;
      const data = app.getData(), doc = data.docs.find(item => item.id === event.documentId);
      if (event.workspaceGeneration && event.workspaceGeneration !== (data.attachmentImportId || 'original')) { acknowledge(event); return; }
      if (event.sourceRevision && doc?.sourceRevision && event.sourceRevision !== doc.sourceRevision) { acknowledge(event); return; }
      if (applied().includes(event.eventId)) return commitEvent(event);
      let note = null;
      if (doc) {
        if (event.type === 'progress') {
          doc.readerPage = Math.max(1, Math.trunc(Number(event.page) || 1));
          doc.readerPages = Math.max(doc.readerPage, Math.trunc(Number(event.pages) || 1));
          doc.readerPageOffset = Math.max(0, Math.min(1, Number(event.offset) || 0));
          doc.nativeReaderZoom = Math.max(1, Math.min(8, Number(event.zoom) || 1));
          doc.nativeReaderUpdated = Number(event.updated) || Date.now();
          app.progress(doc, { pages: doc.readerPages, page: doc.readerPage, offset: doc.readerPageOffset });
        } else if (event.type === 'bookmark' && event.bookmark?.id) {
          doc.bookmarks ||= [];
          if (!doc.bookmarks.some(item => item.id === event.bookmark.id)) doc.bookmarks.unshift(event.bookmark);
        } else if (event.type === 'deleteBookmark') {
          doc.bookmarks = (doc.bookmarks || []).filter(item => item.id !== event.id);
        } else if (event.type === 'selection' && event.passage) {
          const passage = event.passage;
          if (!data.notes.some(item => item.id === passage.id)) {
            const draft = { title: passage.title, quote: passage.quote, comment: passage.comment, tags: passage.tags, color: passage.color,
              location: passage.location, folder: passage.folder || doc.folder || 'Inbox' };
            const requestedBoard = passage.addToBoard === true;
            const board = requestedBoard && data.boards.find(item => item.id === passage.boardId);
            let passageId = passage.id;
            const result = global.NotejectReaderSelectionModel.saveSelection(data, { docId: doc.id, draft, addToBoard: !!board, boardId: board?.id, preserveAnnotation: true }, () => {
              const value = passageId; passageId = null; return value || app.makeId();
            }, Date.now());
            if (result.ok) {
              note = result.note;doc.readerPassageFolder = note.folder;
              if (typeof passage.addToBoard === 'boolean') doc.readerPassageBoardId = board?.id || '';
              if (requestedBoard && !board) app.notify('Passage saved in Notes. The selected Board no longer exists.');
              data.noteFolders ||= ['Inbox']; data.folders ||= ['Inbox'];
              if (!data.noteFolders.includes(note.folder)) data.noteFolders.push(note.folder);
              if (!data.folders.includes(note.folder)) data.folders.push(note.folder);
            } else if (result.duplicate) note = data.notes.find(item => item.id === result.duplicate);
            else if (result.error) app.notify(result.error);
          }
        } else if (event.type === 'capture') {
          note = await global.NotejectNoteMedia.importReaderCapture(event, doc);
        } else if (event.type === 'addPassagesToBoard') {
          const result = global.NotejectReaderSelectionModel.addSelectionsToBoard(data, doc.id, event.boardId, app.makeId);
          app.notify(result.ok ? 'Saved passages connected on ' + result.board.name : result.error);
        } else if (event.type === 'deletePassage') {
          app.deleteNote(event.id);
        } else if (event.type === 'indexReady' && app.indexDocumentText) {
          await app.indexDocumentText(doc, event);
        } else if (event.type === 'error') app.notify(event.message || 'The Reader could not open this document.');
      }
      applied().push(event.eventId);
      if (applied().length > 2000) applied().splice(0, applied().length - 2000);
      if (note) { data.nativeReaderPendingNotes ||= {}; data.nativeReaderPendingNotes[event.eventId] = note.id; }
      return commitEvent(event);
    }
    function applyEvent(event) {
      const task = eventQueue.then(() => applyEventNow(event));
      eventQueue = task.catch(error => app.notify(error.message));
      return eventQueue;
    }
    global.addEventListener('noteject-native-reader', event => applyEvent(event.detail));

    async function open(doc, location = {}) {
      if (opening?.documentId === doc.id) return opening.promise;
      if (!global.NotejectNativeReader?.available()) { app.notify('The native Reader is missing. Install the current APK.'); return false; }
      global.NotejectNativeReader.drain();
      opening?.controller.abort();
      const controller = new AbortController();
      document.getElementById('native-reader-opening')?.remove();
      const overlay = document.createElement('div'); overlay.id = 'native-reader-opening'; overlay.className = 'native-reader-opening';
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Opening document');
      const card = document.createElement('section'), title = document.createElement('h2'), label = document.createElement('p');
      title.textContent = 'Opening document…'; label.textContent = doc.name;
      const progress = document.createElement('progress'); progress.removeAttribute('value');
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => { controller.abort(); overlay.remove(); };
      card.append(title, label, progress, cancel); overlay.append(card); document.body.append(overlay);
      const session = { documentId: doc.id, controller, promise: null }; opening = session;
      session.promise = (async () => {
        try {
          await eventQueue;
          if (controller.signal.aborted) throw new DOMException('The document was closed.', 'AbortError');
          if (!doc.sourceRevision) {
            if (app.ensureRevision) { if (!app.ensureRevision(doc)) throw new Error('The reading draft could not be preserved. Free some storage and try again.'); }
            else doc.sourceRevision = app.makeId();
          }
          doc.lastOpened = doc.readAt = Date.now(); if (doc.readingStatus !== 'finished') doc.readingStatus = 'reading';
          app.visit(doc); app.save(); app.flush();
          const passages = global.NotejectReaderSelectionModel.selectionsFor(app.getData(), doc).map(note => {
            const clip = global.NotejectReaderSelectionModel.normalize(note);
            return { id: note.id, title: clip.title, quote: clip.quote, comment: clip.comment, tags: clip.tags, folder: clip.folder, color: clip.color, location: clip.location };
          });
          await global.NotejectNativeReader.open({ document: doc, getBlob: () => app.getBlob(doc), signal: controller.signal,
            page: location.page ?? doc.readerPage, offset: location.offset ?? doc.readerPageOffset,
            zoom: doc.nativeReaderZoom || 1, bookmarks: doc.bookmarks || [], passages,
            boards: app.getData().boards.map(board => ({ id: board.id, name: board.name })),
            notes: app.getData().notes.filter(note => !note.archived).sort((a,b) => Number(b.folder === doc.folder) - Number(a.folder === doc.folder) || (b.updated || 0) - (a.updated || 0)).map(note => ({ id:note.id, title:note.title || 'Untitled note', folder:note.folder || 'Inbox' })),
            readerMenu: global.NotejectReaderMenu.forType(doc.type),readerWorkflow:global.NotejectReaderMenu.workflow,
            passageFolder: doc.readerPassageFolder || doc.folder || 'Inbox',
            noteFolders: [...new Set(['Inbox',...(app.getData().noteFolders||[]),...(app.getData().folders||[])])],
            passageBoardId: doc.readerPassageBoardId || '',
            captureBoardId: doc.readerCaptureBoardId || '',
            defaultBoardId: (app.getData().boards.find(board => board.items?.some(item => item.id === doc.id)) || app.getData().boards.find(board => board.id === app.getData().activeBoard) || app.getData().boards[0])?.id || '',
            forceLocation: !!location.forceLocation, quote: location.quote || '', textOffset: location.textOffset, selectionLocation: location.selectionLocation || null, passageSourceRevision: location.sourceRevision || '', progressUpdatedAt: doc.nativeReaderUpdated || 0,
            workspaceGeneration: app.getData().attachmentImportId || 'original',
            onProgress: state => {
              if (state.phase === 'copy') { title.textContent = 'Preparing this saved document…'; progress.max = state.total; progress.value = state.loaded; label.textContent = `${doc.name} · ${Math.round(state.loaded / state.total * 100)}%`; }
            } });
          overlay.remove(); return true;
        } catch (error) {
          if (error.name === 'AbortError') { overlay.remove(); return false; }
          title.textContent = 'Could not open document'; label.textContent = error.message; progress.remove(); cancel.textContent = 'Close';
          const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.textContent = doc.type === 'djvu' ? 'Choose original DjVu' : 'Choose original PDF';
          reconnect.onclick = () => { overlay.remove(); app.reconnect(doc); }; card.insertBefore(reconnect, cancel);
          return false;
        } finally { if (opening === session) opening = null; }
      })();
      return session.promise;
    }
    return { open, applyEvent };
  }
  global.NotejectNativeReaderWorkspace = Object.freeze({ create });
})(window);
