'use strict'

const { randomUUID } = require('node:crypto')

const RETRYABLE = new Set(['error', 'canceled', 'interrupted'])
const FINISHED = new Set(['done', 'error', 'canceled', 'interrupted'])

/**
 * The download list: runs up to `concurrency` items at once, oldest first.
 *
 * `start(item, update)` launches the work and returns `{ promise, cancel }`.
 * The queue knows nothing about yt-dlp, which is what keeps it testable.
 */
class DownloadQueue {
  #start
  #onChange
  #active = new Map()

  constructor({ concurrency = 3, start, onChange = () => {} }) {
    this.concurrency = concurrency
    this.items = []
    this.#start = start
    this.#onChange = onChange
  }

  /** Restores a saved list. Anything that was mid-flight can only be resumed by hand. */
  load(saved) {
    this.items = saved.map((item) =>
      FINISHED.has(item.status) ? item : { ...item, status: 'interrupted', speed: null, eta: null },
    )
  }

  /** Adds saved items that are not already listed; returns how many were added. */
  merge(saved) {
    const known = new Set(this.items.map((item) => item.id))
    const added = saved
      .filter((item) => !known.has(item.id))
      .map((item) => (FINISHED.has(item.status) ? item : { ...item, status: 'interrupted', speed: null, eta: null }))
    this.items.push(...added)
    this.items.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
    if (added.length) this.#onChange()
    return added.length
  }

  get busy() {
    return this.items.some((item) => item.status === 'queued' || item.status === 'running')
  }

  find(id) {
    return this.items.find((item) => item.id === id)
  }

  add(fields) {
    const item = {
      id: randomUUID(),
      title: '',
      thumbnail: '',
      mode: 'video',
      quality: 'best',
      ...fields,
      status: 'queued',
      progress: 0,
      speed: null,
      eta: null,
      total: null,
      part: 1,
      file: null,
      error: null,
      addedAt: Date.now(),
    }
    this.items.unshift(item)
    this.#pump()
    this.#onChange()
    return item
  }

  cancel(id) {
    const item = this.find(id)
    if (!item || (item.status !== 'queued' && item.status !== 'running')) return
    // Status first: the rejection that follows the kill must not read as an error.
    item.status = 'canceled'
    item.speed = item.eta = null
    this.#active.get(id)?.cancel()
    this.#onChange()
  }

  retry(id) {
    const item = this.find(id)
    if (!item || !RETRYABLE.has(item.status) || this.#active.has(id)) return
    Object.assign(item, { status: 'queued', error: null, progress: 0, part: 1 })
    this.#pump()
    this.#onChange()
  }

  remove(id) {
    this.cancel(id)
    this.items = this.items.filter((item) => item.id !== id)
    this.#onChange()
  }

  clearFinished() {
    this.items = this.items.filter((item) => !FINISHED.has(item.status) || this.#active.has(item.id))
    this.#onChange()
  }

  setConcurrency(value) {
    this.concurrency = value
    this.#pump()
  }

  #pump() {
    while (this.#active.size < this.concurrency) {
      // Items are stored newest first; the oldest queued one runs next.
      const next = this.items.findLast((item) => item.status === 'queued' && !this.#active.has(item.id))
      if (!next) return
      this.#run(next)
    }
  }

  #run(item) {
    item.status = 'running'
    let handle
    try {
      handle = this.#start(item, (patch) => {
        if (item.status !== 'running') return
        Object.assign(item, patch)
        this.#onChange()
      })
    } catch (error) {
      handle = { promise: Promise.reject(error), cancel: () => {} }
    }
    this.#active.set(item.id, handle)
    handle.promise
      .then(
        (file) => {
          if (item.status === 'running') Object.assign(item, { status: 'done', file, progress: 1 })
        },
        (error) => {
          if (item.status === 'running') Object.assign(item, { status: 'error', error: error.message })
        },
      )
      .finally(() => {
        item.speed = item.eta = null
        this.#active.delete(item.id)
        this.#pump()
        this.#onChange()
      })
  }
}

module.exports = { DownloadQueue }
