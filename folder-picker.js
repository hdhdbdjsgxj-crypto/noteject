/* Folder selection stays in noteject instead of waiting for a Windows modal. */
(() => {
  let activePicker = null;
  const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/></svg>';

  function open({apiBase = '', path = ''} = {}) {
    if (activePicker) return activePicker.promise;
    let resolvePicker;
    const promise = new Promise(resolve => { resolvePicker = resolve; });
    activePicker = {promise};
    const previousFocus = document.activeElement;
    const app = document.querySelector('.app');
    const wasInert = app?.inert || false;
    const previousOverflow = document.body.style.overflow;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay folder-picker-overlay';
    overlay.id = 'storage-folder-overlay';
    overlay.innerHTML = `<section class="folder-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" aria-describedby="folder-picker-help">
      <button class="close" type="button" data-folder-cancel aria-label="Close project storage chooser">×</button>
      <div class="eyebrow">PROJECT ATTACHMENTS</div>
      <h2 id="folder-picker-title">Choose project storage location</h2>
      <p id="folder-picker-help">Browse locations on this PC or paste a project storage path.</p>
      <form class="folder-path-form" id="folder-path-form">
        <label for="folder-path-input">Project storage path<input id="folder-path-input" type="text" spellcheck="false" autocomplete="off" placeholder="C:\\Users\\Name\\Documents\\noteject"></label>
        <button class="secondary" type="submit">Go</button>
      </form>
      <div class="folder-browser-layout">
        <nav class="folder-browser-places" id="folder-browser-places" aria-label="Places and drives"></nav>
        <div class="folder-browser-pane">
          <div class="folder-browser-tools"><button class="secondary" id="folder-parent" type="button" disabled>↑ Up</button><span id="folder-current-path"></span><button class="secondary" id="folder-reload" type="button" title="Reload contents" aria-label="Reload contents">↻</button></div>
          <input class="folder-name-filter" id="folder-name-filter" type="search" aria-label="Filter locations" placeholder="Filter locations…">
          <div class="folder-browser-list" id="folder-browser-list" role="group" aria-label="Contents of this location" tabindex="-1"></div>
        </div>
      </div>
      <div class="folder-browser-status" id="folder-browser-status" role="status" aria-live="polite">Loading project storage…</div>
      <div class="folder-browser-error" id="folder-browser-error" role="alert" hidden></div>
      <footer><button class="secondary" type="button" data-folder-cancel>Cancel</button><button class="primary" type="button" id="folder-use">Use this location</button></footer>
    </section>`;
    document.body.append(overlay);
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    const find = selector => overlay.querySelector(selector);
    const input = find('#folder-path-input');
    const list = find('#folder-browser-list');
    const status = find('#folder-browser-status');
    const error = find('#folder-browser-error');
    const useButton = find('#folder-use');
    const parentButton = find('#folder-parent');
    const filter = find('#folder-name-filter');
    let closed = false, saving = false, currentPath = '', parentPath = null;
    let folders = [], places = [], drives = [], browseRequest = 0, browseController = null;
    input.value = path;

    function close(result = null) {
      if (closed || saving) return;
      closed = true;
      browseController?.abort();
      overlay.remove();
      if (app) app.inert = wasInert;
      document.body.style.overflow = previousOverflow;
      activePicker = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolvePicker(result);
    }

    function showError(message = '') {
      error.hidden = !message;
      error.textContent = message;
    }

    async function request(url, options = {}, controller = new AbortController()) {
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(apiBase + url, {...options, signal: controller.signal, cache: 'no-store'});
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || 'Project storage service unavailable. Reopen noteject and try again.');
        return result;
      } catch (problem) {
        if (problem instanceof TypeError) throw Error('Cannot reach project-file storage. Reopen noteject and try again.');
        throw problem;
      } finally {
        clearTimeout(timeout);
      }
    }

    function renderFolders() {
      list.replaceChildren();
      const query = filter.value.trim().toLocaleLowerCase();
      const visible = folders.filter(folder => folder.name.toLocaleLowerCase().includes(query));
      for (const folder of visible) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'folder-browser-row';
        row.title = folder.path;
        row.innerHTML = folderIcon + '<span></span><b aria-hidden="true">›</b>';
        row.querySelector('span').textContent = folder.name;
        row.onclick = () => browse(folder.path, true);
        list.append(row);
      }
      if (!visible.length) {
        const empty = document.createElement('p');
        empty.className = 'folder-browser-empty';
        empty.textContent = query ? 'No matching locations.' : 'No matching items. You can use this location.';
        list.append(empty);
      }
      status.textContent = folders.length + ' item' + (folders.length === 1 ? '' : 's');
    }

    function renderPlaces() {
      const nav = find('#folder-browser-places');
      nav.replaceChildren();
      for (const [heading, entries] of [['Places', places], ['Drives', drives]]) {
        if (!entries.length) continue;
        const label = document.createElement('h3');
        label.textContent = heading;
        nav.append(label);
        for (const place of entries) {
          const button = document.createElement('button');
          button.type = 'button';
          button.title = place.path;
          button.innerHTML = folderIcon + '<span></span>';
          button.querySelector('span').textContent = place.name;
          const normalize = value => value.replace(/[\\/]+$/, '').toLocaleLowerCase();
          button.classList.toggle('active', normalize(place.path) === normalize(currentPath));
          button.onclick = () => browse(place.path, true);
          nav.append(button);
        }
      }
    }

    async function browse(directory, focusList = false) {
      if (closed || saving) return;
      browseController?.abort();
      const controller = browseController = new AbortController();
      const requestId = ++browseRequest;
      if (focusList && directory) input.value = directory;
      const requestedInput = input.value;
      showError();
      list.setAttribute('aria-busy', 'true');
      status.textContent = 'Loading project storage…';
      parentButton.disabled = true;
      try {
        const result = await request('/api/folders' + (directory ? '?directory=' + encodeURIComponent(directory) : ''), {}, controller);
        if (closed || requestId !== browseRequest) return;
        if (typeof result.directory !== 'string' || !Array.isArray(result.folders)) throw Error('Project storage browsing needs the updated service. Reopen noteject, or paste a full path above.');
        currentPath = result.directory;
        parentPath = result.parent || null;
        folders = result.folders;
        places = result.places || [];
        drives = result.drives || [];
        if (input.value === requestedInput) input.value = currentPath;
        filter.value = '';
        find('#folder-current-path').textContent = currentPath;
        find('#folder-current-path').title = currentPath;
        parentButton.disabled = !parentPath;
        renderFolders();
        renderPlaces();
        if (result.truncated) status.textContent += ' · Showing the first ' + folders.length;
        if (focusList) list.focus();
      } catch (problem) {
        if (closed || requestId !== browseRequest) return;
        status.textContent = 'Paste a project storage path and choose Use this location.';
        showError(problem.name === 'AbortError' ? 'Loading this location timed out. Try another path.' : problem.message);
        parentButton.disabled = !parentPath;
      } finally {
        if (!closed && requestId === browseRequest) list.removeAttribute('aria-busy');
      }
    }

    find('#folder-path-form').onsubmit = event => {
      event.preventDefault();
      browse(input.value.trim().replace(/^"(.*)"$/, '$1'));
    };
    parentButton.onclick = () => { if (parentPath) browse(parentPath, true); };
    find('#folder-reload').onclick = () => browse(currentPath || input.value.trim());
    filter.oninput = renderFolders;
    useButton.onclick = async () => {
      if (saving) return;
      const directory = input.value.trim().replace(/^"(.*)"$/, '$1');
      if (!directory) { showError('Enter a full project storage path.'); input.focus(); return; }
      saving = true;
      browseController?.abort();
      ++browseRequest;
      list.removeAttribute('aria-busy');
      showError();
      status.textContent = 'Saving project storage location…';
      const controls = [...overlay.querySelectorAll('button,input')];
      const previousStates = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      useButton.textContent = 'Saving…';
      try {
        const result = await request('/api/storage-path', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({directory})
        });
        if (result.ok !== true) throw Error('Could not confirm the project location change. Please try again.');
        saving = false;
        close(result);
      } catch (problem) {
        saving = false;
        controls.forEach((control, index) => { control.disabled = previousStates[index]; });
        parentButton.disabled = !parentPath;
        useButton.textContent = 'Use this location';
        status.textContent = 'Choose another location or try again.';
        showError(problem.name === 'AbortError' ? 'Saving timed out. Check the project file service and try again.' : problem.message);
        input.focus();
      }
    };
    overlay.querySelectorAll('[data-folder-cancel]').forEach(button => { button.onclick = () => close(); });
    overlay.onclick = event => { if (event.target === overlay) close(); };
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    input.focus();
    input.select();
    browse(path);
    return promise;
  }

  window.NotejectFolderPicker = {open};
})();
