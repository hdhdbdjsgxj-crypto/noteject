'use strict';

const { app, BrowserWindow, dialog, shell, Menu, ipcMain, screen, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const nativeLocalization = require('./localization.cjs');
const isMac = process.platform === 'darwin';

const appDataRoot = path.join(app.getPath('appData'), 'Noteject');
app.setPath('userData', appDataRoot);

const startedServices = [];
let mainWindow;
let quitting = false;
let rendererReady = false;
let rendererOrigin = '';
let currentProjectsRoot = '';
let choosingDirectory = false;
let nativeLanguage = 'en';
const nativeText = source => nativeLocalization.text(source, nativeLanguage);
const pendingCommands = [];
const commands = new Set([
  'new-note', 'new-project', 'new-board', 'import', 'export-backup', 'load-backup',
  'settings', 'home', 'notes', 'library', 'projects', 'boards', 'graph', 'search',
  'save-note', 'undo', 'redo', 'select-all', 'find-reader', 'bookmark-reader', 'focus-reader',
  'reader-zoom-in', 'reader-zoom-out', 'fit-board', 'board-zoom-in', 'board-zoom-out',
  'toggle-sidebar', 'command-palette', 'help-shortcuts'
]);

function trustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === rendererOrigin; }
  catch { return false; }
}

function sendCommand(command) {
  if (!commands.has(command) || !mainWindow || mainWindow.isDestroyed()) return;
  if (!rendererReady) {
    if (pendingCommands.length < 32) pendingCommands.push(command);
    return;
  }
  mainWindow.webContents.send('noteject:command', { command });
}

function installDesktopBridge() {
  ipcMain.on('noteject:set-language', (event, language) => {
    if (!trustedRenderer(event) || typeof language !== 'string' || !/^[a-z]{2}$/.test(language)) return;
    const next = nativeLocalization.resolveLanguage(language);
    if (next === nativeLanguage) return;
    nativeLanguage = next;
    installApplicationMenu();
    void fs.mkdir(appDataRoot, { recursive:true }).then(() => fs.writeFile(path.join(appDataRoot, 'ui-language.json'), JSON.stringify({language:next}))).catch(() => {});
  });
  ipcMain.on('noteject:command-ready', (event, ready) => {
    if (!trustedRenderer(event) || typeof ready !== 'boolean') return;
    rendererReady = ready;
    if (!ready) return;
    for (const command of pendingCommands.splice(0)) sendCommand(command);
  });
  ipcMain.handle('noteject:choose-directory', async event => {
    if (!trustedRenderer(event)) throw new Error('The folder picker is available only to the noteject workspace.');
    if (choosingDirectory) return null;
    const owner = mainWindow;
    choosingDirectory = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: nativeText('Choose project attachments location'),
        defaultPath: currentProjectsRoot || app.getPath('documents'),
        buttonLabel: nativeText('Choose folder'),
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
      });
      if (!trustedRenderer(event) || owner.isDestroyed() || owner !== mainWindow || result.canceled) return null;
      const selected = result.filePaths[0];
      if (typeof selected !== 'string' || !path.isAbsolute(selected)) return null;
      return selected;
    } finally {
      choosingDirectory = false;
    }
  });
}

async function readWindowState() {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'window-state.json'), 'utf8')); }
  catch {}
  if (!saved || typeof saved !== 'object') saved = {};
  const valid = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 100000;
  const hasBounds = ['x', 'y', 'width', 'height'].every(key => valid(saved[key])) && saved.width > 0 && saved.height > 0;
  const display = hasBounds ? screen.getDisplayMatching({ x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) }) : screen.getPrimaryDisplay();
  const work = display.workArea;
  const minWidth = Math.min(960, work.width);
  const minHeight = Math.min(640, work.height);
  const width = Math.min(work.width, Math.max(minWidth, hasBounds ? Math.round(saved.width) : 1480));
  const height = Math.min(work.height, Math.max(minHeight, hasBounds ? Math.round(saved.height) : 940));
  const x = hasBounds ? Math.max(work.x, Math.min(Math.round(saved.x), work.x + work.width - width)) : work.x + Math.round((work.width - width) / 2);
  const y = hasBounds ? Math.max(work.y, Math.min(Math.round(saved.y), work.y + work.height - height)) : work.y + Math.round((work.height - height) / 2);
  return { x, y, width, height, minWidth, minHeight, maximized: saved.maximized === true };
}

