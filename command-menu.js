(() => {
  'use strict';

  let current = null;
  let menuNumber = 0;

  const create = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };

  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

  function close(reason = 'dismissed', commandId = null) {
    if (!current) return;
    const menu = current;
    current = null;
    document.removeEventListener('focusin', menu.containFocus, true);
    menu.overlay.remove();
    document.body.style.overflow = menu.oldOverflow;
    if (menu.app) menu.app.inert = menu.oldInert;
    if (menu.previousFocus?.isConnected) menu.previousFocus.focus({ preventScroll: true });
    if (typeof menu.onClose === 'function') {
      try { menu.onClose({ reason, commandId }); }
      catch (error) { console.error('Could not finish closing the command menu.', error); }
    }
  }

  function open({ commands = [], onClose } = {}) {
    close('replaced');

    const prefix = `noteject-command-${++menuNumber}`;
    const previousFocus = document.activeElement;
    const app = document.querySelector('.app');
    const oldInert = app?.inert || false;
    const oldOverflow = document.body.style.overflow;
    const overlay = create('div', 'command-menu-overlay');
    overlay.id = 'command-menu-overlay';
    const dialog = create('section', 'command-menu');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${prefix}-title`);

    const heading = create('div', 'command-menu-heading');
    const title = create('h2', '', 'Command menu');
    title.id = `${prefix}-title`;
    const closeButton = create('button', 'command-menu-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close command menu');
    closeButton.addEventListener('click', () => close());
    heading.append(title, closeButton);

    const search = create('div', 'command-menu-search');
    const searchIcon = create('span', 'command-menu-search-icon', '⌕');
    searchIcon.setAttribute('aria-hidden', 'true');
    const input = create('input', 'command-menu-input');
    input.type = 'text';
    input.placeholder = 'Search actions, boards, and documents…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', 'Find a command');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', `${prefix}-list`);
    search.append(searchIcon, input);

    const list = create('div', 'command-menu-list');
    list.id = `${prefix}-list`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Commands');
    const empty = create('p', 'command-menu-empty', 'No matching commands. Try a different search.');
    empty.hidden = true;
    const status = create('span', 'command-menu-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const footer = create('div', 'command-menu-footer');
    const tips = create('span', '', '↑ ↓ navigate · Enter run · Esc close');
    footer.append(tips, status);
    dialog.append(heading, search, list, empty, footer);
    overlay.append(dialog);

    const menu = {
      overlay, app, oldInert, oldOverflow, previousFocus, onClose,
      containFocus: event => {
        if (current === menu && !overlay.contains(event.target)) input.focus({ preventScroll: true });
      }
    };
    const allCommands = Array.from(commands).filter(command => command && typeof command.run === 'function').map((command, index) => ({
      command,
      label: String(command.label || command.id || 'Untitled command'),
      description: String(command.description || ''),
      shortcut: String(command.shortcut || ''),
      index
    }));
    let visible = [];
    let selected = -1;

    function select(index, scroll = true) {
      if (index < 0 || index >= visible.length || visible[index].command.disabled) {
        selected = -1;
        input.removeAttribute('aria-activedescendant');
      } else {
        selected = index;
        input.setAttribute('aria-activedescendant', visible[index].row.id);
      }
      visible.forEach((item, rowIndex) => {
        const active = selected === rowIndex;
        item.row.classList.toggle('is-active', active);
        item.row.setAttribute('aria-selected', String(active));
      });
      if (scroll && selected >= 0) visible[selected].row.scrollIntoView({ block: 'nearest' });
    }

    function execute(item) {
      if (!item || item.command.disabled || current !== menu) return;
      close('command', item.command.id || null);
      try {
        Promise.resolve(item.command.run()).catch(error => {
          document.dispatchEvent(new CustomEvent('noteject-command-error', { detail: { error, command: item.command } }));
          console.error('Could not run the selected command.', error);
        });
      } catch (error) {
        document.dispatchEvent(new CustomEvent('noteject-command-error', { detail: { error, command: item.command } }));
        console.error('Could not run the selected command.', error);
      }
    }

    function render() {
      const query = normalize(input.value).trim().split(/\s+/).filter(Boolean);
      list.replaceChildren();
      visible = allCommands.filter(item => {
        const text = normalize(`${item.label} ${item.description}`);
        return query.every(word => text.includes(word));
      });
      visible.forEach((item, index) => {
        const row = create('div', 'command-menu-option');
        if (item.command.danger) row.classList.add('destructive-action');
        row.id = `${prefix}-option-${item.index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.setAttribute('aria-disabled', String(Boolean(item.command.disabled)));
        const text = create('span', 'command-menu-option-text');
        text.append(create('span', 'command-menu-option-label', item.label));
        if (item.description) text.append(create('span', 'command-menu-option-description', item.description));
        row.append(text);
        if (item.shortcut) row.append(create('kbd', 'command-menu-shortcut', item.shortcut));
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('pointermove', () => {
          if (!item.command.disabled && selected !== index) select(index, false);
        });
        row.addEventListener('click', () => execute(item));
        item.row = row;
        list.append(row);
      });
      list.hidden = visible.length === 0;
      empty.hidden = visible.length !== 0;
      status.textContent = `${visible.length} ${visible.length === 1 ? 'command' : 'commands'}`;
      select(visible.findIndex(item => !item.command.disabled), false);
      list.scrollTop = 0;
    }

    input.addEventListener('input', render);
    overlay.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const enabled = visible.map((item, index) => item.command.disabled ? -1 : index).filter(index => index >= 0);
        if (!enabled.length) return;
        const currentIndex = enabled.indexOf(selected);
        const nextIndex = currentIndex < 0 ? (event.key === 'ArrowDown' ? 0 : enabled.length - 1)
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        select(enabled[nextIndex]);
        input.focus({ preventScroll: true });
      } else if (event.key === 'Enter' && event.target !== closeButton) {
        event.preventDefault();
        execute(visible[selected]);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === closeButton ? input : closeButton).focus({ preventScroll: true });
      }
    }, true);

    current = menu;
    document.body.append(overlay);
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    document.addEventListener('focusin', menu.containFocus, true);
    render();
    input.focus({ preventScroll: true });
    return { close: () => { if (current === menu) close(); } };
  }

  window.NotejectCommandMenu = { open, close, isOpen: () => current !== null };
})();
