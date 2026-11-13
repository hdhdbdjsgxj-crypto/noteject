(() => {
  'use strict';

  let activeDialog = null;

  function closeDialog(value) {
    if (!activeDialog) return;
    const { overlay, resolve, returnFocus, inertNodes } = activeDialog;
    activeDialog = null;
    if (overlay.open && typeof overlay.close === 'function') overlay.close();
    overlay.remove();
    for (const node of inertNodes) if (node.isConnected) node.inert = false;
    returnFocus?.focus?.({ preventScroll: true });
    resolve(value);
  }

  function openDialog({ title = 'noteject', message = '', input = null, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
    if (activeDialog) closeDialog(null);
    const returnFocus = document.activeElement;
    // A confirmation may be opened from another modal, such as the cloud
    // account window. Put it in the browser's top layer so it stays clickable.
    const nativeModal = typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function';
    const overlay = document.createElement(nativeModal ? 'dialog' : 'div');
    overlay.className = 'noteject-dialog-overlay';
    overlay.innerHTML = '<section class="noteject-dialog" role="alertdialog" aria-modal="true"><div class="noteject-dialog-brand">noteject</div><h2 class="noteject-dialog-title"></h2><p class="noteject-dialog-message"></p><div class="noteject-dialog-field" hidden><input class="noteject-dialog-input"></div><footer class="noteject-dialog-actions"><button type="button" class="secondary noteject-dialog-cancel"></button><button type="button" class="primary noteject-dialog-confirm"></button></footer></section>';
    const panel = overlay.querySelector('.noteject-dialog');
    const heading = overlay.querySelector('.noteject-dialog-title');
    const description = overlay.querySelector('.noteject-dialog-message');
    const field = overlay.querySelector('.noteject-dialog-field');
    const entry = overlay.querySelector('.noteject-dialog-input');
    const cancel = overlay.querySelector('.noteject-dialog-cancel');
    const accept = overlay.querySelector('.noteject-dialog-confirm');
    const dialogId = 'noteject-dialog-' + Date.now().toString(36);
    heading.id = dialogId + '-title';
    description.id = dialogId + '-description';
    panel.setAttribute('aria-labelledby', heading.id);
    panel.setAttribute('aria-describedby', description.id);
    heading.textContent = title;
    description.textContent = message;
    cancel.textContent = cancelLabel;
    accept.textContent = confirmLabel;
    if (danger) accept.classList.add('danger');
    if (input) {
      field.hidden = false;
      entry.value = input.value ?? '';
      entry.placeholder = input.placeholder ?? '';
      entry.maxLength = input.maxLength ?? 500;
      entry.type = input.type ?? 'text';
      entry.setAttribute('aria-label', input.label || title);
    }

    const promise = new Promise(resolve => {
      activeDialog = { overlay, resolve, returnFocus, inertNodes: [] };
    });
    const cancelDialog = () => closeDialog(null);
    const confirmDialog = () => closeDialog(input ? entry.value : true);
    cancel.addEventListener('click', cancelDialog);
    accept.addEventListener('click', confirmDialog);
    entry.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); confirmDialog(); }
    });
    overlay.addEventListener('click', event => { if (event.target === overlay) cancelDialog(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDialog(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node => node.getClientRects().length && !node.closest('[hidden],[inert]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.append(overlay);
    if (nativeModal) {
      overlay.addEventListener('cancel', event => { event.preventDefault(); cancelDialog(); });
      overlay.showModal();
    } else {
      for (const node of document.body.children) if (node !== overlay && node instanceof HTMLElement && !node.inert && !node.matches('script,style,link')) { node.inert = true; activeDialog.inertNodes.push(node); }
    }
    requestAnimationFrame(() => {
      const target = input ? entry : cancel;
      target.focus({ preventScroll: true });
      if (input) entry.select();
    });
    return promise;
  }

  window.NotejectDialogs = Object.freeze({
    confirm(message, options = {}) {
      const text = String(message || '');
      const destructive = /\b(delete|trash|remove|empty|replace)\b/i.test(text);
      const confirmLabel = options.confirmLabel || (/permanently delete/i.test(text) ? 'Delete permanently' : /move .* to trash/i.test(text) ? 'Move to Trash' : /delete/i.test(text) ? 'Delete' : /remove/i.test(text) ? 'Remove' : /load /i.test(text) ? 'Load backup' : /start with an empty/i.test(text) ? 'Start empty' : 'Continue');
      return openDialog({ title: 'Confirm action', message, cancelLabel: 'Cancel', danger: destructive, ...options, confirmLabel });
    },
    prompt(message, value = '', options = {}) {
      const { input: inputOptions = {}, ...dialogOptions } = options;
      return openDialog({ title: 'Enter a value', message, input: { value, ...inputOptions }, confirmLabel: 'Save', ...dialogOptions });
    }
  });
})();