function trackWindowState(window, initiallyMaximized) {
  let maximized = initiallyMaximized;
  let timer;
  function save() {
    clearTimeout(timer);
    if (window.isDestroyed() || window.isFullScreen()) return;
    try {
      const state = { ...window.getNormalBounds(), maximized };
      const destination = path.join(app.getPath('userData'), 'window-state.json');
      fsSync.mkdirSync(path.dirname(destination), { recursive: true });
      fsSync.writeFileSync(destination + '.tmp', JSON.stringify(state), 'utf8');
      fsSync.renameSync(destination + '.tmp', destination);
    } catch {}
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('maximize', () => { maximized = true; schedule(); });
  window.on('unmaximize', () => { maximized = false; schedule(); });
  window.on('close', save);
  window.on('closed', () => clearTimeout(timer));
}

function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
}

function storageConfigPath() {
  return path.join(app.getPath('userData'), '.noteject-storage.json');
}

async function copyLegacyProjectStorage(source, destination) {
  const rootStat = await fs.lstat(source);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The previous project attachment location is not a regular folder.');

  async function copyDirectory(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const info = await fs.lstat(fromPath);
      if (info.isSymbolicLink()) throw new Error('The previous project attachments contain a shortcut or symbolic link.');
      if (info.isDirectory()) await copyDirectory(fromPath, toPath);
      else if (info.isFile()) await fs.copyFile(fromPath, toPath);
      else throw new Error(`Unsupported item in the previous project attachments: ${entry.name}`);
    }
  }

  await copyDirectory(source, destination);
}

