'use strict'

/**
 * Social Downloader — main process.
 *
 * The window loads local files and talks to this process over IPC; this
 * process runs yt-dlp directly. There is no local web server and no open port.
 */

const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { DownloadQueue } = require('./lib/queue')
const { readJson, writeJsonAtomic } = require('./lib/store')
const ytdlp = require('./lib/ytdlp')

const APP_NAME = 'Social Downloader'
const EXE = process.platform === 'win32' ? '.exe' : ''
const HISTORY_LIMIT = 300

app.setName(APP_NAME)
app.setPath('userData', path.join(app.getPath('appData'), 'mon-downloader'))
if (process.platform === 'win32') app.setAppUserModelId('local.mon-downloader')

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const USER_DATA = app.getPath('userData')
const BIN_DIR = path.join(USER_DATA, 'bin')
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json')
const HISTORY_FILE = path.join(USER_DATA, 'history.json')
// The previous app keeps its own yt-dlp and ffmpeg here; reused when present.
const LEGACY_BIN = path.join(app.getPath('appData'), 'social-downloader', 'bin')

let mainWindow = null
let settings = null
let queue = null
const tools = { ytdlp: null, ytdlpVersion: '', ffmpeg: null, ffmpegFound: false }

// ---------------------------------------------------------------- settings

function defaultSettings() {
  return {
    directory: path.join(app.getPath('downloads'), APP_NAME),
    quality: 'best',
    concurrency: 3,
    cookiesBrowser: '',
  }
}

/** Keeps only the fields that are valid; anything else is silently dropped. */
function sanitizeSettings(patch) {
  const clean = {}
  if (typeof patch?.directory === 'string' && path.isAbsolute(patch.directory)) clean.directory = patch.directory
  if (ytdlp.QUALITIES.includes(patch?.quality)) clean.quality = patch.quality
  if (Number.isInteger(patch?.concurrency) && patch.concurrency >= 1 && patch.concurrency <= 6) {
    clean.concurrency = patch.concurrency
  }
  if (ytdlp.COOKIE_BROWSERS.includes(patch?.cookiesBrowser)) clean.cookiesBrowser = patch.cookiesBrowser
  return clean
}

function updateSettings(patch) {
  Object.assign(settings, sanitizeSettings(patch))
  writeJsonAtomic(SETTINGS_FILE, settings)
  queue.setConcurrency(settings.concurrency)
  return settings
}

// ---------------------------------------------------------------- tools

