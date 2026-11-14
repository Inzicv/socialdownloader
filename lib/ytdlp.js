'use strict'

/**
 * Everything that talks to yt-dlp: argument building, output parsing, and the
 * two processes the app runs (probe a link, download a link).
 *
 * Arguments always go through spawn() as an array, never through a shell, so a
 * link or a folder name can never be interpreted as a command.
 */

const { spawn } = require('node:child_process')
const readline = require('node:readline')

const PROGRESS_PREFIX = 'PRG|'
const TITLE_PREFIX = 'TITLE|'
const DONE_PREFIX = 'DONE|'
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s'

const QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360']
const COOKIE_BROWSERS = ['', 'firefox', 'chrome', 'edge', 'brave']
const MAX_PLAYLIST_ENTRIES = 500

function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Every http(s) link found in a pasted blob of text, in order, without duplicates. */
function extractUrls(text) {
  const found = String(text ?? '').split(/\s+/).filter(isHttpUrl)
  return [...new Set(found)]
}

function commonArgs({ ffmpeg, cookiesBrowser } = {}) {
  const args = ['--no-warnings', '--no-colors', '--encoding', 'utf-8']
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser)
  return args
}

function probeArgs(url, env) {
  return [...commonArgs(env), '-J', '--flat-playlist', '--no-playlist', '--', url]
}

function downloadArgs(job, env) {
  const args = [
    ...commonArgs(env),
    '--newline',
    // --print switches yt-dlp to quiet + simulate; these two switch both back.
    '--progress',
    '--no-simulate',
    '--no-playlist',
    '--no-mtime',
    '--embed-metadata',
    '--progress-template', PROGRESS_TEMPLATE,
    '--print', `before_dl:${TITLE_PREFIX}%(title)s`,
    '--print', `after_move:${DONE_PREFIX}%(filepath)s`,
    '-P', job.directory,
    '-o', '%(title).120B [%(id)s].%(ext)s',
  ]
  if (job.mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail')
  } else {
    // Highest resolution first (capped when a quality is chosen), then the
    // codecs every player reads, so the merged file stays a plain MP4.
    const cap = job.quality && job.quality !== 'best' ? `res:${job.quality}` : 'res'
    args.push('-S', `${cap},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4')
  }
  args.push('--', job.url)
  return args
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** A progress line from PROGRESS_TEMPLATE, or null for any other output. */
function parseProgress(line) {
  if (!line.startsWith(PROGRESS_PREFIX)) return null
  const [downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
  return {
    downloaded: number(downloaded) ?? 0,
    total: number(total) ?? number(estimate),
    speed: number(speed),
    eta: number(eta),
  }
}

/** Reduces yt-dlp's -J output to what the interface shows. */
function summarize(info, fallbackUrl) {
  if (info._type === 'playlist') {
    const entries = (info.entries ?? [])
      .map((entry) => ({ url: entry.url || entry.webpage_url, title: entry.title || '' }))
      .filter((entry) => isHttpUrl(entry.url))
      .slice(0, MAX_PLAYLIST_ENTRIES)
    return {
      kind: 'playlist',
      title: info.title || 'Playlist',
      uploader: info.uploader || info.channel || '',
      entries,
    }
  }
  const heights = [...new Set(
    (info.formats ?? [])
      .filter((format) => format.vcodec && format.vcodec !== 'none' && format.height)
      .map((format) => format.height),
  )].sort((a, b) => b - a)
  return {
    kind: 'video',
    url: isHttpUrl(info.webpage_url) ? info.webpage_url : fallbackUrl,
    title: info.title || fallbackUrl,
    uploader: info.uploader || info.channel || '',
    duration: number(info.duration),
    thumbnail: isHttpUrl(info.thumbnail) ? info.thumbnail : '',
    heights,
  }
}

function eachLine(stream, callback) {
  readline.createInterface({ input: stream }).on('line', callback)
}

function killTree(child) {
  if (child.exitCode !== null || !child.pid) return
  // yt-dlp hands merging to an ffmpeg child; a plain kill would orphan it.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill()
  }
}

function probe(bin, url, env, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, probeArgs(url, env), { windowsHide: true })
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error('Le site met trop de temps à répondre.'))
    }, timeoutMs)
    let out = ''
    let lastError = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (out += chunk))
    eachLine(child.stderr, (line) => {
      if (line.startsWith('ERROR:')) lastError = line.slice(6).trim()
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(lastError || `yt-dlp s'est arrêté (code ${code}).`))
      try {
        resolve(summarize(JSON.parse(out), url))
      } catch {
        reject(new Error('Réponse de yt-dlp illisible.'))
      }
    })
  })
}

/**
 * Starts one download. `onUpdate` receives partial item fields as they change;
 * the promise resolves with the final file path.
 */
function download(bin, job, env, onUpdate) {
  const child = spawn(bin, downloadArgs(job, env), { windowsHide: true })
  let file = null
  let lastError = ''
  let part = 1
  let lastFraction = 0
  const promise = new Promise((resolve, reject) => {
    eachLine(child.stdout, (line) => {
      if (line.startsWith(DONE_PREFIX)) {
        file = line.slice(DONE_PREFIX.length).trim()
        return
      }
      if (line.startsWith(TITLE_PREFIX)) {
        onUpdate({ title: line.slice(TITLE_PREFIX.length).trim() })
        return
      }
      const progress = parseProgress(line)
      if (!progress) return
      const fraction = progress.total ? Math.min(1, progress.downloaded / progress.total) : 0
      // Video and audio arrive as separate streams: the counter restarts.
      if (fraction + 0.2 < lastFraction) part += 1
      lastFraction = fraction
      onUpdate({ progress: fraction, speed: progress.speed, eta: progress.eta, total: progress.total, part })
    })
    eachLine(child.stderr, (line) => {
      if (line.startsWith('ERROR:')) lastError = line.slice(6).trim()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && file) resolve(file)
      else reject(new Error(lastError || `yt-dlp s'est arrêté (code ${code}).`))
    })
  })
  return { promise, cancel: () => killTree(child) }
}

module.exports = {
  COOKIE_BROWSERS,
  QUALITIES,
  download,
  downloadArgs,
  extractUrls,
  isHttpUrl,
  parseProgress,
  probe,
  probeArgs,
  summarize,
}
