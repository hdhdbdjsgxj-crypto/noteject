/* Project setup is prepared locally before the workspace is changed. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotejectProjectWorkflow = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  const mobile = typeof window === 'object' && !!window.NotejectAndroid;
  const translate = value => globalThis.NotejectI18n?.t?.(value) || value;
  const colors = Object.freeze(['violet', 'blue', 'teal', 'amber', 'rose', 'gray']);
  const layouts = Object.freeze([{ id: 'grid', name: 'Grid' }, { id: 'columns', name: 'Columns' }]);
  const destinations = Object.freeze([
    { id: 'project', name: 'Project overview' }, { id: 'board', name: 'Project board' },
    { id: 'notes', name: 'Project notes' }, { id: 'documents', name: 'Project documents' },
    { id: 'tasks', name: 'Tasks' }
  ].filter(item => !mobile || item.id !== 'tasks'));
  const starterNotes = Object.freeze([
    { id: 'plan', name: 'Project plan', description: 'Outcome, scope, milestones, and progress.' },
    { id: 'research', name: 'Research', description: 'Questions, evidence, sources, and open questions.' },
    { id: 'reading', name: 'Reading notes', description: 'Sources, passages, and your reflections.' },
    { id: 'ideas', name: 'Ideas', description: 'Capture ideas and connect related notes.' },
    { id: 'draft', name: 'Draft', description: 'Outline, working draft, and revision notes.' },
    { id: 'tasks', name: 'Tasks', description: 'A checklist linked to the workspace Tasks page.' }
  ].filter(item => !mobile || item.id !== 'tasks'));
  const presets = Object.freeze([
    { id: 'plan', name: 'Project plan', icon: '◇', description: 'Start with a plan, ideas, and a practical checklist.', color: 'violet', starterNotes: ['plan', 'ideas', 'tasks'], tasks: 'Define the first milestone\nCollect the materials\nReview the result', createBoard: true },
    { id: 'research', name: 'Research', icon: '⌕', description: 'Collect questions, reading notes, and supporting evidence.', color: 'teal', starterNotes: ['research', 'reading', 'ideas', 'tasks'], tasks: 'Define the research question\nFind a reliable source\nReview the evidence', createBoard: true },
    { id: 'reading', name: 'Reading', icon: '▤', description: 'Organize sources, key ideas, and your next reading session.', color: 'blue', starterNotes: ['reading', 'ideas', 'tasks'], tasks: 'Add the source material\nRead the first section\nSummarize the key ideas', createBoard: true },
    { id: 'study', name: 'Study', icon: '▧', description: 'Connect a learning plan, notes, concepts, and review tasks.', color: 'teal', starterNotes: ['plan', 'reading', 'ideas', 'tasks'], tasks: 'Read the source material\nExplain the key ideas in my own words\nRevisit unanswered questions', createBoard: true },
    { id: 'writing', name: 'Writing', icon: '✎', description: 'Prepare a plan, sources, draft, and revision checklist.', color: 'rose', starterNotes: ['plan', 'research', 'draft', 'tasks'], tasks: 'Define the audience and purpose\nCreate the outline\nWrite the first draft\nRevise and review', createBoard: true },
    { id: 'blank', name: 'Blank project', icon: '＋', description: 'Choose exactly what to create, starting with an empty project.', color: 'violet', starterNotes: [], tasks: '', createBoard: false }
  ].map(item => mobile ? { ...item, starterNotes: item.starterNotes.filter(id => id !== 'tasks'), tasks: '' } : item));
  const aliases = { 'project-plan': 'plan', 'research-note': 'research', 'reading-note': 'reading', 'study-board': 'study' };
  const array = value => Array.isArray(value) ? value : [];
  const text = value => String(value == null ? '' : value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const lower = value => text(value).normalize('NFKC').toLocaleLowerCase();
  const unique = values => [...new Set(values)];
  const validDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number), date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };

  function defaultConfig(workflow = 'plan') {
    const preset = presets.find(item => item.id === (aliases[workflow] || workflow)) || presets[0];
    return {
      workflow: preset.id, name: '', description: '', color: preset.color, noteColor: 'project',
      tags: [], starterNotes: [...preset.starterNotes], tasks: translate(preset.tasks), dueDate: '',
      createBoard: preset.createBoard, boardName: '', boardLayout: 'grid', linkBoardIds: [],
      pinOverview: true, openAfter: 'project'
    };
  }

  function normalizeTags(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : text(value).split(/[,;\n]+/)).map(tag => text(tag).trim().replace(/^#+/, '').slice(0, 60)).filter(tag => {
      const key = lower(tag);
      if (!key || seen.has(key) || seen.size >= 30) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeTasks(value) {
    return (Array.isArray(value) ? value : text(value).split(/\r?\n/)).map(line => text(line).trim().replace(/^(?:(?:[-+*]|\d+[.)])\s+)?\[[ xX]\]\s*/, '').replace(/^(?:[-+*]|\d+[.)])\s+/, '').trim().slice(0, 500)).filter(Boolean).slice(0, 200).join('\n');
  }

  function normalizeConfig(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    const defaults = defaultConfig(value.workflow);
    const config = { ...defaults, ...value };
    config.workflow = defaults.workflow;
    config.name = text(config.name).trim();
    config.description = text(own(value, 'description') ? value.description : value.goal).trim().slice(0, 3000);
    config.color = colors.includes(config.color) ? config.color : defaults.color;
    config.noteColor = config.noteColor === 'project' || colors.includes(config.noteColor) ? config.noteColor : 'project';
    config.tags = normalizeTags(config.tags);
    config.starterNotes = unique(array(config.starterNotes).filter(id => starterNotes.some(starter => starter.id === id)));
    config.tasks = normalizeTasks(config.tasks);
    config.dueDate = validDate(text(config.dueDate)) ? text(config.dueDate) : '';
    // Android keeps the shared starter-note workflows but does not create
    // desktop-only task metadata or expose the Tasks destination.
    if (mobile) { config.tasks = ''; config.dueDate = ''; }
    config.createBoard = !!config.createBoard;
    config.boardName = text(config.boardName).trim().slice(0, 180);
    config.boardLayout = layouts.some(item => item.id === config.boardLayout) ? config.boardLayout : 'grid';
    config.linkBoardIds = unique(array(config.linkBoardIds).filter(id => typeof id === 'string' && id));
    config.pinOverview = !!config.pinOverview;
    config.openAfter = destinations.some(item => item.id === config.openAfter) ? config.openAfter : 'project';
    // Only configuration fields cross the persistence boundary.
    return Object.fromEntries(Object.keys(defaults).map(key => [key, config[key]]));
  }

  function reusableDefaults(value) {
    const result = normalizeConfig(value);
    for (const field of ['name', 'description', 'boardName', 'dueDate', 'linkBoardIds']) delete result[field];
    return result;
  }

  function selectedStarters(config) {
    const ids = [...config.starterNotes];
    if (config.tasks && !ids.includes('tasks')) ids.push('tasks');
    return ids.map(id => starterNotes.find(item => item.id === id));
  }

  function preview(value) {
    const config = normalizeConfig(value), selected = selectedStarters(config);
    return {
      notes: selected.length, boards: config.createBoard ? 1 : 0,
      tasks: config.tasks ? config.tasks.split('\n').length : 0,
      linkedBoards: config.linkBoardIds.length,
      noteTitles: selected.map(starter => starter.name)
    };
  }

  function projectNames(data) {
    return [
      ...array(data.folders), ...array(data.noteFolders), ...Object.keys(data.folderProjects || {}),
      ...array(data.workspace?.projects).flatMap(item => [item?.folder, item?.name]),
      ...array(data.notes).map(item => item?.folder), ...array(data.docs).map(item => item?.folder),
      ...array(data.boards).map(item => item?.folder)
    ].filter(name => typeof name === 'string' && name.trim());
  }

  function validate(data = {}, value = {}) {
    const config = normalizeConfig(value), errors = [], name = config.name;
    if (!name) errors.push('Enter a project name.');
    else if (name.length > 80) errors.push('Use a project name with 80 characters or fewer.');
    else if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..') errors.push('Choose a project name without special path characters or a trailing period.');
    else if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || ['inbox', 'all projects', 'all notes', 'all documents', 'all files'].includes(lower(name))) errors.push('This project name is reserved. Choose another name.');
    else if (projectNames(data || {}).some(existing => lower(existing.trim()) === lower(name))) errors.push('A project with this name already exists. Choose another name.');
    return { valid: !errors.length, errors, config };
  }

  function contentFor(starter, config) {
    const heading = '# ' + config.name + ' · ' + translate(starter.name);
    const goal = config.description ? ['## ' + translate('Project goal'), config.description, ''] : [];
    const bodies = {
      plan: ['## Outcome', '', '## Scope', '', '## Milestones', '- First milestone:', '- Next milestone:', '', '## Resources', '', '## Progress log', ''],
      research: ['## Research question', '', '## Working explanation', '', '## Evidence', '- Claim:', '  - Source:', '', '## Contradictions and gaps', '', '## Next questions', ''],
      reading: ['## Sources', '- Title:', '  - Author:', '  - Document:', '', '## Key ideas', '- ', '', '## Passages and references', '', '## My thoughts', ''],
      ideas: ['## Ideas to explore', '- ', '', '## Connections', 'Use [[Note title]] to link related notes.', '', '## Questions', ''],
      draft: ['## Audience and purpose', '', '## Outline', '- ', '', '## Working draft', '', '## Revision notes', ''],
      tasks: ['## Next steps', ...(config.tasks ? config.tasks.split('\n').map(task => '- [ ] ' + task) : []), '']
    };
    // Joining literal text preserves characters such as $&, $$, and replacement tokens in goals.
    const body = starter.id === 'tasks' ? ['## ' + translate('Next steps'), ...(config.tasks ? config.tasks.split('\n').map(task => '- [ ] ' + task) : []), ''] : bodies[starter.id].map(line => line.replace(/^([#\s-]*)(.*)$/, (_all, prefix, copy) => prefix + translate(copy)));
    return [heading, '', ...goal, ...body].join('\n');
  }

  function collectTaskMeta(notes, dueDate) {
    const metadata = {};
    if (!dueDate) return metadata;
    for (const note of notes) {
      const occurrences = new Map();
      let fence = null;
      for (const line of note.content.split(/\r?\n/)) {
        const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
          if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
          continue;
        }
        if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
        const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+(.*)$/);
        if (!match || !match[1].trim()) continue;
        const task = match[1].trim(), occurrence = occurrences.get(task) || 0;
        occurrences.set(task, occurrence + 1);
        metadata[JSON.stringify([note.id, task, occurrence])] = { due: dueDate, priority: 'normal' };
      }
    }
    return metadata;
  }

  function build(data = {}, value, makeId, now = Date.now()) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    const checked = validate(data, value);
    if (!checked.valid) { const error = new Error(checked.errors[0]); error.errors = checked.errors; throw error; }
    if (typeof makeId !== 'function') throw new Error('Project creation needs an ID generator.');
    const config = checked.config, time = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const taken = new Set([
      ...array(data.notes), ...array(data.docs), ...array(data.boards), ...array(data.workspace?.projects),
      ...array(data.boards).flatMap(board => array(board.edges))
    ].map(item => text(item?.id)).filter(Boolean));
    const nextId = () => {
      const proposed = text(makeId()).trim();
      if (!proposed) throw new Error('Could not create an ID for the project. Try again.');
      let candidate = proposed, suffix = 1;
      while (taken.has(candidate)) candidate = proposed + '-' + (++suffix);
      taken.add(candidate);
      return candidate;
    };
    const project = {
      id: nextId(), folder: config.name, name: config.name, description: config.description,
      color: config.color, tags: [...config.tags], boardIds: [], workflow: config.workflow,
      created: time, updated: time, setup: normalizeConfig(config)
    };
    const selected = selectedStarters(config);
    const notes = selected.map((starter, index) => ({
      id: nextId(), title: config.name + ' · ' + translate(starter.name), content: contentFor(starter, config),
      folder: config.name, color: config.noteColor === 'project' ? config.color : config.noteColor,
      tags: unique([...config.tags, starter.id === 'plan' ? 'project' : starter.id]),
      favorite: config.pinOverview && index === 0, archived: false, created: time, updated: time
    }));
    const board = config.createBoard ? {
      id: nextId(), name: config.boardName || config.name + ' · ' + translate('Board'), folder: config.name,
      description: config.description, tags: [...config.tags], created: time, updated: time, zoom: .1, worldFrame: { width: 16000, height: 10000 }, focusNewAssets: true,
      items: notes.map((note, index) => ({ type: 'note', id: note.id, x: 697 + (config.boardLayout === 'columns' ? index : index % 2) * 460, y: 420 + (config.boardLayout === 'columns' ? 0 : Math.floor(index / 2)) * 340 })),
      edges: notes.slice(1).map((note, index) => ({ id: nextId(), from: notes[index].id, to: note.id, label: translate('next step') }))
    } : null;
    const existingBoards = new Set(array(data.boards).map(item => item.id));
    project.boardIds = unique([...(board ? [board.id] : []), ...config.linkBoardIds.filter(id => existingBoards.has(id))]);
    let primary = { kind: 'project', id: project.id };
    if (config.openAfter === 'board') {
      if (project.boardIds[0]) primary = { kind: 'board', id: project.boardIds[0] };
    } else if (config.openAfter === 'notes') primary = { kind: 'notes', folder: config.name, id: notes[0]?.id || '' };
    else if (config.openAfter === 'documents' || config.openAfter === 'tasks') primary = { kind: config.openAfter, folder: config.name };
    return { config, project, notes, board, taskMeta: collectTaskMeta(notes, config.dueDate), boardIds: [...project.boardIds], primary };
  }

  return { presets, starterNotes, colors, layouts, destinations, defaultConfig, normalizeConfig, reusableDefaults, preview, validate, build };
});
