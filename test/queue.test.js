'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DownloadQueue } = require('../lib/queue')

/** A queue whose work is finished by hand, so each test controls the timing. */
function harness(concurrency = 2) {
  const jobs = new Map()
  const queue = new DownloadQueue({
    concurrency,
    start: (item, update) => {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      const job = { update, resolve, reject, canceled: false }
      jobs.set(item.url, job)
      return { promise, cancel: () => { job.canceled = true; reject(new Error('killed')) } }
    },
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const status = () => Object.fromEntries(queue.items.map((item) => [item.url, item.status]))
  return { queue, jobs, settle, status }
}

test('runs at most `concurrency` items, oldest first, and starts the next when one ends', async () => {
  const { queue, jobs, settle, status } = harness(2)
  for (const url of ['a', 'b', 'c']) queue.add({ url })
  assert.deepEqual(status(), { a: 'running', b: 'running', c: 'queued' })

  jobs.get('a').resolve('D:\\a.mp4')
  await settle()
  assert.deepEqual(status(), { a: 'done', b: 'running', c: 'running' })
  assert.equal(queue.items.find((item) => item.url === 'a').file, 'D:\\a.mp4')
})

test('a failure is recorded with its message and can be retried', async () => {
  const { queue, jobs, settle } = harness(1)
  const item = queue.add({ url: 'a' })
  jobs.get('a').reject(new Error('Vidéo privée'))
  await settle()
  assert.equal(item.status, 'error')
  assert.equal(item.error, 'Vidéo privée')

  queue.retry(item.id)
  assert.equal(item.status, 'running')
  assert.equal(item.error, null)
})

test('canceling a running item kills it and is not reported as an error', async () => {
  const { queue, jobs, settle, status } = harness(1)
  const first = queue.add({ url: 'a' })
  queue.add({ url: 'b' })
  queue.cancel(first.id)
  assert.equal(jobs.get('a').canceled, true)
  await settle()
  assert.deepEqual(status(), { a: 'canceled', b: 'running' })
  assert.equal(first.error, null)
})

test('progress updates stop applying once an item is no longer running', async () => {
  const { queue, jobs, settle } = harness(1)
  const item = queue.add({ url: 'a' })
  jobs.get('a').update({ progress: 0.5 })
  assert.equal(item.progress, 0.5)
  queue.cancel(item.id)
  jobs.get('a').update({ progress: 0.9 })
  await settle()
  assert.equal(item.progress, 0.5)
})

test('a restored list marks unfinished items as interrupted and never auto-starts them', () => {
  const { queue, jobs } = harness(1)
  queue.load([
    { id: '1', url: 'a', status: 'running' },
    { id: '2', url: 'b', status: 'queued' },
    { id: '3', url: 'c', status: 'done', file: 'D:\\c.mp4' },
  ])
  assert.deepEqual(queue.items.map((item) => item.status), ['interrupted', 'interrupted', 'done'])
  assert.equal(jobs.size, 0)
  queue.retry('1')
  assert.equal(queue.find('1').status, 'running')
})

test('clearing finished items keeps what is still queued or running', async () => {
  const { queue, jobs, settle, status } = harness(1)
  queue.add({ url: 'a' })
  queue.add({ url: 'b' })
  jobs.get('a').resolve('D:\\a.mp4')
  await settle()
  queue.clearFinished()
  assert.deepEqual(status(), { b: 'running' })
})

test('raising the concurrency starts waiting items immediately', () => {
  const { queue, status } = harness(1)
  queue.add({ url: 'a' })
  queue.add({ url: 'b' })
  queue.setConcurrency(2)
  assert.deepEqual(status(), { b: 'running', a: 'running' })
})