async function readOrCreateProjectsRoot() {
  const config = storageConfigPath();
  try {
    const saved = JSON.parse(await fs.readFile(config, 'utf8'));
    if (typeof saved.projectsRoot === 'string' && path.isAbsolute(saved.projectsRoot)) {
      await fs.mkdir(saved.projectsRoot, { recursive: true });
      return saved.projectsRoot;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const projectsRoot = path.join(app.getPath('userData'), 'projects');
  await fs.mkdir(path.dirname(projectsRoot), { recursive: true });
  const migrationStage = projectsRoot + '.migration';
  let projectsExist = true;
  try { await fs.lstat(projectsRoot); }
  catch (error) { if (error.code === 'ENOENT') projectsExist = false; else throw error; }
  if (!projectsExist && app.isPackaged) {
    try {
      const locationConfig = JSON.parse(await fs.readFile(path.join(process.resourcesPath, 'legacy-projects-location.json'), 'utf8'));
      let legacyProjectsRoot = typeof locationConfig.legacyProjectsRoot === 'string' ? locationConfig.legacyProjectsRoot : '';
      if (legacyProjectsRoot.toLocaleUpperCase().startsWith('%USERPROFILE%')) {
        legacyProjectsRoot = path.join(process.env.USERPROFILE || app.getPath('home'), legacyProjectsRoot.slice('%USERPROFILE%'.length).replace(/^[\\/]+/, ''));
      }
      if (path.isAbsolute(legacyProjectsRoot)) {
        const legacyItems = await fs.readdir(legacyProjectsRoot);
        if (legacyItems.length) {
          await fs.rm(migrationStage, { recursive: true, force: true });
          try {
            await copyLegacyProjectStorage(legacyProjectsRoot, migrationStage);
            await fs.rename(migrationStage, projectsRoot);
          } catch (error) {
            await fs.rm(migrationStage, { recursive: true, force: true });
            throw error;
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!projectsExist) await fs.mkdir(projectsRoot, { recursive: true });
  await fs.writeFile(config, JSON.stringify({ projectsRoot }, null, 2), { encoding: 'utf8', flag: 'w' });
  return projectsRoot;
}

function reservePorts(count, preferredAppPort = 0) {
  return new Promise((resolve, reject) => {
    const reservations = [];
    const ports = [];
    const reserveNext = () => {
      if (ports.length === count) {
        Promise.all(reservations.map(server => new Promise((done, fail) => server.close(error => error ? fail(error) : done()))))
          .then(() => resolve(ports)).catch(reject);
        return;
      }
      const server = net.createServer();
      server.once('error', error => {
        for (const reserved of reservations) reserved.close();
        if (preferredAppPort && error.code === 'EADDRINUSE') reject(new Error(`noteject's workspace port ${preferredAppPort} is in use. Close the other application using this port, then reopen noteject. The workspace address was kept to protect access to your saved notes.`));
        else reject(error);
      });
      server.listen(ports.length === 0 ? preferredAppPort : 0, '127.0.0.1', () => {
        reservations.push(server);
        ports.push(server.address().port);
        reserveNext();
      });
    };
    reserveNext();
  });
}

async function reserveDesktopPorts() {
  const config = path.join(app.getPath('userData'), 'desktop-service.json');
  let savedPort = 0;
  try {
    const settings = JSON.parse(await fs.readFile(config, 'utf8'));
    if (!Number.isInteger(settings.appPort) || settings.appPort < 1024 || settings.appPort > 65535) throw new Error('The saved desktop workspace address is invalid. Restore desktop-service.json from a backup before restarting.');
    savedPort = settings.appPort;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ports = await reservePorts(2, savedPort);
  if (!savedPort) {
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config + '.tmp', JSON.stringify({ appPort: ports[0] }), 'utf8');
    await fs.rename(config + '.tmp', config);
  }
  return ports;
}

function startNodeService(scriptPath, port, appPort, projectsRoot, configPath) {
  const options = {
    cwd: appRoot(),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      NOTEJECT_PORT: String(port),
      NOTEJECT_APP_PORT: String(appPort),
      NOTEJECT_PROJECTS_DIR: projectsRoot,
      NOTEJECT_STORAGE_CONFIG: configPath
    }
  };
  let child;
  if (isMac) {
    child = utilityProcess.fork(scriptPath, [], { ...options, serviceName: 'Noteject workspace' });
  } else {
    const nodePath = app.isPackaged
      ? path.join(process.resourcesPath, 'runtime', 'node.exe')
      : path.join(appRoot(), 'dist', 'runtime', 'node.exe');
    const nodeCommand = app.isPackaged || fsSync.existsSync(nodePath) ? nodePath : 'node';
    child = spawn(nodeCommand, [scriptPath], { ...options, windowsHide: true });
  }
  let diagnostic = '';
  const service = { child, exited: false, getDiagnostic: () => diagnostic };
  const appendDiagnostic = data => { diagnostic = (diagnostic + String(data)).slice(-10000); };
  child.stderr?.on('data', appendDiagnostic);
  child.once('error', error => {
    appendDiagnostic(error);
    service.exited = true;
  });
  child.once('exit', () => { service.exited = true; });
  startedServices.push(service);
  return service;
}

async function waitForService(url, service, label) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (service.exited) {
      throw new Error(`${label} stopped during startup.${service.getDiagnostic() ? `\n${service.getDiagnostic()}` : ''}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(700) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'startup timed out'}.${service.getDiagnostic() ? `\n${service.getDiagnostic()}` : ''}`);
}

function installApplicationMenu() {
  const shortcut = value => isMac ? value.replace(/^Ctrl\+/, 'Command+') : value;
  const action = (label, command, accelerator) => ({
    label, ...(accelerator ? { accelerator: shortcut(accelerator) } : {}), click: () => sendCommand(command)
  });
  const template = [
    { label: '&File', submenu: [
      action('New &note', 'new-note', 'Ctrl+N'),
      action('New &project…', 'new-project', 'Ctrl+Shift+N'),
      action('New &board…', 'new-board', 'Ctrl+Alt+N'),
      { type: 'separator' },
      action('&Import files…', 'import', 'Ctrl+O'),
      action('&Save note', 'save-note', 'Ctrl+S'),
      { type: 'separator' },
      action('&Export workspace backup…', 'export-backup'),
      action('&Load backup…', 'load-backup'),
      { type: 'separator' },
      action('Se&ttings…', 'settings', 'Ctrl+,'),
      { type: 'separator' },
      { role: 'quit', label: isMac ? 'Quit noteject' : 'E&xit noteject', accelerator: isMac ? 'Command+Q' : 'Alt+F4' }
    ] },
    { label: '&Edit', submenu: [
      action('&Undo', 'undo', 'Ctrl+Z'), action('&Redo', 'redo', 'Ctrl+Shift+Z'),
      { type: 'separator' },
      { role: 'cut', label: 'Cu&t' }, { role: 'copy', label: '&Copy' },
      { role: 'paste', label: '&Paste' }, action('Select &all', 'select-all', 'Ctrl+A'),
      { type: 'separator' },
      action('&Search workspace…', 'search', 'Ctrl+K'),
      action('Command &palette…', 'command-palette', 'Ctrl+Shift+P')
    ] },
    { label: '&View', submenu: [
      action('Toggle &navigation pane', 'toggle-sidebar', 'Ctrl+Alt+B'),
      { type: 'separator' },
      { role: 'resetZoom', label: '&Actual interface size', accelerator: shortcut('Ctrl+Alt+0') },
      { role: 'zoomIn', label: 'Larger &interface', accelerator: shortcut('Ctrl+Alt+=') },
      { role: 'zoomOut', label: 'Smaller i&nterface', accelerator: shortcut('Ctrl+Alt+-') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '&Full screen', accelerator: isMac ? 'Control+Command+F' : 'F11' },
      { role: 'reload', label: '&Reload workspace', accelerator: shortcut('Ctrl+R') }
    ] },
    { label: '&Go', submenu: [
      action('&Home', 'home', 'Alt+1'), action('All &notes', 'notes', 'Alt+2'),
      action('&Documents', 'library', 'Alt+3'), action('&Projects', 'projects', 'Alt+4'),
      action('&Boards', 'boards', 'Alt+5'), action('&Graph view', 'graph', 'Alt+6')
    ] },
    { label: '&Board', submenu: [
      action('New &board…', 'new-board'), { type: 'separator' },
      action('&Fit board to window', 'fit-board'),
      action('Zoom &in on board', 'board-zoom-in'),
      action('Zoom &out on board', 'board-zoom-out')
    ] },
    { label: '&Reader', submenu: [
      action('&Find in document…', 'find-reader', 'Ctrl+F'),
      action('&Bookmark current place', 'bookmark-reader'),
      action('&Focus reading', 'focus-reader'),
      { type: 'separator' },
      action('&Increase document size', 'reader-zoom-in'),
      action('&Decrease document size', 'reader-zoom-out')
    ] },
    { label: '&Help', submenu: [
      action('&Keyboard shortcuts', 'help-shortcuts', 'F1'),
      { type: 'separator' },
      { label: '&About noteject', click: () => {
        const options = { type: 'info', title: nativeText('About noteject'), message: nativeText(isMac ? 'noteject for macOS' : 'noteject for Windows'), detail: `${nativeText('Version')} ${app.getVersion()}\n${nativeText('Notes, projects, boards, and reading in your local workspace.')}` };
        if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options);
        else void dialog.showMessageBox(options);
      } }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(nativeLocalization.menu(template, nativeLanguage)));
}

async function openExternalUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLocalAddress = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::';
    if ((['https:', 'http:'].includes(url.protocol) && !isLocalAddress && !url.username && !url.password) || ['mailto:', 'tel:'].includes(url.protocol)) {
      await shell.openExternal(url.href);
    }
  } catch {}
}

async function createMainWindow(appUrl, filePort) {
  const state = await readWindowState();
  rendererOrigin = new URL(appUrl).origin;
  rendererReady = false;
  const window = new BrowserWindow({
    title: 'noteject',
    icon: path.join(appRoot(), 'noteject-logo.png'),
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: state.minWidth,
    minHeight: state.minHeight,
    show: false,
    frame: true,
    titleBarStyle: 'default',
    thickFrame: true,
    autoHideMenuBar: false,
    backgroundColor: '#17181c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      additionalArguments: [`--noteject-version=${encodeURIComponent(app.getVersion())}`]
    }
  });

  const expectedOrigin = rendererOrigin;
  trackWindowState(window, state.maximized);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    let destination;
    try { destination = new URL(url); } catch { event.preventDefault(); return; }
    if (destination.origin !== expectedOrigin) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  });
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  window.webContents.on('render-process-gone', () => { rendererReady = false; });
  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    if (!window.isDestroyed()) window.setTitle('noteject');
  });
  window.once('ready-to-show', () => {
    if (state.maximized) window.maximize();
    window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    rendererReady = false;
    pendingCommands.length = 0;
  });
  void window.loadURL(`${appUrl}?desktopFilePort=${filePort}`);
  return window;
}

