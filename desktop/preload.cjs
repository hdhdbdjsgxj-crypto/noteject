'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const filePort = Number(new URLSearchParams(window.location.search).get('desktopFilePort'));
if (!Number.isInteger(filePort) || filePort < 1 || filePort > 65535) {
  throw new Error('Noteject project-file service was not configured.');
}

const supportedCommands = new Set([
  'new-note', 'new-project', 'new-board', 'import', 'export-backup', 'load-backup',
  'settings', 'home', 'notes', 'library', 'projects', 'boards', 'graph', 'search',
  'save-note', 'undo', 'redo', 'select-all', 'find-reader', 'bookmark-reader', 'focus-reader',
  'reader-zoom-in', 'reader-zoom-out', 'fit-board', 'board-zoom-in', 'board-zoom-out',
  'toggle-sidebar', 'command-palette', 'help-shortcuts'
]);
const versionArgument = process.argv.find(value => value.startsWith('--noteject-version='));
let version = '';
try { version = decodeURIComponent(versionArgument?.slice('--noteject-version='.length) || ''); }
catch {}

window.addEventListener('pagehide', () => ipcRenderer.send('noteject:command-ready', false));

contextBridge.exposeInMainWorld('NotejectDesktop', Object.freeze({
  fileApiBase: `http://127.0.0.1:${filePort}`,
  platform: process.platform,
  version,
  setAppLanguage(language) {
    if (typeof language === 'string' && /^[a-z]{2}$/.test(language)) ipcRenderer.send('noteject:set-language', language);
  },
  onCommand(handler) {
    if (typeof handler !== 'function') throw new TypeError('A desktop command handler is required.');
    const receive = (_event, payload) => {
      if (!payload || !supportedCommands.has(payload.command)) return;
      handler(Object.freeze({ command: payload.command }));
    };
    ipcRenderer.on('noteject:command', receive);
    return () => ipcRenderer.removeListener('noteject:command', receive);
  },
  setCommandReady(ready) {
    if (typeof ready !== 'boolean') throw new TypeError('Desktop command readiness must be true or false.');
    ipcRenderer.send('noteject:command-ready', ready);
  },
  chooseDirectory() {
    return ipcRenderer.invoke('noteject:choose-directory');
  }
}));
