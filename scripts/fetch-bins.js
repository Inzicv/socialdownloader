'use strict'

/**
 * Downloads the two tools the installer ships, into vendor/bin/:
 *
 *   yt-dlp.exe   latest official release (github.com/yt-dlp/yt-dlp)
 *   ffmpeg.exe   latest "release essentials" static build (gyan.dev)
 *
 * Each download is checked against the SHA-256 its publisher lists next to it.
 * Files already present are kept; pass --force to fetch them again.
 *
 *   node scripts/fetch-bins.js [--force]
 */

const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const BIN = path.join(__dirname, '..', 'vendor', 'bin')
const FORCE = process.argv.includes('--force')

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const FFMPEG_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

async function get(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`)
  return response
}

/** Streams `url` to `file` and returns the SHA-256 of what was written. */
async function downloadTo(url, file) {
  const response = await get(url)
  const hash = createHash('sha256')
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => hash.update(chunk))
  await pipeline(source, fs.createWriteStream(file))
  return hash.digest('hex')
}

function expect(actual, expected, name) {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Somme de contrôle introuvable pour ${name}.`)
  if (actual !== expected) throw new Error(`Somme de contrôle incorrecte pour ${name} : fichier refusé.`)
}

async function fetchYtdlp(target) {
  const sums = await (await get(`${YTDLP_BASE}/SHA2-256SUMS`)).text()
  const line = sums.split('\n').find((entry) => entry.trim().endsWith(' yt-dlp.exe'))
  const expected = (line ?? '').trim().split(/\s+/)[0].toLowerCase()
  const temporary = `${target}.tmp`
  expect(await downloadTo(`${YTDLP_BASE}/yt-dlp.exe`, temporary), expected, 'yt-dlp.exe')
  fs.renameSync(temporary, target)
}

async function fetchFfmpeg(target) {
  const expected = (await (await get(`${FFMPEG_ZIP}.sha256`)).text()).trim().split(/\s+/)[0].toLowerCase()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-'))
  try {
    const zip = path.join(work, 'ffmpeg.zip')
    expect(await downloadTo(FFMPEG_ZIP, zip), expected, 'ffmpeg (archive)')
    // Windows ships bsdtar, which reads zip archives; Git's GNU tar does not.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    execFileSync(tar, ['-xf', zip, '-C', work, '--strip-components=2', '*/bin/ffmpeg.exe'])
    fs.copyFileSync(path.join(work, 'ffmpeg.exe'), target)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Ce script prépare uniquement la version Windows.')
  fs.mkdirSync(BIN, { recursive: true })
  for (const [name, fetchTool] of [['yt-dlp.exe', fetchYtdlp], ['ffmpeg.exe', fetchFfmpeg]]) {
    const target = path.join(BIN, name)
    if (fs.existsSync(target) && !FORCE) {
      console.log(`${name} : déjà présent`)
      continue
    }
    console.log(`${name} : téléchargement…`)
    await fetchTool(target)
    console.log(`${name} : ${(fs.statSync(target).size / 1024 / 1024).toFixed(0)} Mo, somme vérifiée`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