async function ensureYtdlp() {
  const target = path.join(BIN_DIR, `yt-dlp${EXE}`)
  if (fs.existsSync(target)) return target
  fs.mkdirSync(BIN_DIR, { recursive: true })
  const legacy = path.join(LEGACY_BIN, `yt-dlp${EXE}`)
  if (fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, target)
    return target
  }
  const asset = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform]
  if (!asset) throw new Error('Plateforme non prise en charge.')
  const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`)
  if (!response.ok) throw new Error(`Téléchargement de yt-dlp impossible (${response.status}).`)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
  if (!EXE) fs.chmodSync(temporary, 0o755)
  fs.renameSync(temporary, target)
  return target
}

/** null when ffmpeg is on PATH (yt-dlp finds it alone), else an explicit path. */
function locateFfmpeg() {
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { windowsHide: true })
  if (lookup.status === 0) return { found: true, path: null }
  const legacy = path.join(LEGACY_BIN, `ffmpeg${EXE}`)
  if (fs.existsSync(legacy)) return { found: true, path: legacy }
  return { found: false, path: null }
}

function runYtdlp(args) {
  return new Promise((resolve) => {
    const child = spawn(tools.ytdlp, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out.trim()))
  })
}

async function prepareTools() {
  tools.ytdlp = await ensureYtdlp()
  const ffmpeg = locateFfmpeg()
  tools.ffmpeg = ffmpeg.path
  tools.ffmpegFound = ffmpeg.found
  tools.ytdlpVersion = await runYtdlp(['--version'])
  // Sites break old yt-dlp builds every few weeks: update in the background.
  runYtdlp(['-U']).then(async () => {
    tools.ytdlpVersion = await runYtdlp(['--version'])
    mainWindow?.webContents.send('tools', publicTools())
  })
}

function publicTools() {
  return { ytdlpVersion: tools.ytdlpVersion, ffmpegFound: tools.ffmpegFound }
}

function toolEnv() {
  return { ffmpeg: tools.ffmpeg, cookiesBrowser: settings.cookiesBrowser }
}

// ---------------------------------------------------------------- queue

let sendTimer = null
let saveTimer = null
let wasBusy = false

function saveHistory() {
  writeJsonAtomic(HISTORY_FILE, queue.items.slice(0, HISTORY_LIMIT))
}

function onQueueChange() {
  // Progress lines arrive many times a second; the window needs far fewer.
  sendTimer ??= setTimeout(() => {
    sendTimer = null
    mainWindow?.webContents.send('items', queue.items)
  }, 120)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    saveHistory()
  }, 1000)

  const busy = queue.busy
  if (wasBusy && !busy && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
    new Notification({ title: APP_NAME, body: 'Téléchargements terminés.' }).show()
  }
  wasBusy = busy
  mainWindow?.setProgressBar(busy ? overallProgress() : -1)
}

function overallProgress() {
  const running = queue.items.filter((item) => item.status === 'running')
  if (!running.length) return 2 // indeterminate
  return running.reduce((sum, item) => sum + item.progress, 0) / running.length
}

function startDownload(item, update) {
  fs.mkdirSync(settings.directory, { recursive: true })
  return ytdlp.download(
    tools.ytdlp,
    { url: item.url, mode: item.mode, quality: item.quality, directory: settings.directory },
    toolEnv(),
    update,
  )
}

function enqueue(jobs) {
  if (!Array.isArray(jobs)) return
  for (const job of jobs.slice(0, 500)) {
    if (!ytdlp.isHttpUrl(job?.url)) continue
    queue.add({
      url: job.url,
      title: typeof job.title === 'string' ? job.title.slice(0, 300) : '',
      thumbnail: ytdlp.isHttpUrl(job.thumbnail) ? job.thumbnail : '',
      mode: job.mode === 'audio' ? 'audio' : 'video',
      quality: ytdlp.QUALITIES.includes(job.quality) ? job.quality : settings.quality,
    })
  }
}

// ---------------------------------------------------------------- ipc

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de téléchargement',
    defaultPath: settings.directory,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return settings
  fs.accessSync(result.filePaths[0], fs.constants.W_OK)
  return updateSettings({ directory: result.filePaths[0] })
}

/** Only well-formed entries survive: the file may come from anywhere. */
function validHistory(data) {
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item.id === 'string' && ytdlp.isHttpUrl(item.url))
    .map((item) => ({
      id: item.id,
      url: item.url,
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : '',
      thumbnail: ytdlp.isHttpUrl(item.thumbnail) ? item.thumbnail : '',
      mode: item.mode === 'audio' ? 'audio' : 'video',
      quality: ytdlp.QUALITIES.includes(item.quality) ? item.quality : 'best',
      status: typeof item.status === 'string' ? item.status : 'interrupted',
      progress: item.status === 'done' ? 1 : 0,
      speed: null,
      eta: null,
      total: Number.isFinite(item.total) ? item.total : null,
      part: 1,
      file: typeof item.file === 'string' && path.isAbsolute(item.file) ? item.file : null,
      error: typeof item.error === 'string' ? item.error.slice(0, 500) : null,
      addedAt: Number.isFinite(item.addedAt) ? item.addedAt : Date.now(),
    }))
}

async function exportHistory() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter l’historique',
    defaultPath: path.join(app.getPath('documents'), 'historique-social-downloader.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return null
  fs.writeFileSync(result.filePath, JSON.stringify(queue.items, null, 2), 'utf8')
  return result.filePath
}

async function importHistory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer un historique',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  let data
  try {
    data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'))
  } catch {
    throw new Error('Ce fichier n’est pas un historique lisible.')
  }
  return queue.merge(validHistory(data))
}

function finishedFile(id) {
  const item = queue.find(id)
  return item?.status === 'done' && item.file && fs.existsSync(item.file) ? item.file : null
}

function setupIpc() {
  const handle = (channel, callback) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('Requête refusée.')
      }
      return callback(...args)
    })

  handle('state', () => ({ settings, items: queue.items, tools: publicTools() }))
  handle('probe', (url) => {
    if (!ytdlp.isHttpUrl(url)) throw new Error('Lien invalide.')
    return ytdlp.probe(tools.ytdlp, url, toolEnv())
  })
  handle('enqueue', enqueue)
  handle('item:cancel', (id) => queue.cancel(id))
  handle('item:retry', (id) => queue.retry(id))
  handle('item:remove', (id) => queue.remove(id))
  handle('item:open', (id) => {
    const file = finishedFile(id)
    return file ? shell.openPath(file) : 'Fichier introuvable.'
  })
  handle('item:reveal', (id) => {
    const file = finishedFile(id)
    if (file) shell.showItemInFolder(file)
    else shell.openPath(settings.directory)
  })
  handle('items:clear', () => queue.clearFinished())
  handle('history:export', exportHistory)
  handle('history:import', importHistory)
  handle('settings:set', updateSettings)
  handle('settings:choose-directory', chooseDirectory)
  handle('directory:open', () => {
    fs.mkdirSync(settings.directory, { recursive: true })
    return shell.openPath(settings.directory)
  })
  handle('clipboard:urls', () => ytdlp.extractUrls(clipboard.readText()))
}

// ---------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: '#111214',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  // The window only ever shows the local interface; links open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (ytdlp.isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.on('closed', () => (mainWindow = null))
  return mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'))
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Fichier',
      submenu: [
        { label: 'Ouvrir le dossier des téléchargements', click: () => shell.openPath(settings.directory) },
        { label: 'Ouvrir le dossier des réglages', click: () => shell.openPath(USER_DATA) },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    { label: 'Édition', role: 'editMenu' },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
  ]))
}

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('before-quit', () => {
  if (!queue) return
  // Stop the yt-dlp processes; what they were doing can be resumed next launch.
  for (const item of queue.items) {
    if (item.status !== 'queued' && item.status !== 'running') continue
    queue.cancel(item.id)
    item.status = 'interrupted'
  }
  saveHistory()
})

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  try {
    settings = { ...defaultSettings(), ...sanitizeSettings(readJson(SETTINGS_FILE, {})) }
    queue = new DownloadQueue({ concurrency: settings.concurrency, start: startDownload, onChange: onQueueChange })
    queue.load(validHistory(readJson(HISTORY_FILE, [])))
    await prepareTools()
    setupIpc()
    buildMenu()
    await createWindow()
  } catch (error) {
    dialog.showErrorBox(APP_NAME, `Impossible de démarrer : ${error?.message || error}`)
    app.quit()
  }
})
