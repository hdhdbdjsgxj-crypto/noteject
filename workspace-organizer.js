/* Local project, favorites, saved collection, and recent activity views. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectWorkspaceOrganizer = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const mobile = typeof window === 'object' && !!window.NotejectAndroid;
  const COLORS = ['violet', 'blue', 'teal', 'amber', 'rose', 'gray'];
  const KINDS = ['all', 'note', 'document', 'board', 'highlight'];
  const array = value => Array.isArray(value) ? value : [];
  const text = value => String(value == null ? '' : value);
  const lower = value => text(value).toLocaleLowerCase();
  const unique = values => [...new Set(values)];
  const escape = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const timestamp = value => { const number = Number(value); return Number.isFinite(number) ? number : Date.parse(value) || 0; };

  function ensureWorkspace(data) {
    if (!data.workspace || typeof data.workspace !== 'object' || Array.isArray(data.workspace)) data.workspace = {};
    for (const key of ['projects', 'collections', 'history']) if (!Array.isArray(data.workspace[key])) data.workspace[key] = [];
    return data.workspace;
  }

  function libraryItems(data) {
    const documents = new Map(array(data.docs).map(item => [item.id, item]));
    const notes = array(data.notes).filter(item => item && item.id).map(note => {
      const sourceRef = text(note.content).match(/\n\s*Source:\s*\[\[([^\]]+)\]\]/i)?.[1];
      const source = documents.get(note.selectionSourceId || note.sourceId) || array(data.docs).find(doc => sourceRef && text(doc.name).toLocaleLowerCase() === sourceRef.toLocaleLowerCase());
      const highlight = !!(note.selectionSourceId || note.sourceId || sourceRef);
      const passage = text(globalThis.NotejectReaderSelectionModel?.normalize(note).quote || note.selectionQuote || '').trim();
      return { kind: highlight ? 'highlight' : 'note', id: note.id, title: text(note.title || 'Untitled note'), folder: text(note.folder || 'Inbox'), tags: array(note.tags).map(text), fileType: highlight ? text(source?.type || '') : '', favorite: !!note.favorite, updated: timestamp(note.updated || note.created), content: [passage, note.content, note.selectionComment].map(text).join(' '), passage, record: note, source };
    });
    return notes.concat(array(data.docs).filter(item => item && item.id).map(doc => ({ kind: 'document', id: doc.id, title: text(doc.name || 'Untitled file'), folder: text(doc.folder || 'Inbox'), tags: array(doc.tags).map(text), fileType: text(doc.type || 'file'), favorite: !!doc.favorite, updated: timestamp(doc.updated || doc.added || doc.created), content: [doc.description, doc.text, doc.extractedText].map(text).join(' '), record: doc })), array(data.boards).filter(item => item && item.id).map(board => ({ kind: 'board', id: board.id, title: text(board.name || 'Untitled board'), folder: text(board.folder || ''), tags: array(board.tags).map(text), fileType: '', favorite: !!board.favorite, updated: timestamp(board.updated || board.created), content: text(board.description), record: board })));
  }

  function projects(data) {
    const metadata = array(data.workspace?.projects).filter(project => project && typeof project.folder === 'string');
    const library = libraryItems(data);
    const folders = unique([...array(data.folders), ...array(data.noteFolders), ...Object.keys(data.folderProjects || {}), ...array(data.notes).map(item => item.folder), ...array(data.docs).map(item => item.folder), ...metadata.map(project => project.folder)].filter(folder => typeof folder === 'string' && folder.trim() && lower(folder) !== 'inbox'));
    return folders.map(folder => {
      const meta = metadata.find(project => project.folder === folder);
      const project = { id: meta?.id || 'folder:' + folder, folder, name: text(meta?.name || folder), description: text(meta?.description || ''), color: COLORS.includes(meta?.color) ? meta.color : 'violet', boardIds: unique(array(meta?.boardIds).filter(id => typeof id === 'string')), inferred: !meta, lastOpened: timestamp(meta?.lastOpened), updated: timestamp(meta?.updated), created: timestamp(meta?.created) };
      const items = projectItems(data, project, library);
      return { ...project, noteCount: items.filter(item => item.kind === 'note' || item.kind === 'highlight').length, documentCount: items.filter(item => item.kind === 'document').length, boardCount: items.filter(item => item.kind === 'board').length };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  function projectItems(data, project, library = libraryItems(data)) {
    const boardIds = new Set(array(project?.boardIds));
    return library.filter(item => item.kind === 'board' ? boardIds.has(item.id) || item.folder === project?.folder : item.folder === project?.folder);
  }

  function recentProjects(data, limit = 4) {
    const activity = new Map();
    for (const item of [...array(data.notes), ...array(data.docs), ...array(data.boards)]) {
      if (!item?.folder) continue;
      const at = Math.max(timestamp(item.lastOpened), timestamp(item.updated), timestamp(item.created), timestamp(item.added));
      activity.set(item.folder, Math.max(activity.get(item.folder) || 0, at));
    }
    const boards = new Map(array(data.boards).map(board => [board.id, board]));
    return projects(data).map(project => ({ ...project, recentAt: Math.max(
      project.lastOpened, project.updated, project.created, activity.get(project.folder) || 0,
      ...project.boardIds.map(id => { const board = boards.get(id); return Math.max(timestamp(board?.lastOpened), timestamp(board?.updated), timestamp(board?.created)); })
    ) })).sort((a, b) => b.recentAt - a.recentAt || a.name.localeCompare(b.name)).slice(0, limit);
  }

  function visitProject(data, folder, at = Date.now()) {
    const project = projects(data).find(item => item.folder === folder || item.id === folder);
    if (!project) return false;
    const workspace = ensureWorkspace(data);
    let meta = workspace.projects.find(item => item.folder === project.folder);
    if (!meta) { meta = { id: project.id, folder: project.folder, name: project.name, color: project.color, boardIds: project.boardIds }; workspace.projects.push(meta); }
    meta.lastOpened = at;
    return true;
  }

  function favorites(data, kind = 'all') {
    return libraryItems(data).filter(item => item.favorite && (kind === 'all' || item.kind === kind)).sort((left, right) => right.updated - left.updated || left.title.localeCompare(right.title));
  }

  function normalizeCollection(value) {
    value = value || {};
    return { id: text(value.id), name: text(value.name).trim().slice(0, 100), query: text(value.query).trim().slice(0, 300), kind: KINDS.includes(value.kind) ? value.kind : 'all', folder: text(value.folder), tag: text(value.tag).trim().replace(/^#/, ''), fileType: text(value.fileType).toLocaleLowerCase(), favorite: !!value.favorite };
  }

  function collectionMatches(data, rule) {
    const filter = normalizeCollection(rule), words = lower(filter.query).split(/\s+/).filter(Boolean);
    return libraryItems(data).filter(item => {
      if (filter.kind !== 'all' && filter.kind !== item.kind) return false;
      if (filter.folder && item.folder !== filter.folder) return false;
      if (filter.tag && !item.tags.some(tag => lower(tag.replace(/^#/, '')) === lower(filter.tag))) return false;
      if (filter.fileType && filter.fileType !== 'all' && lower(item.fileType) !== filter.fileType) return false;
      if (filter.favorite && !item.favorite) return false;
      const searchable = lower([item.title, item.content, item.folder, item.fileType, ...item.tags].join(' '));
      return words.every(word => searchable.includes(word));
    }).sort((left, right) => right.updated - left.updated || left.title.localeCompare(right.title));
  }

  function historyItems(data) {
    const lookup = new Map(libraryItems(data).map(item => [(item.kind === 'highlight' ? 'note' : item.kind) + ':' + item.id, item]));
    const entries = array(data.workspace?.history).filter(entry => entry && entry.id).map(entry => ({ ...entry, at: timestamp(entry.at), kind: entry.kind === 'doc' ? 'document' : entry.kind === 'highlight' ? 'note' : entry.kind })).filter(entry => entry.at > 0).sort((left, right) => right.at - left.at);
    const seen = new Set(), result = [];
    for (const entry of entries) {
      const key = entry.kind + ':' + entry.id, item = lookup.get(key);
      if (!item || seen.has(key)) continue;
      seen.add(key);
      result.push({ ...item, at: entry.at, boardId: entry.boardId });
    }
    return result;
  }

  function setFavorite(data, kind, id, value) {
    const list = kind === 'board' ? data.boards : kind === 'document' || kind === 'doc' ? data.docs : kind === 'note' || kind === 'highlight' ? data.notes : [];
    const record = array(list).find(item => item.id === id);
    if (!record) return false;
    record.favorite = !!value;
    return true;
  }

  function setProjectBoards(data, folder, ids, makeId) {
    const project = projects(data).find(item => item.folder === folder);
    if (!project) return false;
    const workspace = ensureWorkspace(data), valid = new Set(array(data.boards).map(board => board.id));
    let metadata = workspace.projects.find(item => item && item.folder === folder);
    if (!metadata) { metadata = { id: makeId ? makeId() : project.id, folder, name: project.name, description: project.description, color: project.color }; workspace.projects.push(metadata); }
    metadata.boardIds = unique(array(ids).filter(id => valid.has(id)));
    return true;
  }

  function deleteProject(data, folder) {
    const project = projects(data).find(item => item.folder === folder);
    if (!project) return null;
    const matches = value => lower(value) === lower(folder);
    const noteIds = array(data.notes).filter(note => matches(note.folder)).map(note => note.id);
    const documentIds = array(data.docs).filter(doc => matches(doc.folder)).map(doc => doc.id);
    const folderBoards = array(data.boards).filter(board => matches(board.folder)).map(board => board.id);
    const meta = array(data.workspace?.projects).find(item => item && matches(item.folder));
    const snapshot = {
      project: { ...project, boardIds: array(project.boardIds).slice() },
      projectMetadata: meta ? { ...meta, boardIds: array(meta.boardIds).slice() } : null,
      noteIds, documentIds, folderBoards,
      folderWasListed: array(data.folders).some(item => matches(item)),
      noteFolderWasListed: array(data.noteFolders).some(item => matches(item)),
      folderProject: data.folderProjects?.[folder] || null
    };
    for (const note of array(data.notes)) if (matches(note.folder)) note.folder = 'Inbox';
    for (const doc of array(data.docs)) if (matches(doc.folder)) doc.folder = 'Inbox';
    for (const board of array(data.boards)) if (matches(board.folder)) board.folder = '';
    data.folders = array(data.folders).filter(item => !matches(item) || lower(item) === 'inbox');
    data.noteFolders = array(data.noteFolders).filter(item => !matches(item) || lower(item) === 'inbox');
    if (data.folderProjects && typeof data.folderProjects === 'object') {
      for (const key of Object.keys(data.folderProjects)) if (matches(key) && lower(key) !== 'inbox') delete data.folderProjects[key];
    }
    const workspace = ensureWorkspace(data);
    workspace.projects = workspace.projects.filter(item => !item || !matches(item.folder));
    return { project, notes: noteIds.length, documents: documentIds.length, snapshot };
  }

  function upsertCollection(data, value, makeId) {
    const collection = normalizeCollection(value);
    if (!collection.name) return null;
    const workspace = ensureWorkspace(data), existing = workspace.collections.find(item => item && item.id === collection.id);
    if (existing) Object.assign(existing, collection);
    else { collection.id = makeId ? makeId() : collection.id; if (!collection.id) return null; workspace.collections.push(collection); }
    return collection;
  }

  function removeCollection(data, id) {
    const workspace = ensureWorkspace(data), before = workspace.collections.length;
    workspace.collections = workspace.collections.filter(item => !item || item.id !== id);
    return workspace.collections.length !== before;
  }

  function create(app) {
    let selectedProject = '', selectedCollection = '', editCollection = null, projectForm = false, showAllFavorites = false;
    const state = { projects: { query: '', kind: 'all', limit: 60 }, favorites: { query: '', kind: 'all', limit: 60 }, collections: { query: '', kind: 'all', limit: 60 }, history: { query: '', kind: 'all', limit: 60 } };
    const getData = () => { const data = app.getData(); ensureWorkspace(data); return data; };
    const finish = message => { app.save(); app.render(); if (message && app.notify) app.notify(message); };
    const projectSetup = typeof window === 'object' && window.NotejectProjectSetup ? window.NotejectProjectSetup.create(app, {
      onCancel() { projectForm = false; app.render(); },
      onCreated(plan) { selectedProject = plan.config.name; projectForm = false; state.projects.query = ''; state.projects.kind = 'all'; state.projects.limit = 60; }
    }) : null;
    const labels = { note: 'Note', document: 'Document', board: 'Board', highlight: 'Highlight' };
    const icons = { note: '✎', document: '▤', board: '▦', highlight: '❞' };
    const option = (value, label, selected) => '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + '>' + escape(label) + '</option>';
    const kindOptions = current => KINDS.map(kind => option(kind, kind === 'all' ? 'All types' : labels[kind] + 's', current)).join('');
    const empty = (heading, detail) => '<div class="workspace-empty"><strong>' + escape(heading) + '</strong><p>' + escape(detail) + '</p></div>';
    const heading = (eyebrow, title, detail, actions = '') => '<header class="workspace-page-heading"><div><span class="workspace-eyebrow">' + escape(eyebrow) + '</span><h1>' + escape(title) + '</h1><p>' + escape(detail) + '</p></div><div class="workspace-actions">' + actions + '</div></header>';
    const button = (action, label, extra = '', modifier = '') => '<button type="button" class="workspace-small-button ' + escape(modifier) + '" data-wo-action="' + escape(action) + '" ' + extra + '>' + escape(label) + '</button>';
    const collectionMenu = (collection, includeOpen = true) => '<details class="wo-collection-management"><summary aria-label="Manage collection ' + escape(collection.name) + '" title="Manage collection">⋯</summary><div class="wo-collection-management-popover" role="menu" aria-label="Collection actions">' + (includeOpen ? button('collection', 'Open matching items', 'role="menuitem" data-wo-id="' + escape(collection.id) + '"') : '') + button('edit-collection', 'Edit rules', 'role="menuitem" data-wo-id="' + escape(collection.id) + '"') + button('duplicate-collection', 'Duplicate collection', 'role="menuitem" data-wo-id="' + escape(collection.id) + '"') + button('export-collection', 'Export results as CSV', 'role="menuitem" data-wo-id="' + escape(collection.id) + '"') + button('delete-collection', 'Delete collection', 'role="menuitem" data-wo-id="' + escape(collection.id) + '"', 'is-destructive') + '</div></details>';
    function filtered(items, view) {
      const { query, kind } = state[view], words = lower(query).split(/\s+/).filter(Boolean);
      return items.filter(item => (kind === 'all' || item.kind === kind) && words.every(word => lower([item.title, item.folder, item.content, ...item.tags].join(' ')).includes(word)));
    }
    function toolbar(view, placeholder = 'Search by name, text, or tag…', kinds = true) {
      return '<form class="workspace-filterbar wo-filter" data-wo-form="search"><label class="wo-search-label"><span class="wo-sr-only">Search ' + escape(view) + '</span><input type="search" name="query" value="' + escape(state[view].query) + '" placeholder="' + escape(placeholder) + '"></label>' + (kinds ? '<label><span class="wo-sr-only">Item type</span><select name="kind" data-wo-filter="kind">' + kindOptions(state[view].kind) + '</select></label>' : '') + '<button class="workspace-small-button" type="submit">Search</button>' + (state[view].query ? button('clear-search', 'Clear search') : '') + '</form>';
    }
    function itemRow(item, { favorite = false, when = false } = {}) {
      const detail = item.kind === 'board' ? array(item.record.items).length + ' cards' : item.folder + (item.fileType ? ' · ' + item.fileType.toUpperCase() : '');
      const reference = 'data-wo-kind="' + escape(item.kind) + '" data-wo-id="' + escape(item.id) + '"' + (item.boardId ? ' data-wo-board="' + escape(item.boardId) + '"' : '') + (item.source ? ' data-wo-source="' + escape(item.source.id) + '"' : '');
      const quote = item.passage || item.content || 'Saved reading passage';
      const preview = item.kind === 'highlight' ? '<span class="wo-item-preview">“' + escape(quote.replace(/\s+/g, ' ').slice(0, 240)) + (quote.length > 240 ? '…' : '') + '”</span>' : '';
      const action = item.kind === 'highlight' && item.source ? 'passage' : 'open';
      const sourceName = item.kind === 'highlight' && item.source ? ' · ' + text(item.source.name || 'Source document') : '';
      return '<article class="workspace-row wo-item-row"><span class="wo-item-icon" aria-hidden="true" data-kind="' + escape(item.kind) + '">' + icons[item.kind] + '</span><button type="button" class="wo-item-open" data-wo-action="' + action + '" ' + reference + '><strong>' + escape(item.title) + '</strong><span>' + escape(labels[item.kind]) + ' · ' + escape(detail + sourceName) + (when ? ' · ' + escape(new Date(item.at).toLocaleString(globalThis.document?.documentElement?.lang || undefined)) : '') + (item.record.archived ? ' · Archived' : '') + '</span>' + preview + '</button>' + (item.kind === 'highlight' && item.source ? button('passage', 'Open source ↗', reference) : '') + (favorite ? '<button type="button" class="wo-favorite-button" data-wo-action="favorite" ' + reference + ' aria-label="' + escape((item.favorite ? 'Unpin ' : 'Pin ') + item.title) + '" aria-pressed="' + item.favorite + '">' + (item.favorite ? '★' : '☆') + '</button>' : '') + '</article>';
    }
    function list(items, view, options) {
      if (!items.length) return empty('No matching items', 'Try another search or change the item type.');
      const visible = items.slice(0, state[view].limit);
      return '<div class="workspace-list">' + visible.map(item => itemRow(item, options)).join('') + '</div>' + (items.length > visible.length ? '<div class="wo-load-more">' + button('more', 'Show more · ' + visible.length + ' of ' + items.length) + '</div>' : '');
    }
    function projectCreator() {
      if (projectSetup) return projectSetup.render();
      if (mobile) return '<form class="workspace-card wo-project-form" data-wo-form="create-project"><h2>New project</h2><label>Project name<input name="name" required maxlength="80" autocomplete="off"></label><label>Goal or description<textarea name="description" maxlength="1000" rows="2"></textarea></label><label>Color<select name="color">' + COLORS.map(color => option(color, color[0].toUpperCase() + color.slice(1), 'violet')).join('') + '</select></label><div class="workspace-actions"><button type="submit" class="primary">Create project</button>' + button('cancel-project', 'Cancel') + '</div></form>';
      return '<form class="workspace-card wo-project-form" data-wo-form="create-project"><h2>Set up a new project</h2><p>Choose a starting workflow. Noteject will create a useful first note or board in this project.</p><div class="wo-form-grid"><label>Project name<input name="name" required maxlength="80" placeholder="For example: Space research" autocomplete="off"></label><label>Starting workflow<select name="workflow"><option value="project-plan">Project plan · milestones and next steps</option><option value="research-note">Research · question and evidence</option><option value="reading-note">Reading · sources and reflections</option><option value="study-board">Study board · four connected starter notes</option><option value="blank">Blank project · start from scratch</option></select></label><label>Color<select name="color">' + COLORS.map(color => option(color, color[0].toUpperCase() + color.slice(1), 'violet')).join('') + '</select></label><label class="wo-wide">Goal or description<textarea name="description" maxlength="1000" rows="2" placeholder="What do you want to accomplish? This can seed the starter note."></textarea></label></div><p class="wo-project-workflow-hint">You can change or remove the starter content anytime. Existing projects open without creating duplicate items.</p><div class="workspace-actions"><button type="submit" class="primary">Create project</button>' + button('cancel-project', 'Cancel') + '</div></form>';
    }
    function createProjectStarter(data, folder, name, description, workflow, app) {
      if (mobile || workflow === 'blank') return { notes: 0, boards: 0 };
      const suffix = workflow === 'project-plan' ? 'Project plan' : workflow === 'research-note' ? 'Research' : workflow === 'reading-note' ? 'Reading notes' : 'Study board';
      const title = name + ' · ' + suffix, now = Date.now();
      const note = (noteTitle, content, color, tags = []) => ({ id: app.makeId(), title: noteTitle, content, color, tags, folder, favorite: false, archived: false, created: now, updated: now });
      const contentByWorkflow = {
        'project-plan': ['violet', ['project'], '# Project plan\n\n## Outcome\nWhat will be different when this is finished?\n\n## Scope\n\n## Milestones\n- [ ] Define the first milestone\n- [ ] Collect the materials\n- [ ] Review the result\n\n## Resources\n\n## Open questions\n\n## Progress log\n', 'What will be different when this is finished?'],
        'research-note': ['teal', ['research'], '# Research note\n\n## Question\n\n## Working explanation\n\n## Evidence\n- Claim: \n  - Source: \n\n## Contradictions and gaps\n\n## Connections\nUse [[Note title]] to link a related note.\n\n## Next steps\n- [ ] Find a reliable source\n- [ ] Review the evidence\n', '## Question\n\n'],
        'reading-note': ['blue', ['reading'], '# Reading note\n\n## Source\nAuthor: \nDocument: \n\n## Key ideas\n- \n\n## Passages and references\n> Save a passage here and link to its source.\n\n## My thoughts\n\n## Next steps\n- [ ] Review the main ideas\n- [ ] Connect this reading to another note\n', '## Source\n']
      };
      let starter;
      if (workflow === 'study-board') {
        const starterNotes = [
          ['Overview', '# Overview\n\n## Learning goal\n\n## Questions\n- \n', 'violet'],
          ['Key ideas', '# Key ideas\n\n## Concepts\n- \n\n## Connections\nUse [[Note title]] to connect your ideas.\n', 'blue'],
          ['Evidence', '# Evidence\n\n## Sources\n\n## Passages\n> Save a passage and its source here.\n', 'teal'],
          ['Review', '# Review\n\n- [ ] Read the source material\n- [ ] Explain the main ideas in my own words\n- [ ] Revisit unanswered questions\n', 'amber']
        ].map(([part, content, color]) => note(title + ' · ' + part, content, color, ['study']));
        const board = { id: app.makeId(), name: title, folder, created: now, updated: now, zoom: 1, items: starterNotes.map((item, index) => ({ type: 'note', id: item.id, x: 90 + (index % 2) * 460, y: 90 + Math.floor(index / 2) * 340 })), edges: starterNotes.slice(1).map((item, index) => ({ id: app.makeId(), from: starterNotes[index].id, to: item.id, label: ['explores', 'supported by', 'review'][index] || 'related to' })) };
        starter = { notes: starterNotes, board };
      } else {
        const [color, tags, content, descriptionAnchor] = contentByWorkflow[workflow] || [];
        if (!content) throw new Error('Select a valid project starting workflow.');
        const seededContent = description
          ? content.replace(descriptionAnchor, workflow === 'project-plan' ? description : workflow === 'research-note' ? '## Question\n' + description + '\n\n' : '## Project focus\n' + description + '\n\n## Source\n')
          : content;
        starter = { notes: [note(title, seededContent, color, tags)], board: null };
      }
      if (description && starter.notes[0]) {
        if (workflow === 'study-board') starter.notes[0].content = starter.notes[0].content.replace('## Learning goal\n\n', '## Learning goal\n' + description + '\n\n');
      }
      data.notes = array(data.notes);
      data.boards = array(data.boards);
      data.notes.unshift(...starter.notes);
      if (starter.board) {
        data.boards.unshift(starter.board);
        const project = array(data.workspace?.projects).find(item => item && item.folder === folder);
        if (project) project.boardIds = unique([...array(project.boardIds), starter.board.id]);
      }
      return { notes: starter.notes.length, boards: starter.board ? 1 : 0 };
    }
    function projectPage(data) {
      if (projectForm) return projectCreator();
      const all = projects(data), selected = all.find(project => project.folder === selectedProject || project.id === selectedProject);
      if (selected) {
        selectedProject = selected.folder;
        const items = projectItems(data, selected), matched = filtered(items, 'projects'), ids = new Set(selected.boardIds), boards = array(data.boards);
        const sections = [['note', 'Notes & highlights'], ['document', 'Documents'], ['board', 'Linked boards']];
        let remaining = state.projects.limit;
        const groups = sections.map(([kind, title]) => {
          const group = matched.filter(item => kind === 'note' ? ['note', 'highlight'].includes(item.kind) : item.kind === kind), shown = group.slice(0, remaining);
          remaining -= shown.length;
          if (!group.length) return '';
          return '<section class="wo-project-group"><h2>' + title + ' <span class="workspace-pill">' + group.length + '</span></h2><div class="workspace-list">' + shown.map(item => itemRow(item, { favorite: true }) .replace(/<\/article>$/, button('move-asset', 'Move', 'data-wo-folder="' + escape(item.folder) + '" data-wo-kind="' + escape(item.kind) + '" data-wo-id="' + escape(item.id) + '"') + button('delete-asset', 'Delete', 'data-wo-kind="' + escape(item.kind) + '" data-wo-id="' + escape(item.id) + '"') + '</article>')).join('') + '</div></section>';
        }).join('');
        return heading('PROJECTS / ' + selected.folder, selected.name, selected.description || 'Everything for this project, together.', button('all-projects', '← All projects')) + '<div class="workspace-stat-row">' + [[selected.noteCount, 'Notes & highlights'], [selected.documentCount, 'Documents'], [selected.boardCount, 'Linked boards']].map(([count, title]) => '<div class="workspace-stat"><strong>' + count + '</strong><span>' + title + '</span></div>').join('') + '</div><div class="workspace-actions wo-project-actions">' + button('project-notes', 'Open project notes', 'data-wo-folder="' + escape(selected.folder) + '"') + button('project-documents', 'Open project documents', 'data-wo-folder="' + escape(selected.folder) + '"') + button('rename-project-folder', 'Rename project', 'data-wo-folder="' + escape(selected.folder) + '"') + button('delete-project', 'Delete project', 'data-wo-folder="' + escape(selected.folder) + '"') + '</div><details class="workspace-card wo-project-details"><summary>Project details & linked boards</summary><form data-wo-form="project-details"><label>Project name<input name="name" maxlength="100" value="' + escape(selected.name) + '" required></label><label>Description<textarea name="description" maxlength="1000" rows="2">' + escape(selected.description) + '</textarea></label><label>Color<select name="color">' + COLORS.map(color => option(color, color[0].toUpperCase() + color.slice(1), selected.color)).join('') + '</select></label><fieldset><legend>Boards in this project</legend><p>Link a board here to keep it with this project. Board cards stay where they are.</p>' + (boards.map(board => '<label class="wo-checkbox"><input type="checkbox" name="boardIds" value="' + escape(board.id) + '"' + (ids.has(board.id) || board.folder === selected.folder ? ' checked' : '') + (board.folder === selected.folder ? ' disabled' : '') + '> ' + escape(board.name || 'Untitled board') + (board.folder === selected.folder ? ' (project)' : '') + '</label>').join('') || '<p>Create a board first to link it here.</p>') + '</fieldset><button class="workspace-small-button" type="submit">Save project details</button></form></details>' + toolbar('projects') + (matched.length ? groups + (matched.length > state.projects.limit ? '<div class="wo-load-more">' + button('more', 'Show more · ' + Math.min(matched.length, state.projects.limit) + ' of ' + matched.length) + '</div>' : '') : empty('Your project is ready', state.projects.query ? 'No items match this search.' : 'Move notes and documents into this project, or link an existing board above.'));
      }
      const query = lower(state.projects.query), shown = all.filter(project => lower(project.name + ' ' + project.description + ' ' + project.folder).includes(query));
      return heading('ORGANIZE YOUR WORK', 'Projects', 'Keep related notes, documents, and boards in one place.', button('new-project', '＋ New project')) + (projectForm ? projectCreator() : '') + toolbar('projects', 'Find a project…', false) + (shown.length ? '<div class="workspace-card-grid">' + shown.slice(0, state.projects.limit).map(project => '<article class="workspace-card wo-project-card" data-wo-color="' + project.color + '"><span class="workspace-eyebrow">PROJECT</span><h2><button type="button" data-wo-action="project" data-wo-folder="' + escape(project.folder) + '">' + escape(project.name) + '</button></h2><p>' + escape(project.description || 'Notes, documents, and boards for ' + project.folder + '.') + '</p><div class="wo-project-counts"><span>' + project.noteCount + ' notes</span><span>' + project.documentCount + ' documents</span><span>' + project.boardCount + ' boards</span></div><div class="workspace-actions">' + button('project', 'Open project →', 'data-wo-folder="' + escape(project.folder) + '"') + button('rename-project-folder', 'Rename project', 'data-wo-folder="' + escape(project.folder) + '"') + button('delete-project', 'Delete project', 'data-wo-folder="' + escape(project.folder) + '"') + '</div></article>').join('') + '</div>' + (shown.length > state.projects.limit ? '<div class="wo-load-more">' + button('more', 'Show more projects') + '</div>' : '') : empty(query ? 'No matching projects' : 'Start your first project', query ? 'Try another name or description.' : 'Create a project above, or use an existing project.'));
    }
    function favoritePage(data) {
      const all = showAllFavorites ? libraryItems(data) : favorites(data), matched = filtered(all, 'favorites');
      return heading('KEEP IMPORTANT THINGS CLOSE', 'Favorites', showAllFavorites ? 'Pin notes, passages, documents, and boards for quick access.' : 'Your pinned notes, passages, documents, and boards.', button('browse-favorites', showAllFavorites ? 'Show favorites only' : '＋ Add favorites')) + toolbar('favorites') + '<p class="wo-result-count">' + matched.length + ' ' + (showAllFavorites ? 'items' : 'favorites') + '</p>' + (matched.length ? list(matched, 'favorites', { favorite: true }) : empty(showAllFavorites ? 'No matching items' : 'Your favorites live here', showAllFavorites ? 'Change the search or item type.' : 'Choose “Add favorites” to pin something important.'));
    }
    function collectionForm(data) {
      if (editCollection === null) return '';
      const source = data.workspace.collections.find(item => item.id === editCollection), draft = normalizeCollection(source), folders = unique([...array(data.folders), ...array(data.noteFolders), ...libraryItems(data).map(item => item.folder)].filter(Boolean)).sort();
      const types = unique(['pdf', 'epub', 'txt', 'image', 'video', 'audio', 'file', ...array(data.docs).map(doc => text(doc.type)).filter(Boolean)]);
      return '<form class="workspace-card wo-collection-form" data-wo-form="collection"><h2>' + (source ? 'Edit collection' : 'Create a smart collection') + '</h2><p>Rules update the collection automatically as your library changes.</p><input type="hidden" name="id" value="' + escape(draft.id) + '"><div class="wo-form-grid"><label>Name<input name="name" required maxlength="100" value="' + escape(draft.name) + '" placeholder="For example: Favorite research PDFs"></label><label>Search words<input name="query" maxlength="300" value="' + escape(draft.query) + '" placeholder="Optional words in title or text"></label><label>Item type<select name="kind">' + kindOptions(draft.kind) + '</select></label><label>Project<select name="folder">' + option('', 'Any project', draft.folder) + folders.map(folder => option(folder, folder, draft.folder)).join('') + '</select></label><label>Tag<input name="tag" value="' + escape(draft.tag) + '" placeholder="For example: research"></label><label>File type<select name="fileType">' + option('', 'Any file type', draft.fileType) + types.map(type => option(type, type.toUpperCase(), draft.fileType)).join('') + '</select></label><label class="wo-checkbox"><input type="checkbox" name="favorite"' + (draft.favorite ? ' checked' : '') + '> Favorites only</label></div><div class="workspace-actions"><button type="submit" class="primary">Save collection</button>' + button('cancel-collection', 'Cancel') + '</div></form>';
    }
    function collectionPage(data) {
      const collections = data.workspace.collections.map(normalizeCollection), selected = collections.find(item => item.id === selectedCollection);
      if (selected) {
        const matches = filtered(collectionMatches(data, selected), 'collections');
        return heading('SMART COLLECTIONS', selected.name, 'Live results from your saved rules.', button('all-collections', '← All collections') + collectionMenu(selected, false)) + collectionForm(data) + '<div class="wo-rule-summary">' + [[selected.query, 'Words: '], [selected.kind !== 'all' ? labels[selected.kind] + 's' : '', ''], [selected.folder, 'Project: '], [selected.tag, '#'], [selected.fileType, 'Type: '], [selected.favorite ? 'Favorites only' : '', '']].filter(([value]) => value).map(([value, prefix]) => '<span class="workspace-pill">' + escape(prefix + value) + '</span>').join('') + '</div>' + toolbar('collections') + '<p class="wo-result-count">' + matches.length + ' matching items</p>' + list(matches, 'collections', { favorite: true });
      }
      const query = lower(state.collections.query), shown = collections.filter(collection => lower(collection.name + ' ' + collection.query + ' ' + collection.tag + ' ' + collection.folder).includes(query));
      return heading('AUTOMATIC ORGANIZATION', 'Smart collections', 'Save a set of rules and let matching items gather automatically.', button('new-collection', '＋ New collection')) + collectionForm(data) + toolbar('collections', 'Find a collection…', false) + (shown.length ? '<div class="workspace-card-grid">' + shown.slice(0, state.collections.limit).map(collection => '<article class="workspace-card wo-collection-card"><header class="wo-collection-card-heading"><span class="workspace-eyebrow">SAVED RULES</span>' + collectionMenu(collection) + '</header><h2><button type="button" data-wo-action="collection" data-wo-id="' + escape(collection.id) + '">' + escape(collection.name) + '</button></h2><p>' + collectionMatches(data, collection).length + ' matching items' + (collection.folder ? ' · ' + escape(collection.folder) : '') + (collection.tag ? ' · #' + escape(collection.tag) : '') + '</p></article>').join('') + '</div>' + (shown.length > state.collections.limit ? '<div class="wo-load-more">' + button('more', 'Show more collections') + '</div>' : '') : empty(query ? 'No matching collections' : 'Create your first smart collection', query ? 'Try another collection name.' : 'Combine a project, tag, file type, favorite status, or search words. Your original items stay in their projects.'));
    }
    function historyPage(data) {
      const matches = filtered(historyItems(data), 'history'), visible = matches.slice(0, state.history.limit);
      let lastDay = '', rows = '';
      for (const item of visible) {
        const day = new Date(item.at).toLocaleDateString(globalThis.document?.documentElement?.lang || undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (day !== lastDay) { rows += '<h2 class="wo-history-day">' + escape(day) + '</h2>'; lastDay = day; }
        rows += itemRow(item, { favorite: true, when: true });
      }
      return heading('PICK UP WHERE YOU LEFT OFF', 'History', 'Return to recently opened notes, documents, and boards.') + toolbar('history') + (matches.length ? '<div class="workspace-list wo-history-list">' + rows + '</div>' + (matches.length > visible.length ? '<div class="wo-load-more">' + button('more', 'Show more · ' + visible.length + ' of ' + matches.length) + '</div>' : '') : empty('No recent activity yet', state.history.query ? 'Try another search or item type.' : 'Open a note, document, or board and it will appear here. Documents resume from their saved reading position.'));
    }
    function render(view) {
      if (!state[view]) return '';
      const data = getData(), body = view === 'projects' ? projectPage(data) : view === 'favorites' ? favoritePage(data) : view === 'collections' ? collectionPage(data) : historyPage(data);
      return '<section class="workspace-page workspace-organizer" data-wo-view="' + view + '">' + body + '</section>';
    }
    function mount(view) {
      if (!state[view] || typeof document === 'undefined') return;
      const page = document.querySelector('.workspace-organizer[data-wo-view="' + view + '"]');
      if (!page) return;
      page.onclick = async event => {
        const control = event.target.closest('[data-wo-action]');
        if (!control || !page.contains(control)) return;
        const menu = control.closest('details.wo-collection-management'); if (menu) menu.open = false;
        const action = control.dataset.woAction, data = getData();
        if (action === 'open' || action === 'passage') { const kind = control.dataset.woKind === 'highlight' ? 'note' : control.dataset.woKind; app.openItem({ kind, id: control.dataset.woId, boardId: control.dataset.woBoard || undefined, sourceId: control.dataset.woSource || undefined, passage: action === 'passage' }); return; }
        if (action === 'favorite') { const item = libraryItems(data).find(item => item.id === control.dataset.woId && item.kind === control.dataset.woKind); if (item && setFavorite(data, item.kind, item.id, !item.favorite)) finish(item.favorite ? 'Removed from favorites' : 'Added to favorites'); return; }
        if (action === 'move-asset') {
          const item = libraryItems(data).find(entry => entry.id === control.dataset.woId && entry.kind === control.dataset.woKind);
          if (!item) return;
          const destinations = projects(data).filter(project => project.folder !== item.folder);
          if (!destinations.length) { app.notify('Create another project before moving this item.'); return; }
          const target = await window.NotejectDialogs.prompt('Enter the destination project name for “' + item.title + '”.', destinations[0].folder, { title: 'Move project item', input: { label: 'Destination project', maxLength: 100 } });
          if (!target) return;
          const destination = destinations.find(project => lower(project.folder) === lower(target.trim()));
          if (!destination) { app.notify('Choose an existing project name.'); return; }
          if (item.kind === 'note' || item.kind === 'highlight') { app.moveNote?.(item.id, destination.folder); return; }
          else if (item.kind === 'document') { try { await app.moveDocument?.(item.id, destination.folder); } catch (error) { app.notify(error.message || 'Could not move this document.'); return; } }
          else if (item.kind === 'board') {
            const workspace = ensureWorkspace(data);
            for (const project of workspace.projects) project.boardIds = array(project.boardIds).filter(id => id !== item.id);
            item.record.folder = destination.folder;
            let meta = workspace.projects.find(project => project.folder === destination.folder);
            if (!meta) { meta = { id: 'folder:' + destination.folder, folder: destination.folder, name: destination.name, description: destination.description, color: destination.color, boardIds: [] }; workspace.projects.push(meta); }
            meta.boardIds = unique([...array(meta.boardIds), item.id]);
          }
          finish('Item moved to ' + destination.name); return;
        }
        if (action === 'delete-asset') {
          const item = libraryItems(data).find(entry => entry.id === control.dataset.woId && entry.kind === control.dataset.woKind);
          if (!item || !await window.NotejectDialogs.confirm('Move “' + item.title + '” to Trash? This removes it from this project.')) return;
          if (item.kind === 'note' || item.kind === 'highlight') app.deleteNote?.(item.id);
          else if (item.kind === 'document') app.trashDocument?.(item.id);
          else if (item.kind === 'board') { await app.deleteBoard?.(item.id, true); return; }
          app.render(); return;
        }
        if (action === 'project') { selectedProject = control.dataset.woFolder; state.projects.query = ''; state.projects.limit = 60; if (visitProject(data, selectedProject)) app.save(); app.render(); return; }
        if (action === 'rename-project-folder') {
          const oldFolder = control.dataset.woFolder, project = projects(data).find(item => item.folder === oldFolder);
          if (!project) return;
          const proposed = await window.NotejectDialogs.prompt('Choose a name for this project.', oldFolder, { title: 'Rename project', input: { label: 'Project name' } });
          if (proposed === null) return;
          const newFolder = proposed.trim();
          if (!newFolder) { app.notify('Enter a project name.'); return; }
          if (lower(newFolder) === 'inbox') { app.notify('Inbox is reserved. Choose another project name.'); return; }
          const existing = projects(data).find(item => lower(item.folder) === lower(newFolder));
          if (existing && existing.folder !== oldFolder) { app.notify('A project with that name already exists.'); return; }
          if (newFolder === oldFolder) return;
          const navigation = window.NotejectWorkspaceNavigation;
          if (!navigation || typeof navigation.renameFolder !== 'function') { app.notify('Project tools are unavailable.'); return; }
          navigation.renameFolder(data, oldFolder, newFolder);
          if (selectedProject === oldFolder) selectedProject = newFolder;
          finish('Project renamed');
          return;
        }
        if (action === 'delete-project') {
          const folder = control.dataset.woFolder, project = projects(data).find(item => item.folder === folder);
          if (!project || !await window.NotejectDialogs.confirm('Delete project “' + project.name + '”?\n\nIts notes and documents will move to Inbox. Boards stay on their boards. You can restore the project from Trash. Project files stay on disk.')) return;
          const result = deleteProject(data, folder);
          if (!result) return;
          if (app.trashProject) app.trashProject(result.snapshot);
          selectedProject = ''; state.projects.query = ''; state.projects.kind = 'all'; state.projects.limit = 60;
          finish('Project deleted. Restore it from Trash if needed.'); return;
        }
        if (action === 'all-projects') { selectedProject = ''; state.projects.query = ''; state.projects.kind = 'all'; state.projects.limit = 60; app.render(); return; }
        if (action === 'new-project' || action === 'cancel-project') { projectForm = action === 'new-project'; if (projectForm) { selectedProject = ''; projectSetup?.open(); } app.render(); document.querySelector('[data-ps-form] input[name="name"],[data-wo-form="create-project"] input[name="name"]')?.focus(); return; }
        if (action === 'project-notes' || action === 'project-documents') { app.openView(action === 'project-notes' ? 'notes' : 'library', { folder: control.dataset.woFolder }); return; }
        if (action === 'browse-favorites') { showAllFavorites = !showAllFavorites; state.favorites.limit = 60; app.render(); return; }
        if (action === 'new-collection' || action === 'edit-collection' || action === 'cancel-collection') { editCollection = action === 'cancel-collection' ? null : action === 'new-collection' ? '' : control.dataset.woId; app.render(); document.querySelector('[data-wo-form="collection"] input[name="name"]')?.focus(); return; }
        if (action === 'collection' || action === 'all-collections') { selectedCollection = action === 'collection' ? control.dataset.woId : ''; editCollection = null; state.collections.query = ''; state.collections.kind = 'all'; state.collections.limit = 60; app.render(); return; }
        if (action === 'delete-collection') {
          const collection = data.workspace.collections.find(item => item && item.id === control.dataset.woId);
          const tr = value => window.NotejectI18n?.t?.(value) || value;
          if (!collection || !await window.NotejectDialogs.confirm(tr('Delete smart collection') + ' “' + collection.name + '”? ' + tr('Its saved rule will be removed; matching notes and documents will stay unchanged.'))) return;
          if (removeCollection(data, collection.id)) { if (selectedCollection === collection.id) selectedCollection = ''; editCollection = null; finish('Collection removed. Source items are kept.'); } return;
        }
        if (action === 'duplicate-collection') {
          const source = data.workspace.collections.find(item => item && item.id === control.dataset.woId); if (!source) return;
          const base = 'Copy of ' + normalizeCollection(source).name; let name = base, suffix = 2;
          while (data.workspace.collections.some(item => lower(item.name) === lower(name))) name = base + ' (' + suffix++ + ')';
          const copy = upsertCollection(data, { ...normalizeCollection(source), id: '', name }, app.makeId);
          if (copy) { selectedCollection = copy.id; editCollection = null; finish('Smart collection duplicated'); } return;
        }
        if (action === 'export-collection') {
          const collection = data.workspace.collections.find(item => item && item.id === control.dataset.woId); if (!collection) return;
          const matches = collectionMatches(data, collection), quoteCsv = value => '"' + text(value).replace(/"/g, '""') + '"';
          const rows = [['Title', 'Type', 'Project', 'File type', 'Tags', 'Favorite', 'Updated'], ...matches.map(item => [item.title, item.kind, item.folder, item.fileType, item.tags.join(', '), item.favorite ? 'Yes' : 'No', item.updated ? new Date(item.updated).toISOString() : ''])];
          const csv = '\ufeff' + rows.map(row => row.map(quoteCsv).join(',')).join('\r\n'), blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), anchor = document.createElement('a');
          anchor.href = url; anchor.download = (normalizeCollection(collection).name || 'smart-collection').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) + '.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); app.notify((window.NotejectI18n?.t?.('Exported {count} matching items') || 'Exported {count} matching items').replace('{count}', String(matches.length))); return;
        }
        if (action === 'more') { state[view].limit += 60; app.render(); return; }
        if (action === 'clear-search') { state[view].query = ''; state[view].limit = 60; app.render(); }
      };
      page.onchange = event => {
        if (!event.target.matches('[data-wo-filter="kind"]')) return;
        state[view].kind = event.target.value; state[view].limit = 60; app.render();
      };
      page.onsubmit = event => {
        const form = event.target.closest('[data-wo-form]');
        if (!form || !page.contains(form)) return;
        event.preventDefault();
        const values = new FormData(form), data = getData();
        if (form.dataset.woForm === 'search') { state[view].query = text(values.get('query')).trim(); if (values.has('kind')) state[view].kind = values.get('kind'); state[view].limit = 60; app.render(); return; }
        if (form.dataset.woForm === 'create-project') {
          const name = text(values.get('name')).trim(); if (!name) return;
          if (lower(name) === 'inbox') { app.notify('Inbox already collects unsorted items. Choose another project name.'); return; }
          try {
            const result = app.createFolder(name); if (!result?.folder) { app.notify('Enter a project name.'); return; }
            const description = text(values.get('description')).trim().slice(0, 1000);
            const existing = data.workspace.projects.find(project => project.folder === result.folder);
            if (!existing) data.workspace.projects.push({ id: app.makeId(), folder: result.folder, name: result.folder, description, color: COLORS.includes(values.get('color')) ? values.get('color') : 'violet', boardIds: [] });
            let message = result.created ? 'Project created' : 'Existing project opened';
            if (result.created) {
              try {
                const starter = createProjectStarter(data, result.folder, name, description, text(values.get('workflow')) || 'project-plan', app);
                if (starter.boards) message += ' with a connected study board and ' + starter.notes + ' starter notes';
                else if (starter.notes) message += ' with a starter note';
              } catch (error) { message += ', but its starter content could not be added'; }
            }
            selectedProject = result.folder; projectForm = false; state.projects.query = ''; state.projects.kind = 'all'; finish(message);
          } catch (error) { app.notify(error.message || 'Could not create project'); }
          return;
        }
        if (form.dataset.woForm === 'project-details') {
          if (!setProjectBoards(data, selectedProject, values.getAll('boardIds'), app.makeId)) return;
          const project = data.workspace.projects.find(item => item.folder === selectedProject);
          const name = text(values.get('name')).trim(); if (!name) { app.notify('Enter a project name.'); return; }
          project.name = name.slice(0, 100); project.description = text(values.get('description')).trim().slice(0, 1000); project.color = COLORS.includes(values.get('color')) ? values.get('color') : 'violet'; finish('Project details saved'); return;
        }
        if (form.dataset.woForm === 'collection') {
          const result = upsertCollection(data, { id: values.get('id'), name: values.get('name'), query: values.get('query'), kind: values.get('kind'), folder: values.get('folder'), tag: values.get('tag'), fileType: values.get('fileType'), favorite: values.has('favorite') }, app.makeId);
          if (result) { selectedCollection = result.id; editCollection = null; state.collections.query = ''; finish('Smart collection saved'); }
        }
      };
      if (projectForm) projectSetup?.mount(page);
    }
    return {
      render, mount,
      getLocation() { return { project: selectedProject, collection: selectedCollection }; },
      openCollection(collectionId) { selectedCollection = text(collectionId); editCollection = null; state.collections.query = ''; state.collections.kind = 'all'; state.collections.limit = 60; },
      startProject(options = {}) { selectedProject = ''; projectForm = true; projectSetup?.open(options); state.projects.query = ''; state.projects.kind = 'all'; state.projects.limit = 60; },
      openProject(folderOrId) { selectedProject = text(folderOrId); projectForm = false; state.projects.query = ''; state.projects.kind = 'all'; state.projects.limit = 60; if (visitProject(getData(), selectedProject)) app.save(); }
    };
  }
  return { create, model: { ensureWorkspace, libraryItems, projects, projectItems, recentProjects, visitProject, favorites, normalizeCollection, collectionMatches, historyItems, setFavorite, setProjectBoards, deleteProject, upsertCollection, removeCollection } };
});
