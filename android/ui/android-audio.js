/* Android voice notes. Originals and transcripts stay in the workspace. */
(() => {
  'use strict';
  if (!window.NotejectAndroid) return;
  const storageKey = 'noteject-android-audio-ui-v1';
  const qualityStorageKey = 'noteject-android-audio-quality-v1';
  const elements = {};
  let metadata = {}, recordings = [], capabilities = {}, active = null, selectedId = null;
  let busy = false, status = 'idle', lastElapsed = 0, lastElapsedAt = performance.now(), errorText = '';
  let transcribingMode = null, transcriptionCancelling = false, closeAfterTranscription = false;
  let activeAiController = null;
  let transcriptionProgress = null, transcribingId = null;
  let transcriptionQuality = null, transcriptionPreview = null;
  let listTerm = '', previousFocus = null, unsubscribe = null, refreshPending = false;
  let pageOpen = false, detailOpen = false, pendingNavigation = null;
  let playbackUrl = '';
  const publishing = new Map();
  try { metadata = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') metadata = {};
  try { const saved = localStorage.getItem(qualityStorageKey); if (['accurate', 'fast'].includes(saved)) transcriptionQuality = saved; } catch {}
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const translate = text => window.NotejectI18n?.t?.(text) || text;
  const button = (text, action, className = '') => { const node = el('button', className, text); node.type = 'button'; if (action) node.dataset.audioAction = action; return node; };
  const label = (text, control) => { const node = el('label', 'aa-field'); node.append(el('span', '', text), control); return node; };
  const input = (type, name) => { const node = el('input'); node.type = type; node.name = name; node.autocomplete = 'off'; return node; };
  const announce = text => { if (typeof notify === 'function') notify(text); };
  const formatTime = value => { const seconds = Math.floor(Math.max(0, Number(value) || 0) / 1000); return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0'); };
  const formatDate = value => { const date = new Date(Number(value) || value || Date.now()); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(globalThis.document?.documentElement?.lang || undefined, { month: 'short', day: 'numeric' }); };
  const isActive = () => status === 'recording' || status === 'paused';
  const currentRecord = () => recordings.find(item => item.id === selectedId) || null;
  const sharedData = () => typeof data !== 'undefined' ? data : null;
  const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(metadata)); } catch { setError('There is not enough storage to save your transcript draft. Save it as a note.'); } };
  const detailsFor = record => ({ ...record, ...(metadata[record.id] || {}) });
  const qualityModes = () => {
    const modes = capabilities.onDeviceQualityModes;
    const supported = Array.isArray(modes) ? modes.filter(mode => ['accurate', 'fast'].includes(mode)) : ['accurate', 'fast'];
    return supported.length ? supported : ['accurate', 'fast'];
  };
  const selectedQuality = () => {
    const modes = qualityModes();
    return modes.includes(transcriptionQuality) ? transcriptionQuality : modes.includes(capabilities.defaultTranscriptionQuality) ? capabilities.defaultTranscriptionQuality : modes.includes('accurate') ? 'accurate' : modes[0];
  };
  function renderTranscriptionPreview() {
    if (!elements.liveTranscript) return;
    const text = transcriptionPreview?.id === selectedId && transcriptionPreview.id === transcribingId ? transcriptionPreview.text : '';
    elements.liveTranscript.hidden = !text;
    elements.liveTranscriptText.textContent = text || '';
  }
  function clearTranscriptionPreview() { transcriptionPreview = null; renderTranscriptionPreview(); }
  function renderQualityHint() {
    if (!elements.qualityHint) return;
    elements.qualityHint.textContent = selectedQuality() === 'accurate'
      ? 'Better accuracy uses more memory and may take longer. Keep noteject open until it finishes.'
      : 'Fast uses less memory. Choose Better accuracy when words are missed or recognized incorrectly.';
  }
  function projects() {
    const workspace = sharedData();
    return [...new Set(['Inbox', ...(workspace?.folders || []), ...(workspace?.noteFolders || [])])].filter(value => typeof value === 'string' && value).sort((a, b) => a === 'Inbox' ? -1 : b === 'Inbox' ? 1 : a.localeCompare(b));
  }
  function fillProjects(select, value = 'Inbox') {
    const names = projects(); if (!names.includes(value)) names.push(value);
    select.replaceChildren(...names.map(name => { const option = el('option', '', name); option.value = name; return option; }));
    select.value = value;
  }
  function setError(text) { errorText = String(text || ''); elements.error.textContent = errorText; elements.error.hidden = !errorText; }
  async function command(action, payload = {}) {
    const api = window.NotejectAndroidAudio;
    if (!api?.command) throw Error('Audio tools are unavailable. Update noteject to the latest Android APK.');
    const result = await api.command(action, payload);
    if (result?.error) throw Error(String(result.error));
    return result;
  }
  function acceptState(result) {
    if (!result || typeof result !== 'object' || result instanceof Blob) return;
    if (Array.isArray(result)) recordings = result;
    if (Array.isArray(result.recordings)) recordings = result.recordings;
    if (result.capabilities) capabilities = { ...capabilities, ...result.capabilities };
    const nativeStatus = result.status || result.state;
    if (nativeStatus) status = ['saved', 'stopped', 'ready', 'discarded'].includes(nativeStatus) ? 'idle' : nativeStatus;
    if (Object.prototype.hasOwnProperty.call(result, 'recording')) {
      active = result.recording;
      if (active?.id && !isActive()) upsert(active);
    }
    const elapsed = result.elapsedMs ?? result.durationMs ?? result.recording?.elapsedMs ?? result.recording?.durationMs;
    if (elapsed !== undefined && isActive()) {
      lastElapsed = Number(elapsed) || 0;
      lastElapsedAt = performance.now();
    }
  }
  function upsert(record) {
    if (!record?.id) return;
    const index = recordings.findIndex(item => item.id === record.id);
    if (index < 0) recordings.unshift(record); else recordings[index] = { ...recordings[index], ...record };
  }
  async function refresh() {
    if (refreshPending) return;
    refreshPending = true;
    try {
      acceptState(await command('get-state'));
      acceptState(await command('list'));
      if (active?.id && isActive()) selectedId = active.id;
      if (selectedId && !recordings.some(item => item.id === selectedId) && selectedId !== active?.id) { selectedId = null; detailOpen = false; }
      renderAudio();
      for (const record of recordings) if (!metadata[record.id]?.documentId) void publish(record).catch(() => {});
    } catch (error) { setError(error.message || 'Could not open your recordings.'); }
    finally { refreshPending = false; }
  }
  async function run(work) {
    if (busy) return;
    busy = true; setError(''); renderControls();
    try { await work(); }
    catch (error) { setError(error.message || 'Could not complete this audio action.'); }
    finally { busy = false; renderControls(); if (closeAfterTranscription && !transcribingMode) { closeAfterTranscription = false; finishPendingNavigation(); } }
  }

  const dialog = el('section', 'aa-dialog');
  dialog.id = 'android-audio-dialog'; dialog.hidden = true; dialog.setAttribute('aria-labelledby', 'aa-record-title');
  const scroll = el('div', 'aa-scroll');
  elements.error = el('p', 'aa-error'); elements.error.hidden = true; elements.error.setAttribute('role', 'alert');
  const recording = el('section', 'aa-record-panel'); recording.setAttribute('aria-labelledby', 'aa-record-title');
  const recordEyebrow = el('p', 'aa-recorder-eyebrow', 'VOICE RECORDER');
  const recordTitle = el('h2', '', 'New recording'); recordTitle.id = 'aa-record-title';
  const recordHeading = el('header', 'aa-recorder-heading'); recordHeading.append(recordEyebrow, recordTitle);
  const recordHint = el('p', 'aa-muted', 'Capture a thought now. You can organize and transcribe it afterward.');
  elements.name = input('text', 'recording-name'); elements.name.placeholder = 'Recording name'; elements.name.maxLength = 120;
  elements.project = el('select'); elements.project.name = 'recording-project';
  const freshRecordingName = () => (window.NotejectI18n?.t?.('Voice note') || 'Voice note') + ' · ' + new Date().toLocaleDateString(document.documentElement.lang || undefined);
  elements.name.value = freshRecordingName(); fillProjects(elements.project);
  const fields = el('div', 'aa-fields'); fields.append(label('Name', elements.name), label('Project', elements.project));
  elements.timer = el('output', 'aa-timer', '00:00'); elements.timer.setAttribute('aria-label', 'Recording duration');
  elements.status = el('span', 'aa-status', 'Ready to record'); elements.status.setAttribute('role', 'status'); elements.status.setAttribute('aria-live', 'polite'); elements.status.setAttribute('aria-atomic', 'true');
  const waveform = el('div', 'aa-waveform'); waveform.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 25; index++) { const bar = el('i'); bar.style.setProperty('--aa-level', (20 + ((index * 29) % 72)) + '%'); bar.style.setProperty('--aa-delay', (-index * 47) + 'ms'); waveform.append(bar); }
  const live = el('div', 'aa-live'); live.append(waveform, elements.timer, elements.status);
  elements.record = button('', 'record', 'aa-record-button');
  elements.record.innerHTML = '<span class="aa-record-orb" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 10v1.5a6.5 6.5 0 0 0 13 0V10M12 18v3M8.5 21h7"></path></svg></span><span class="aa-record-label"><strong>Start recording</strong><small>Tap to capture audio</small></span>';
  elements.record.setAttribute('aria-label', 'Start recording audio');
  elements.pause = button('Pause', 'pause', 'aa-secondary');
  elements.stop = button('■ Stop & save', 'stop', 'aa-primary');
  elements.discard = button('Discard', 'discard', 'aa-text-button destructive-action');
  const controls = el('div', 'aa-record-controls'); controls.append(elements.record, elements.pause, elements.stop, elements.discard);
  elements.deviceHint = el('p', 'aa-privacy', 'Microphone access is requested when you tap Record. Audio is saved on this device.');
  recording.append(recordHeading, recordHint, live, controls, fields, elements.deviceHint);
  const library = el('section', 'aa-library'); library.setAttribute('aria-labelledby', 'aa-library-title');
  const libraryHeading = el('header', 'aa-section-heading');
  const libraryTitle = el('h2', '', 'Your recordings'); libraryTitle.id = 'aa-library-title';
  elements.count = el('span', 'aa-count', '0'); libraryHeading.append(libraryTitle, elements.count);
  elements.search = input('search', 'recording-search'); elements.search.placeholder = 'Search recordings…'; elements.search.setAttribute('aria-label', 'Search recordings'); elements.search.enterKeyHint = 'search';
  elements.list = el('div', 'aa-recording-list');
  library.append(libraryHeading, elements.search, elements.list);
  elements.detail = el('section', 'aa-detail'); elements.detail.hidden = true;
  elements.confirm = el('section', 'aa-confirm'); elements.confirm.hidden = true; elements.confirm.setAttribute('aria-live', 'polite');
  scroll.append(elements.error, recording, elements.detail, library, elements.confirm);
  elements.cancelTranscription = button('Cancel transcription', 'cancel-transcription', 'aa-secondary aa-cancel-transcription');
  elements.cancelTranscription.hidden = true;
  elements.cancelTranscription.onclick = () => { void cancelTranscription(); };
  dialog.append(elements.cancelTranscription, scroll); document.body.append(dialog);

  function renderControls() {
    const ongoing = isActive();
    elements.record.hidden = ongoing; elements.pause.hidden = !ongoing; elements.stop.hidden = !ongoing; elements.discard.hidden = !ongoing;
    elements.pause.textContent = status === 'paused' ? '▶ Resume' : 'Ⅱ Pause';
    elements.name.disabled = ongoing || busy; elements.project.disabled = ongoing || busy;
    if (elements.quality) elements.quality.disabled = ongoing || busy || capabilities.localTranscription === false;
    for (const node of dialog.querySelectorAll('[data-audio-action]')) node.disabled = (busy && !['close', 'cancel-transcription'].includes(node.dataset.audioAction)) || (ongoing && ['transcribe-device', 'transcribe-ai'].includes(node.dataset.audioAction)) || (node.dataset.audioAction === 'transcribe-device' && capabilities.localTranscription === false) || (node.dataset.audioAction === 'record' && ['starting', 'saving', 'transcribing'].includes(status)) || (node.dataset.audioAction === 'cancel-transcription' && transcriptionCancelling);
    elements.cancelTranscription.hidden = !transcribingMode;
    elements.cancelTranscription.textContent = transcriptionCancelling ? 'Cancelling transcription…' : 'Cancel transcription';
    elements.pause.setAttribute('aria-pressed', String(status === 'paused'));
    dialog.setAttribute('aria-busy', String(busy || !!transcribingMode));
    elements.status.textContent = transcriptionCancelling ? 'Cancelling transcription…' : transcribingMode || status === 'transcribing' ? 'Transcribing speech to text…' + (transcriptionProgress === null ? '' : ' ' + transcriptionProgress + '%') : status === 'saving' ? 'Saving your recording…' : busy ? 'Working…' : status === 'recording' ? 'Recording · keep noteject open' : status === 'paused' ? 'Recording paused' : 'Ready to record';
    dialog.classList.toggle('aa-is-recording', status === 'recording');
    dialog.classList.toggle('aa-is-paused', status === 'paused');
    elements.timer.textContent = formatTime(ongoing ? lastElapsed + (status === 'recording' ? performance.now() - lastElapsedAt : 0) : 0);
    elements.deviceHint.textContent = transcribingMode ? 'Keep noteject open while transcribing. Longer recordings can take more time. You can cancel and keep the original audio.' : status === 'paused' ? 'Paused · microphone off. Switching apps or locking your screen automatically stops and saves this recording.' : status === 'recording' ? 'Microphone active. Switching apps or locking your screen automatically stops and saves this recording. Maximum recording: ' + Math.round((capabilities.maxDurationMs || 7200000) / 60000) + ' minutes.' : 'Up to 120 minutes per recording. No account needed to record. On-device transcription supports English. Audio is kept in this app’s private storage.';
  }
  function renderList() {
    const term = listTerm.toLocaleLowerCase();
    const rows = recordings.filter(item => { const record = detailsFor(item); return !term || [record.name, record.folder, record.transcript].join(' ').toLocaleLowerCase().includes(term); });
    elements.count.textContent = String(rows.length); elements.count.setAttribute('aria-label', rows.length + (rows.length === 1 ? ' recording' : ' recordings'));
    elements.list.replaceChildren();
    if (!rows.length) {
      const empty = el('div', 'aa-empty'); empty.append(el('strong', '', term ? 'No matching recordings' : 'Your next idea starts here'), el('p', 'aa-muted', term ? 'Try a different name or project.' : 'Record a voice note above. You can listen, transcribe, and save it in Notes.')); elements.list.append(empty); return;
    }
    for (const item of rows) {
      const record = detailsFor(item), row = button('', 'select', 'aa-recording-row'); row.dataset.audioId = item.id;
      row.setAttribute('aria-pressed', String(detailOpen && item.id === selectedId));
      const glyph = el('span', 'aa-recording-glyph', '♪'); glyph.setAttribute('aria-hidden', 'true');
      const copy = el('span', 'aa-recording-copy');
      copy.append(el('strong', '', record.name || 'Voice note'), el('small', '', [formatTime(record.durationMs || record.duration), record.folder || 'Inbox', formatDate(record.createdAt || record.created)].filter(Boolean).join(' · ')));
      if (record.transcript) copy.append(el('span', 'aa-transcript-preview', record.transcript.replace(/\s+/g, ' ').slice(0, 100)));
      row.append(glyph, copy, el('span', 'aa-row-arrow', '›')); elements.list.append(row);
    }
  }
  function saveDraft() {
    if (!selectedId || !elements.transcript || elements.transcript.dataset.id !== selectedId) return;
    metadata[selectedId] = { ...(metadata[selectedId] || {}), transcript: elements.transcript.value };
    persist();
  }
  function clearPlayback() {
    const player = elements.detail.querySelector('audio'); if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
    if (playbackUrl.startsWith('blob:')) URL.revokeObjectURL(playbackUrl);
    playbackUrl = '';
  }
  function renderDetail() {
    const record = detailOpen ? currentRecord() : null; elements.detail.hidden = !record;
    if (transcriptionPreview && transcriptionPreview.id !== record?.id) clearTranscriptionPreview();
    if (!record) { clearPlayback(); elements.detail.replaceChildren(); return; }
    if (elements.transcript?.dataset.id === record.id && document.activeElement === elements.transcript) return;
    clearPlayback(); elements.detail.replaceChildren();
    const item = detailsFor(record), heading = el('header', 'aa-section-heading aa-detail-heading');
    const back = button('← Recordings', 'detail-back', 'aa-detail-back');
    const detailTitle = el('h2', '', item.name || 'Voice note');
    heading.append(back, detailTitle, button('Delete', 'delete', 'aa-danger-text'));
    const name = input('text', 'saved-recording-name'); name.value = item.name || 'Voice note'; name.maxLength = 120;
    const project = el('select'); project.name = 'saved-recording-project'; fillProjects(project, item.folder || 'Inbox');
    const fields = el('div', 'aa-fields'); fields.append(label('Recording name', name), label('Project', project));
    const update = button('Save details', 'rename', 'aa-secondary');
    update.onclick = () => run(async () => {
      const title = name.value.trim(); if (!title) { name.focus(); throw Error('Enter a name for this recording.'); }
      const result = await command('rename', { id: record.id, name: title, folder: project.value, projectId: sharedData()?.folderProjects?.[project.value] || '' });
      metadata[record.id] = { ...(metadata[record.id] || {}), name: title, folder: project.value }; persist();
      upsert({ ...record, name: title, folder: project.value, ...(result?.recording || {}) });
      const doc = sharedData()?.docs.find(doc => doc.id === metadata[record.id].documentId);
      if (doc) { doc.name = title.replace(/[\\/:*?"<>|]/g, '_') + '.wav'; doc.folder = project.value; if (typeof save === 'function') save(); }
      renderAudio(); announce('Recording details saved');
    });
    const player = el('audio', 'aa-player'); player.controls = true; player.preload = 'none'; player.setAttribute('aria-label', 'Play ' + (item.name || 'voice note'));
    const load = button('▶ Load recording', 'play', 'aa-secondary'); load.onclick = () => run(async () => {
      const source = window.NotejectAndroidAudio?.url ? await window.NotejectAndroidAudio.url({ id: record.id }) : URL.createObjectURL(await readBlob(record));
      if (selectedId !== record.id) { if (source.startsWith('blob:')) URL.revokeObjectURL(source); return; }
      clearPlayback(); playbackUrl = source; player.src = playbackUrl; load.hidden = true; try { await player.play(); } catch { /* The native media control remains available. */ }
    });
    const exportButton = button('↓ Export audio', 'export', 'aa-text-button'); exportButton.onclick = () => run(async () => {
      const name = (detailsFor(record).name || 'Voice note').replace(/[\\/:*?"<>|]/g, '_') + '.wav';
      if (capabilities.nativeAudioExport) { const result = await command('export', { id: record.id, name }); if (result.status === 'saved') announce('Audio exported'); }
      else { const blob = await readBlob(record); await window.NotejectAndroidFiles.save(blob, name); }
    });
    const playback = el('div', 'aa-playback'); playback.append(player, load, exportButton);
    const transcriptTitle = el('h3', '', 'Turn audio into text');
    elements.quality = el('select'); elements.quality.name = 'transcription-quality';
    for (const mode of qualityModes()) {
      const option = el('option', '', mode === 'accurate' ? 'Better accuracy' : 'Fast / lower memory'); option.value = mode; elements.quality.append(option);
    }
    elements.quality.value = selectedQuality(); elements.quality.disabled = busy || isActive() || capabilities.localTranscription === false;
    elements.qualityHint = el('p', 'aa-privacy aa-quality-hint'); elements.qualityHint.id = 'aa-quality-hint';
    elements.quality.setAttribute('aria-describedby', elements.qualityHint.id);
    elements.quality.onchange = () => {
      transcriptionQuality = elements.quality.value;
      try { localStorage.setItem(qualityStorageKey, transcriptionQuality); } catch { setError('The transcription preference could not be saved.'); }
      renderQualityHint();
    };
    const quality = el('div', 'aa-quality'); quality.append(label('On-device quality', elements.quality), elements.qualityHint); renderQualityHint();
    const device = button('Transcribe on device', 'transcribe-device', 'aa-primary'); device.disabled = capabilities.localTranscription === false;
    device.onclick = () => transcribe(record, 'device');
    const localCopy = el('p', 'aa-privacy', capabilities.localTranscription === false ? 'On-device speech model is unavailable in this APK.' : 'English · offline · no key needed. First use prepares the selected speech model.');
    const ai = button(translate('Transcribe with AI'), 'transcribe-ai', 'aa-secondary aa-ai-transcribe');
    ai.onclick = () => transcribe(record, 'ai');
    const aiCopy = el('p', 'aa-privacy aa-ai-hint', translate('Paid Starter, Pro, or Team plan and internet required. Each two-minute audio segment uses one Advanced AI action. Audio is uploaded only after you choose this option.'));
    elements.liveTranscript = el('section', 'aa-live-transcript'); elements.liveTranscript.hidden = true;
    elements.liveTranscript.setAttribute('aria-label', 'Transcription preview');
    elements.liveTranscript.append(el('strong', '', 'Live preview'), el('p', 'aa-privacy', 'Words may change as transcription continues. Your saved transcript stays below until this finishes.'));
    elements.liveTranscriptText = el('p', 'aa-live-transcript-text'); elements.liveTranscript.append(elements.liveTranscriptText); renderTranscriptionPreview();
    elements.transcript = el('textarea', 'aa-transcript'); elements.transcript.name = 'audio-transcript'; elements.transcript.rows = 8; elements.transcript.maxLength = 500000;
    elements.transcript.dataset.id = record.id; elements.transcript.value = item.transcript || ''; elements.transcript.placeholder = 'Your transcript appears here. You can edit it before saving as a note.';
    elements.transcript.setAttribute('aria-label', 'Editable transcript'); elements.transcript.oninput = () => { saveDraft(); renderList(); };
    const draftHint = el('p', 'aa-privacy', 'Transcript edits are kept on this device. Save as note adds this text to All notes and the selected project.');
    const saveNote = button(item.noteId ? 'Update saved note' : 'Save as note', 'save-note', 'aa-primary'); saveNote.onclick = () => run(() => saveAsNote(record, project.value, name.value));
    const saveText = button('Save transcript', 'save-transcript', 'aa-secondary'); saveText.onclick = () => run(async () => { saveDraft(); await command('save-transcript', { id: record.id, text: elements.transcript.value }); announce('Transcript saved'); });
    const noteActions = el('div', 'aa-note-actions'); noteActions.append(saveNote, saveText);
    if (item.noteId && sharedData()?.notes.some(note => note.id === item.noteId)) {
      const open = button('Open saved note ↗', 'open-note', 'aa-text-button'); open.onclick = () => {
        const go = () => { if (typeof openSmartSource === 'function') openSmartSource({ kind: 'note', id: item.noteId }); else { view = 'notes'; data.selected = { type: 'note', id: item.noteId }; render(); } };
        if (!beforeNavigate(go)) go();
      }; noteActions.append(open);
    }
    elements.detail.append(heading, fields, update, playback, transcriptTitle, quality, device, localCopy, ai, aiCopy, elements.liveTranscript, label('Transcript', elements.transcript), draftHint, noteActions);
  }
  function renderAudio() { renderControls(); renderList(); renderDetail(); }

  async function readBlob(record) {
    const docId = metadata[record.id]?.documentId;
    if (docId && typeof getStoredFile === 'function') { const stored = await getStoredFile(docId); if (stored instanceof Blob) return stored; }
    const result = window.NotejectAndroidAudio?.read ? await window.NotejectAndroidAudio.read({ id: record.id }) : await command('read', { id: record.id });
    if (result instanceof Blob) return result;
    if (result?.blob instanceof Blob) return result.blob;
    if (result?.base64) { const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)); return new Blob([bytes], { type: result.mimeType || result.mime || 'audio/wav' }); }
    if (result?.url) { const response = await fetch(result.url); if (!response.ok) throw Error('Could not load the saved audio.'); return response.blob(); }
    throw Error('This recording is unavailable on this device.');
  }
  async function publish(record) {
    if (!record?.id || typeof storeFile !== 'function' || !sharedData()) return null;
    if (publishing.has(record.id)) return publishing.get(record.id);
    const task = (async () => {
      const item = detailsFor(record), workspace = sharedData(), docId = metadata[record.id]?.documentId || 'recording-' + record.id;
      if (!workspace.docs.some(doc => doc.id === docId)) {
        const useNativeFile = Number(item.size) > 25000000;
        let blob = null, localUrl = '';
        if (useNativeFile) {
          if (!window.NotejectAndroidAudio?.url) throw Error('Update noteject to open long recordings without copying them into memory. Your audio is saved.');
          localUrl = await window.NotejectAndroidAudio.url({ id: record.id });
        } else { blob = await readBlob(record); await storeFile(docId, blob); localUrl = URL.createObjectURL(blob); }
        const folder = projects().includes(item.folder) ? item.folder : 'Inbox';
        workspace.docs.push({ id: docId, name: (item.name || 'Voice note').replace(/[\\/:*?"<>|]/g, '_') + '.wav', type: 'audio', mimeType: blob?.type || 'audio/wav', size: blob?.size || Number(item.size), added: Number(item.createdAt || item.created) || Date.now(), folder, favorite: false, audioRecordingId: record.id, nativeRecording: useNativeFile, localUrl, diskProject: workspace.folderProjects?.[folder] || 'folder-inbox' });
      }
      if (typeof save === 'function') save();
      if (typeof workspaceStore !== 'undefined' && !workspaceStore.flush()) throw Error('Audio is saved on this device, but could not be added to Documents. Free some device storage, then reopen Audio recordings to try again.');
      metadata[record.id] = { ...(metadata[record.id] || {}), documentId: docId }; persist(); return docId;
    })();
    publishing.set(record.id, task); try { return await task; } finally { publishing.delete(record.id); }
  }
  async function saveAsNote(record, folder, name) {
    saveDraft(); const text = elements.transcript.value.trim();
    if (!text) { elements.transcript.focus(); throw Error('Transcribe this recording or write some text first.'); }
    const workspace = sharedData(); if (!workspace) throw Error('Your workspace is not ready. Reopen Audio recordings.');
    const docId = await publish(record), current = metadata[record.id] || {}, now = Date.now();
    let note = workspace.notes.find(item => item.id === current.noteId);
    if (!note) { note = { id: typeof id === 'function' ? id() : crypto.randomUUID(), color: 'teal', created: now, favorite: false, archived: false, tags: ['recording', 'transcript'] }; workspace.notes.unshift(note); }
    Object.assign(note, { title: name.trim() || current.name || record.name || 'Voice note', content: text, folder: folder || 'Inbox', updated: now, audioRecordingId: record.id, audioDocumentId: docId });
    const transcriptDocument = workspace.docs.find(item => item.id === docId);
    if (transcriptDocument) { transcriptDocument.text = text; transcriptDocument.folder = note.folder; transcriptDocument.diskProject = workspace.folderProjects?.[note.folder] || transcriptDocument.diskProject; transcriptDocument.updated = now; if (typeof searchTextCache !== 'undefined') searchTextCache.set(docId, text); }
    metadata[record.id] = { ...current, noteId: note.id, transcript: text, folder: folder || 'Inbox', name: note.title }; persist();
    if (typeof save === 'function') save();
    if (typeof workspaceStore !== 'undefined' && !workspaceStore.flush()) throw Error('Could not save the note. Check device storage and try again.');
    await command('save-transcript', { id: record.id, text }).catch(() => {});
    renderDetail(); renderList(); announce('Transcript saved in All notes · ' + note.folder);
  }
  async function transcribe(record, mode) {
    await run(async () => {
      saveDraft();
      if (isActive()) throw Error('Stop and save the current recording before transcribing audio.');
      if (!['device', 'ai'].includes(mode)) throw Error('Choose on-device transcription or paid AI transcription.');
      if (elements.transcript.value.trim()) {
        ask('Replace the existing transcript?', 'Your saved note will stay as it is until you update it.', 'Replace transcript', async () => { await performTranscription(record, mode); }); return;
      }
      await performTranscription(record, mode);
    });
  }
  async function performTranscription(record, mode) {
    clearTranscriptionPreview(); transcribingMode = mode; transcribingId = record.id; transcriptionProgress = null; transcriptionCancelling = false; renderControls();
    try {
    elements.status.textContent = mode === 'ai' ? 'Preparing secure AI transcription…' : 'Transcribing on this device…';
    const result = mode === 'ai'
      ? { text: await transcribeWithAi(record) }
      : await command('transcribe', { id: record.id, mode, language: 'en', quality: selectedQuality() });
    const text = typeof result === 'string' ? result : result?.text ?? result?.transcript ?? result?.recording?.transcript;
    if (typeof text !== 'string') { acceptState(result); return; }
    if (mode === 'ai') await command('save-transcript', { id: record.id, text, engine: 'noteject-ai' }).catch(() => {});
    metadata[record.id] = { ...(metadata[record.id] || {}), transcript: text }; persist();
    upsert({ ...record, ...(result?.recording || {}), transcript: text });
    if (selectedId === record.id) { elements.transcript.value = text; renderDetail(); }
    renderList(); announce(text.trim() ? 'Transcript ready — review it, then Save as note' : 'No speech was detected. You can try again or type your note.');
    } finally { clearTranscriptionPreview(); transcribingMode = null; transcribingId = null; transcriptionProgress = null; transcriptionCancelling = false; renderControls(); }
  }
  async function transcribeWithAi(record) {
    const audio = window.NotejectAndroidAudio, cloud = window.NotejectCloudSession;
    if (!audio?.readRange) throw Error('Update the Android app to enable secure AI transcription.');
    if (!cloud?.getAccount || !cloud?.transcribeAudioSegment) throw Error('Sign in to your Noteject account to use AI transcription.');
    const account = await cloud.getAccount();
    if (!['starter', 'pro', 'team'].includes(String(account?.plan || '').toLowerCase())) throw Error('AI transcription requires an active Starter, Pro, or Team plan.');
    const sourceHeader = await audio.readRange({ id: record.id, offset: 0, length: 44 });
    const header = sourceHeader.bytes;
    if (header.length !== 44 || String.fromCharCode(...header.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...header.subarray(8, 12)) !== 'WAVE') throw Error('This is not a Noteject WAV recording. Your original audio is still saved.');
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const dataBytes = headerView.getUint32(40, true);
    if (sourceHeader.size !== dataBytes + 44 || dataBytes < 2 || dataBytes > 230400000 || dataBytes % 2) throw Error('Choose a valid recording of up to 120 minutes. Your audio is still saved.');
    const bytesPerSegment = 32000 * 120; // 16 kHz, 16-bit mono, two minutes per metered AI action.
    const total = Math.ceil(dataBytes / bytesPerSegment);
    let transcript = '';
    activeAiController = new AbortController();
    try {
      for (let index = 0; index < total; index++) {
        if (activeAiController.signal.aborted) throw new DOMException('AI transcription cancelled. Your recording is still saved.', 'AbortError');
        const offset = index * bytesPerSegment, length = Math.min(bytesPerSegment, dataBytes - offset);
        const part = await audio.readRange({ id: record.id, offset: 44 + offset, length });
        const segmentHeader = header.slice();
        const segmentView = new DataView(segmentHeader.buffer, segmentHeader.byteOffset, segmentHeader.byteLength);
        segmentView.setUint32(4, length + 36, true); segmentView.setUint32(40, length, true);
        const wav = new Blob([segmentHeader, part.bytes], { type: 'audio/wav' });
        const context = transcript.slice(-800);
        const timeout = setTimeout(() => activeAiController?.abort(), 240000);
        let result;
        try {
          result = await cloud.transcribeAudioSegment(wav, context, activeAiController.signal);
        } finally { clearTimeout(timeout); }
        if (typeof result.text === 'string' && result.text.trim()) {
          transcript = [transcript.trim(), result.text.trim()].filter(Boolean).join('\n');
          metadata[record.id] = { ...(metadata[record.id] || {}), transcript }; persist();
          upsert({ ...record, transcript });
          if (selectedId === record.id && elements.transcript) elements.transcript.value = transcript;
          renderList();
        }
        transcriptionProgress = Math.round(((index + 1) / total) * 100); renderControls();
      }
    } finally { activeAiController = null; }
    if (!transcript.trim()) throw Error('No speech was recognized. Your recording is still saved.');
    return transcript;
  }
  async function cancelTranscription(closeAfter = false) {
    if (!transcribingMode || transcriptionCancelling) return;
    clearTranscriptionPreview(); transcriptionCancelling = true; closeAfterTranscription = closeAfter; renderControls();
    try {
      if (transcribingMode === 'ai') activeAiController?.abort();
      else await command('cancel-transcription');
    }
    catch (error) { closeAfterTranscription = false; pendingNavigation = null; transcriptionCancelling = false; setError(error.message || 'Could not cancel transcription. Your recording is saved.'); renderControls(); }
  }
  function ask(title, description, actionText, action, allowBusy = false, onCancel = null) {
    elements.confirm.replaceChildren(el('h3', '', title), el('p', 'aa-muted', description));
    const actions = el('div', 'aa-note-actions'), cancel = button('Cancel', '', 'aa-secondary'), confirm = button(actionText, '', 'aa-primary');
    if (/^(delete|discard)\b/i.test(actionText)) confirm.classList.add('destructive-action');
    cancel.onclick = () => { elements.confirm.hidden = true; onCancel?.(); };
    confirm.onclick = () => { elements.confirm.hidden = true; void (allowBusy ? action() : run(action)); };
    actions.append(cancel, confirm); elements.confirm.append(actions); elements.confirm.hidden = false;
    requestAnimationFrame(() => { elements.confirm.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); confirm.focus(); });
  }
  async function stopRecording() {
    const result = await command('stop'); acceptState(result); if (!result?.status || ['saved', 'stopped', 'ready'].includes(result.status)) status = 'idle';
    const record = result?.recording || result?.saved || (result?.id ? result : active);
    if (record?.id) { upsert(record); selectedId = record.id; detailOpen = true; await publish(record); }
    active = null; lastElapsed = 0; renderAudio();
    elements.name.value = freshRecordingName();
    if (!record?.id) await refresh();
    announce('Audio saved. Choose Transcribe on device to create text.');
  }
  function leavePage() {
    if (!pageOpen) return;
    saveDraft(); clearPlayback(); elements.confirm.hidden = true; pageOpen = false; detailOpen = false;
    dialog.hidden = true; dialog.remove(); document.body.classList.remove('am-recording-open');
    window.NotejectMobile?.sync();
  }
  function finishPendingNavigation() {
    const next = pendingNavigation; pendingNavigation = null; leavePage();
    if (next) queueMicrotask(next);
  }
  function beforeNavigate(next) {
    if (!pageOpen) return false;
    saveDraft();
    if (transcribingMode) {
      pendingNavigation = next;
      ask('Cancel transcription and leave?', 'The original recording and any saved transcript are kept. You can transcribe again later.', 'Cancel transcription & leave', () => cancelTranscription(true), true, () => { pendingNavigation = null; });
      return true;
    }
    if (isActive()) {
      pendingNavigation = next;
      ask('Save your recording before leaving?', 'The microphone is still active. Stop and save to keep this audio.', 'Stop, save & leave', async () => { await stopRecording(); finishPendingNavigation(); }, false, () => { pendingNavigation = null; });
      return true;
    }
    if (busy) { setError('Please wait for the current audio action to finish.'); return true; }
    leavePage(); return false;
  }
  function closeDialog() {
    const home = () => typeof openWorkspaceView === 'function' && openWorkspaceView('home');
    if (!beforeNavigate(home)) home();
  }
  elements.search.oninput = () => { listTerm = elements.search.value.trim(); renderList(); };
  dialog.addEventListener('click', event => {
    const target = event.target.closest('[data-audio-action]'); if (!target || target.onclick) return;
    const action = target.dataset.audioAction;
    if (action === 'close') { closeDialog(); return; }
    if (action === 'detail-back') { saveDraft(); detailOpen = false; clearTranscriptionPreview(); renderAudio(); requestAnimationFrame(() => library.scrollIntoView({ block: 'start', behavior: 'smooth' })); return; }
    if (action === 'select') { saveDraft(); if (selectedId !== target.dataset.audioId) clearTranscriptionPreview(); selectedId = target.dataset.audioId; detailOpen = true; setError(''); renderAudio(); elements.detail.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (action === 'record') { void run(async () => {
      if (isActive()) throw Error('Stop the current recording first.');
      const folder = elements.project.value, name = elements.name.value.trim() || 'Voice note · ' + new Date().toLocaleString(globalThis.document?.documentElement?.lang || undefined);
      const result = await command('start', { name, folder, projectId: sharedData()?.folderProjects?.[folder] || '' });
      acceptState(result); status = result?.status || 'recording'; active = result?.recording || result; detailOpen = false; lastElapsed = 0; lastElapsedAt = performance.now();
      renderControls();
    }); return; }
    if (action === 'pause') { void run(async () => { const elapsed = lastElapsed + (status === 'recording' ? performance.now() - lastElapsedAt : 0), paused = status !== 'paused'; acceptState(await command(paused ? 'pause' : 'resume')); status = paused ? 'paused' : 'recording'; lastElapsed = elapsed; lastElapsedAt = performance.now(); }); return; }
    if (action === 'stop') { void run(stopRecording); return; }
    if (action === 'discard') { ask('Discard this recording?', 'This removes the audio you are recording now.', 'Discard recording', async () => { acceptState(await command('discard')); status = 'idle'; active = null; lastElapsed = 0; elements.name.value = freshRecordingName(); renderAudio(); }); return; }
    if (action === 'delete') { const record = currentRecord(); if (!record) return; ask('Delete this recording?', 'The original audio will be removed from Recordings and Documents. Your saved transcript note is kept.', 'Delete recording', async () => {
      await command('delete', { id: record.id });
      const docId = metadata[record.id]?.documentId;
      if (docId && sharedData()) { sharedData().docs = sharedData().docs.filter(doc => doc.id !== docId); for (const board of sharedData().boards || []) board.items = board.items.filter(item => item.id !== docId); if (typeof removeStoredFile === 'function') await removeStoredFile(docId); if (typeof save === 'function') save(); }
      delete metadata[record.id]; persist(); recordings = recordings.filter(item => item.id !== record.id); selectedId = null; detailOpen = false; renderAudio(); announce('Recording deleted; saved notes kept');
    }); }
  });
  async function open() {
    if (!pageOpen) previousFocus = document.activeElement;
    document.querySelector('.am-create-sheet[open]')?.close();
    document.querySelector('.am-drawer-close')?.click();
    if (typeof view !== 'undefined' && view !== 'recordings') { view = 'recordings'; if (typeof data !== 'undefined') data.selected = null; if (typeof render === 'function') render(); }
    const host = document.getElementById('android-audio-page') || document.getElementById('view') || document.body;
    if (dialog.parentElement !== host) host.append(dialog);
    pageOpen = true; detailOpen = false; dialog.hidden = false; document.body.classList.add('am-recording-open');
    scroll.scrollTop = 0; if (!elements.name.value.trim()) elements.name.value = freshRecordingName();
    fillProjects(elements.project, elements.project.value || 'Inbox');
    renderControls(); await refresh(); window.NotejectMobile?.sync();
  }
  function syncPage() {
    if (!pageOpen || typeof view === 'undefined' || view !== 'recordings') return;
    const host = document.getElementById('android-audio-page') || document.getElementById('view');
    if (host && dialog.parentElement !== host) { host.append(dialog); dialog.hidden = false; }
  }
  function attachEntries() {
    const sheet = document.querySelector('.am-create-sheet');
    if (sheet && !sheet.querySelector('[data-aa-open]')) {
      const option = button('', '', 'am-create-option'); option.dataset.aaOpen = 'true';
      const glyph = el('span', 'aa-entry-glyph', '●'), copy = el('span'); copy.append(el('strong', '', 'Record audio'), el('small', '', 'Capture speech and turn it into a note'));
      option.append(glyph, copy, el('b', '', '›')); sheet.append(option);
    }
    const nav = document.querySelector('.workspace-nav-scroll');
    if (nav && !nav.querySelector('[data-aa-open]')) { const entry = button('', '', 'nav-item'); entry.dataset.aaOpen = 'true'; entry.append(el('span', 'aa-entry-glyph', '●'), el('span', '', 'Record')); const notes = nav.querySelector('[data-view="notes"]'); if (notes) notes.after(entry); else nav.append(entry); }
  }
  document.addEventListener('click', event => { if (event.target.closest('[data-aa-open]')) { event.preventDefault(); event.stopPropagation(); void open(); } }, true);
  document.addEventListener('click', event => {
    if (!pageOpen) return;
    const target = event.target.closest('.sidebar [data-view], .sidebar [data-board], #open-settings, #brand-home');
    if (!target) return;
    const replay = () => target.click();
    if (beforeNavigate(replay)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  let entryScheduled = false;
  const observer = new MutationObserver(records => {
    if (entryScheduled || records.every(record => record.target.closest?.('#reader-pdf-pages,#reader-page-grid,.reader-statusbar,#pdf-page-total,[data-reader-command="zoom-reset"]'))) return;
    entryScheduled = true; requestAnimationFrame(() => { entryScheduled = false; attachEntries(); });
  });
  observer.observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
  function listen() {
    if (unsubscribe || !window.NotejectAndroidAudio?.subscribe) return;
    unsubscribe = window.NotejectAndroidAudio.subscribe(event => {
      if (transcribingMode && event?.id === transcribingId && Number.isFinite(Number(event.progress))) transcriptionProgress = Math.min(100, Math.max(0, Math.round(Number(event.progress))));
      if (transcribingMode === 'device' && !transcriptionCancelling && event?.id === transcribingId && event.state === 'transcribing' && event.partial === true && typeof event.text === 'string') {
        transcriptionPreview = { id: event.id, text: event.text }; renderTranscriptionPreview();
      }
      if (event?.error || ['error', 'transcription-error'].includes(event?.state)) { clearTranscriptionPreview(); setError(event.error || event.message || 'This audio action could not finish. Your saved recording is kept.'); }
      if (event?.requestId && !event.recording && !event.recordings && !event.status && !event.state && !event.text && !event.error) return;
      if (event?.type === 'transcript' && event.partial !== true && event.id && typeof event.text === 'string') { metadata[event.id] = { ...(metadata[event.id] || {}), transcript: event.text }; persist(); if (event.id === selectedId && elements.transcript) elements.transcript.value = event.text; }
      acceptState(event);
      const record = event?.recording;
      if (record?.id && !isActive() && Number(record.durationMs || record.duration) > 0) { upsert(record); selectedId ||= record.id; void publish(record).catch(error => setError(error.message)); }
      if (pageOpen) {
        renderControls();
        if (event.recordings || (record?.id && !isActive()) || event.type === 'transcript') {
          renderList(); if (!busy && !elements.detail.contains(document.activeElement)) renderDetail();
        }
      }
    });
  }
  window.NotejectAndroidAudioUI = Object.freeze({
    open,
    isOpen() { return pageOpen; },
    getPage() { return pageOpen ? dialog : null; },
    getModal() { return null; },
    sync: syncPage,
    beforeNavigate,
    leavePage,
    handleBack() {
      if (!pageOpen) return false;
      if (!elements.confirm.hidden) { elements.confirm.hidden = true; pendingNavigation = null; return true; }
      if (detailOpen) { detailOpen = false; clearTranscriptionPreview(); renderAudio(); requestAnimationFrame(() => library.scrollIntoView({ block: 'start', behavior: 'smooth' })); return true; }
      if (transcribingMode || isActive() || busy) { closeDialog(); return true; }
      leavePage(); return false;
    }
  });
  attachEntries(); listen();
  window.addEventListener('noteject:android-audio-ready', listen);
  window.addEventListener('pagehide', saveDraft);
  setInterval(() => { listen(); if (pageOpen) renderControls(); }, 500);
})();
