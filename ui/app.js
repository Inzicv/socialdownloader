'use strict'

// `api` is the global exposed by preload.js.

const $ = (id) => document.getElementById(id)
const SVG_NS = 'http://www.w3.org/2000/svg'
const PENDING = new Set(['queued', 'running'])

let settings = null
let mode = 'video'
let view = 'download'
let lastClipboard = ''
const rows = new Map()

// ---------------------------------------------------------------- helpers

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  svg.setAttribute('aria-hidden', 'true')
  return svg
}

function extractUrls(text) {
  const found = (String(text).match(/\S+/g) ?? []).filter((part) => /^https?:\/\//i.test(part))
  return [...new Set(found)]
}

function plural(count, word) {
  return `${count} ${word}${count > 1 ? 's' : ''}`
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function formatBytes(bytes) {
  if (!bytes) return ''
  const units = ['o', 'Ko', 'Mo', 'Go']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(seconds) {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function subtitle(item) {
  const site = domain(item.url)
  switch (item.status) {
    case 'queued': return 'En attente'
    case 'running': {
      if (item.progress >= 1) return 'Finalisation…'
      const parts = [`${Math.round(item.progress * 100)} %`]
      if (item.total) parts.push(formatBytes(item.total))
      if (item.speed) parts.push(`${formatBytes(item.speed)}/s`)
      if (item.eta != null) parts.push(`reste ${formatDuration(item.eta)}`)
      return parts.join(' · ')
    }
    case 'done': return `${site}${item.mode === 'audio' ? ' · MP3' : ''}`
    case 'error': return item.error || 'Échec du téléchargement'
    case 'canceled': return 'Annulé · cliquez pour réessayer'
    case 'interrupted': return 'Interrompu · cliquez pour reprendre'
    default: return site
  }
}

function notify(message, kind = 'error') {
  const notice = $('notice')
  notice.textContent = message
  notice.classList.toggle('is-info', kind === 'info')
  notice.hidden = !message
}

function cleanError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function jobFor(url, extra = {}) {
  return { url, mode, quality: settings.quality, ...extra }
}

// ---------------------------------------------------------------- single link

async function downloadLink() {
  const urls = extractUrls($('link').value)
  if (!urls.length) return notify('Collez un lien qui commence par http:// ou https://.')
  notify('')

  // Several links at once go straight to the queue; titles arrive as they start.
  if (urls.length > 1) {
    await api.enqueue(urls.map((url) => jobFor(url)))
    $('link').value = ''
    return notify(`${plural(urls.length, 'lien')} ajoutés à la file.`, 'info')
  }

  const button = $('download')
  button.disabled = true
  button.textContent = 'Analyse…'
  try {
    const info = await api.probe(urls[0])
    const jobs = info.kind === 'playlist'
      ? info.entries.map((entry) => jobFor(entry.url, { title: entry.title }))
      : [jobFor(info.url, { title: info.title, thumbnail: info.thumbnail })]
    if (!jobs.length) throw new Error('Aucun média trouvé à cette adresse.')
    await api.enqueue(jobs)
    $('link').value = ''
    if (info.kind === 'playlist') notify(`« ${info.title} » : ${plural(jobs.length, 'élément')} ajoutés à la file.`, 'info')
  } catch (error) {
    notify(cleanError(error))
  } finally {
    button.disabled = false
    button.textContent = 'Télécharger'
  }
}

// ---------------------------------------------------------------- batch

function batchUrls() {
  return extractUrls($('batch-links').value)
}

function updateBatchCount() {
  $('batch-count').textContent = plural(batchUrls().length, 'lien')
}

function appendToBatch(urls) {
  const field = $('batch-links')
  const merged = [...new Set([...batchUrls(), ...urls])]
  field.value = merged.join('\n')
  updateBatchCount()
}

async function importCollection() {
  const [url] = extractUrls($('collection').value)
  if (!url) return notify('Collez le lien d’une playlist, d’une collection ou d’une chaîne.')
  notify('')
  const button = $('collection-import')
  button.disabled = true
  button.textContent = 'Importation…'
  try {
    const info = await api.probe(url)
    const urls = info.kind === 'playlist' ? info.entries.map((entry) => entry.url) : [info.url]
    appendToBatch(urls)
    $('collection').value = ''
    notify(`${plural(urls.length, 'lien')} importés.`, 'info')
  } catch (error) {
    notify(cleanError(error))
  } finally {
    button.disabled = false
    button.textContent = 'Importer'
  }
}

async function startBatch() {
  const urls = batchUrls()
  if (!urls.length) return notify('Collez au moins un lien, un par ligne.')
  await api.enqueue(urls.map((url) => jobFor(url)))
  $('batch-links').value = ''
  updateBatchCount()
  notify(`${plural(urls.length, 'lien')} ajoutés à la file.`, 'info')
  $('workspace-history').scrollIntoView({ block: 'start' })
}

// ---------------------------------------------------------------- navigation

function showView(next) {
  view = next
  $('view-download').hidden = view !== 'download'
  $('view-batch').hidden = view !== 'batch'
  $('panel-title').textContent = view === 'batch' ? 'Téléchargement par lot' : 'Nouveau téléchargement'
  $('panel-subtitle').textContent = view === 'batch'
    ? 'Collez plusieurs liens ou importez une playlist entière.'
    : 'Collez le lien public du média que vous souhaitez enregistrer.'
}

function navigate(target) {
  if (target === 'settings') return $('settings').showModal()
  for (const link of document.querySelectorAll('.workspace-sidebar nav a')) {
    link.classList.toggle('is-active', link.dataset.nav === target)
  }
  if (target === 'history') return $('workspace-history').scrollIntoView({ block: 'start' })
  showView(target)
  $('workspace-download').scrollIntoView({ block: 'start' })
  $(target === 'batch' ? 'batch-links' : 'link').focus({ preventScroll: true })
}

// ---------------------------------------------------------------- options

function renderOptions() {
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  const standard = settings.quality !== 'best'
  for (const button of document.querySelectorAll('[data-quality]')) {
    button.setAttribute('aria-pressed', String((button.dataset.quality !== 'best') === standard))
  }
  $('quality-badge').textContent = mode === 'audio' ? 'MP3' : standard ? 'SD' : 'HD'
  $('directory').textContent = settings.directory
  $('directory').title = settings.directory
  $('concurrency').value = String(settings.concurrency)
  $('cookies').value = settings.cookiesBrowser
}

async function saveSetting(patch) {
  settings = await api.setSettings(patch)
  renderOptions()
}

function renderTools(tools) {
  $('tools').textContent = `yt-dlp ${tools.ytdlpVersion || 'inconnu'} · ffmpeg ${tools.ffmpegFound ? 'détecté' : 'introuvable'}`
  if (!tools.ffmpegFound) {
    notify('ffmpeg est introuvable : la haute qualité et le MP3 ne fonctionneront pas. Installez-le puis relancez l’application.')
  }
}

// ---------------------------------------------------------------- history

function actionButton(name, action, label, className = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.action = action
  button.title = label
  button.setAttribute('aria-label', label)
  button.className = className
  button.append(icon(name))
  return button
}

function createRow(item) {
  const row = document.createElement('li')
  row.className = 'item'
  row.dataset.id = item.id

  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'item-main'
  main.dataset.action = 'main'

  const thumb = document.createElement('span')
  thumb.className = 'item-thumb'
  if (item.thumbnail) {
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    image.addEventListener('error', () => thumb.replaceChildren(icon('link')))
    image.src = item.thumbnail
    thumb.append(image)
  } else {
    thumb.append(icon('link'))
  }

  const text = document.createElement('span')
  text.className = 'item-text'
  const title = document.createElement('div')
  title.className = 'item-title'
  const sub = document.createElement('div')
  sub.className = 'item-sub'
  text.append(title, sub)
  main.append(thumb, text)

  const actions = document.createElement('div')
  actions.className = 'item-actions'
  const bar = document.createElement('span')
  bar.className = 'item-bar'

  row.append(main, actions, bar)
  return { row, main, title, sub, actions, bar, shown: '' }
}

function updateRow(rowView, item) {
  rowView.row.dataset.status = item.status
  rowView.title.textContent = item.title || item.url
  rowView.sub.textContent = subtitle(item)
  rowView.bar.hidden = item.status !== 'running'
  rowView.bar.style.width = `${Math.round(item.progress * 100)}%`
  if (rowView.shown === item.status) return
  rowView.shown = item.status
  rowView.main.title = item.status === 'done' ? 'Ouvrir le fichier' : item.title || item.url
  const pending = PENDING.has(item.status)
  const first = item.status === 'done'
    ? [actionButton('check', 'reveal', 'Afficher dans le dossier', 'is-done')]
    : pending ? [] : [actionButton('retry', 'retry', 'Réessayer')]
  rowView.actions.replaceChildren(
    ...first,
    pending ? actionButton('close', 'cancel', 'Annuler') : actionButton('close', 'remove', 'Retirer de l’historique'),
  )
}

function renderItems(items) {
  const list = $('items')
  const seen = new Set()
  items.forEach((item, index) => {
    seen.add(item.id)
    let rowView = rows.get(item.id)
    if (!rowView) {
      rowView = createRow(item)
      rows.set(item.id, rowView)
    }
    updateRow(rowView, item)
    if (list.children[index] !== rowView.row) list.insertBefore(rowView.row, list.children[index] ?? null)
  })
  for (const [id, rowView] of rows) {
    if (seen.has(id)) continue
    rowView.row.remove()
    rows.delete(id)
  }
  const saved = items.filter((item) => item.status === 'done').length
  $('empty').hidden = items.length > 0
  $('history-count').textContent = String(items.length)
  $('saved-note').textContent = saved
    ? `${plural(saved, 'lien')} avec un média enregistré dans l’historique.`
    : 'Un historique local, accessible à tout moment.'
}

async function onItemClick(event) {
  const target = event.target.closest('[data-action]')
  const row = event.target.closest('.item')
  if (!target || !row) return
  const id = row.dataset.id
  let action = target.dataset.action
  if (action === 'main') {
    const status = row.dataset.status
    if (PENDING.has(status)) return
    action = status === 'done' ? 'open' : 'retry'
  }
  const result = await api[action](id)
  if (action === 'open' && result) notify('Le fichier a été déplacé ou supprimé.')
}

// ---------------------------------------------------------------- clipboard and drop

function receiveLinks(urls) {
  if (!urls.length) return false
  if (view === 'batch') appendToBatch(urls)
  else $('link').value = urls.join(' ')
  return true
}

async function paste() {
  if (!receiveLinks(await api.clipboardUrls())) notify('Le presse-papiers ne contient pas de lien.')
  else notify('')
}

/** On focus, a link copied elsewhere is placed in the empty field. */
async function checkClipboard() {
  if (view !== 'download' || $('link').value || $('settings').open) return
  const [url] = await api.clipboardUrls()
  if (!url || url === lastClipboard) return
  lastClipboard = url
  $('link').value = url
}

// ---------------------------------------------------------------- wiring

$('link-form').addEventListener('submit', (event) => { event.preventDefault(); downloadLink() })
$('link').addEventListener('paste', (event) => {
  // Keep line breaks out of the single-line field: several links stay separable.
  const text = event.clipboardData.getData('text')
  if (!/\s/.test(text.trim())) return
  event.preventDefault()
  $('link').value = text.trim().split(/\s+/).join(' ')
})
$('paste').addEventListener('click', paste)

$('batch-links').addEventListener('input', updateBatchCount)
$('collection-form').addEventListener('submit', (event) => { event.preventDefault(); importCollection() })
$('batch-start').addEventListener('click', startBatch)
$('concurrency').addEventListener('change', (event) => saveSetting({ concurrency: Number(event.target.value) }))

for (const link of document.querySelectorAll('[data-nav]')) {
  link.addEventListener('click', (event) => { event.preventDefault(); navigate(link.dataset.nav) })
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => { mode = button.dataset.mode; renderOptions() })
}
for (const button of document.querySelectorAll('[data-quality]')) {
  button.addEventListener('click', () => saveSetting({ quality: button.dataset.quality }))
}

$('open-folder').addEventListener('click', () => api.openDirectory())
$('choose-directory').addEventListener('click', async () => {
  const button = $('choose-directory')
  button.disabled = true
  button.textContent = 'Sélection…'
  try {
    settings = await api.chooseDirectory()
    renderOptions()
    notify('')
  } catch {
    notify('Impossible de modifier le dossier. Vérifiez les droits d’accès.')
  } finally {
    button.disabled = false
    button.textContent = 'Changer de dossier'
  }
})
$('cookies').addEventListener('change', (event) => saveSetting({ cookiesBrowser: event.target.value }))

$('items').addEventListener('click', onItemClick)
$('clear').addEventListener('click', () => api.clearFinished())
$('export').addEventListener('click', async () => {
  try {
    const file = await api.exportHistory()
    if (file) notify(`Historique exporté dans ${file}`, 'info')
  } catch (error) { notify(cleanError(error)) }
})
$('import').addEventListener('click', async () => {
  try {
    const added = await api.importHistory()
    if (added != null) notify(added ? `${plural(added, 'entrée')} importées.` : 'Rien de nouveau dans ce fichier.', 'info')
  } catch (error) { notify(cleanError(error)) }
})

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const data = event.dataTransfer
  if (receiveLinks(extractUrls(`${data.getData('text/uri-list')}\n${data.getData('text/plain')}`))) notify('')
})

window.addEventListener('focus', checkClipboard)

api.onItems(renderItems)
api.onTools(renderTools)

api.state().then((state) => {
  settings = state.settings
  renderOptions()
  renderTools(state.tools)
  renderItems(state.items)
  checkClipboard()
})
