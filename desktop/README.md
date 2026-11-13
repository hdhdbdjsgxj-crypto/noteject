# noteject for Windows

The Windows build uses Electron with the normal Windows title bar, window borders, Snap controls, Alt+Space window menu, and a native application menu. It runs the workspace and project attachment services locally. The Android interface is independent of this desktop shell.

## Application menus

- **File:** new note, project, board, file import, save note, workspace backups, and Settings.
- **Edit:** note and board undo/redo, clipboard actions, workspace search, and command palette.
- **View:** navigation pane, interface scale, full screen, and reload.
- **Go:** Home, All notes, Documents, Projects, Boards, and Graph view.
- **Board:** create a board, fit its contents, and zoom.
- **Reader:** search, bookmark, focus reading, and document size.
- **Help:** keyboard shortcuts and the installed version.

Common Windows shortcuts include Ctrl+N for a note, Ctrl+Shift+N for a project, Ctrl+O to import files, Ctrl+S to save a note, Ctrl+K to search, Ctrl+Shift+P for commands, Ctrl+, for Settings, and F11 for full screen. Alt+1 through Alt+6 open the main workspace views. Ctrl+Alt+B hides or shows navigation. Ctrl+B remains available for bold text in the note editor.

Window position, normal size, and maximized state are restored from `window-state.json` in the app data directory. Restored bounds are constrained to an available screen's work area so the window remains visible after monitor changes.

## Renderer bridge

The context-isolated preload exposes `window.NotejectDesktop`:

- `fileApiBase`: local project attachment service URL.
- `platform` and `version`: installed desktop metadata.
- `onCommand(handler)`: receives `{ command }` for the documented workspace actions and returns an unsubscribe function.
- `setCommandReady(true)`: called after registering the renderer handler. The main process queues up to 32 menu actions until the page is ready and resets readiness on a full navigation or renderer crash. Call with `false` before detaching the handler. The preload also marks the page unready on `pagehide`.
- `chooseDirectory()`: opens the native Windows directory dialog and resolves to an absolute path or `null` when canceled. Applying a new project attachment path still uses the existing project storage service.

Menu events expose no Electron event objects or general IPC access. Incoming IPC is limited to this window's main frame at its configured local application origin. External web links open in the system browser. Node integration and webviews are disabled; context isolation and the renderer sandbox are enabled.

Run `npm run desktop:dev` for the desktop window. Build the Windows installer with `npm run desktop:installer`.

## Windows interface 0.2.0

The Windows-only renderer uses a resizable navigation sidebar, a desktop Home dashboard, keyboard command palette, note list/editor split view, document details rows, project action menus, and desktop Settings. Boards, Graph, and Reader fill the remaining window space. Reader chapter navigation and annotations have their own resizable panes. Compact layout and sidebar width are remembered.

The workspace service address is remembered in `desktop-service.json` under the existing app data directory. Keeping its port stable keeps local browser storage available across launches. The attachment service may use a fresh port. If the workspace port is occupied, startup reports that conflict instead of silently changing to an empty storage origin. Earlier origins are retained; this change does not migrate or delete them.