async function startDesktopApp() {
  nativeLanguage = nativeLocalization.resolveLanguage(app.getLocale());
  try { const saved = JSON.parse(await fs.readFile(path.join(appDataRoot, 'ui-language.json'), 'utf8')); if (nativeLocalization.supportedLanguages.includes(saved.language)) nativeLanguage = saved.language; } catch {}
  const root = appRoot();
  const scriptPath = path.join(root, 'ai-server.mjs');
  await fs.access(scriptPath);
  const projectsRoot = await readOrCreateProjectsRoot();
  currentProjectsRoot = projectsRoot;
  const configPath = storageConfigPath();
  const [appPort, filePort] = await reserveDesktopPorts();
  const appService = startNodeService(scriptPath, appPort, appPort, projectsRoot, configPath);
  const fileService = startNodeService(scriptPath, filePort, appPort, projectsRoot, configPath);
  await Promise.all([
    waitForService(`http://127.0.0.1:${appPort}/api/key-status`, appService, 'Noteject app service'),
    waitForService(`http://127.0.0.1:${filePort}/api/file-status`, fileService, 'Noteject project-file service')
  ]);

  installDesktopBridge();
  installApplicationMenu();
  mainWindow = await createMainWindow(`http://127.0.0.1:${appPort}/`, filePort);
}

function stopServices() {
  for (const service of startedServices.splice(0)) {
    if (!service.exited) service.child.kill();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId('com.noteject.desktop');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktopApp).catch(async error => {
    await dialog.showMessageBox({ type: 'error', title: nativeText('Could not start Noteject'), message: nativeText('Noteject could not start its local desktop services.'), detail: error.message || String(error) });
    app.quit();
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    stopServices();
  });
  app.on('window-all-closed', () => app.quit());
}
