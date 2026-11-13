(() => {
  'use strict';

  const groups = [
    ['Workspace', [
      ['Open search', 'Ctrl + K'],
      ['Open Smart Engine', 'Ctrl + Shift + K'],
      ['Open command palette', 'Ctrl + Shift + P'],
      ['Delete selected items', 'Delete'],
      ['Close a dialog or exit Reader focus', 'Esc'],
    ]],
    ['Boards', [
      ['Create a new idea', 'N'],
      ['Fit board to screen', 'F'],
      ['Pan the board', 'Space + drag'],
      ['Zoom board in / out', '+ / − or Ctrl + wheel'],
      ['Fit all board cards in view', 'F'],
      ['Reset board zoom', '0'],
      ['Select all cards', 'Ctrl + A'],
      ['Duplicate selected notes', 'Ctrl + D'],
      ['Undo / redo board change', 'Ctrl + Z / Ctrl + Shift + Z'],
      ['Redo board change', 'Ctrl + Y'],
      ['Add or remove a card from selection', 'Ctrl / Shift + click'],
      ['Open a focused document card', 'Enter / Space'],
      ['Open a focused note card', 'Enter'],
      ['Go to the next board search match', 'Enter'],
    ]],
    ['Notes', [
      ['Save note or connection', 'Ctrl + S'],
      ['Undo / redo note edits', 'Ctrl + Z / Ctrl + Shift + Z'],
      ['Redo note edits', 'Ctrl + Y'],
      ['Continue a list', 'Ctrl + Enter'],
      ['Nest the current list item', 'Ctrl + Shift + Enter'],
      ['Indent / outdent a list item', 'Tab / Shift + Tab'],
      ['Make a bullet list', 'Ctrl + Shift + 8'],
      ['Make a numbered list', 'Ctrl + Shift + 7'],
      ['Bold / italic', 'Ctrl + B / Ctrl + I'],
    ]],
    ['Reader', [
      ['Find in document', 'Ctrl + F'],
      ['Run the selected document tool or AI answer', 'Ctrl + Enter'],
      ['Save selected text as a note', 'Ctrl + Shift + S'],
      ['Previous / next page or chapter', '← / →'],
      ['Previous / next document', 'Ctrl + Page Up / Page Down'],
      ['Go to the entered PDF page', 'Enter'],
      ['Zoom PDF / EPUB / TXT in or out', 'Ctrl + = / Ctrl + −'],
      ['Reset document zoom', 'Ctrl + 0'],
      ['Next / previous search result', 'Enter / Shift + Enter'],
    ]],
    ['Graph View', [
      ['Zoom graph in / out', '+ / − or scroll wheel'],
      ['Fit graph to view', 'F'],
      ['Activate the focused graph item', 'Enter / Space'],
    ]],
  ];

  const searchShortcut = document.getElementById('search-shortcut');
  const platform = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''}`;
  if (searchShortcut && /mac|iphone|ipad/i.test(platform)) {
    searchShortcut.textContent = '⌘K';
    searchShortcut.title = 'Command+K';
    searchShortcut.setAttribute('aria-label', 'Command plus K');
  }

  function render() {
    return `<div class="shortcut-groups">${groups.map(([title, shortcuts]) => `<section class="shortcut-group"><h3>${title}</h3><div class="shortcut-list">${shortcuts.map(([label, keys]) => `<span>${label}</span><kbd>${keys}</kbd>`).join('')}</div></section>`).join('')}</div>`;
  }

  document.addEventListener('keydown', event => {
    const canvas = event.target.closest?.('.graph-canvas-wrap');
    if (!canvas || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('input,textarea,select,button,a,[contenteditable="true"]')) return;
    const action = event.key === '+' || event.key === '=' ? 'zoom-in'
      : event.key === '-' ? 'zoom-out'
      : event.key.toLowerCase() === 'f' ? 'fit' : '';
    if (!action) return;
    const button = document.querySelector(`[data-graph-action="${action === 'reset' ? 'reset-zoom' : action}"]`);
    if (button) { event.preventDefault(); button.click(); }
  });

  window.NotejectKeyboardShortcuts = { render };
})();
