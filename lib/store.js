'use strict'

const fs = require('node:fs')
const path = require('node:path')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Writes to a temporary file then renames, so a crash never leaves half a file. */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data), 'utf8')
  fs.renameSync(temporary, file)
}

module.exports = { readJson, writeJsonAtomic }
