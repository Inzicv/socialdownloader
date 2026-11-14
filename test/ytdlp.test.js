'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { downloadArgs, extractUrls, isHttpUrl, parseProgress, probeArgs, summarize } = require('../lib/ytdlp')

test('only http and https links are accepted', () => {
  assert.equal(isHttpUrl('https://example.com/v/1'), true)
  assert.equal(isHttpUrl('http://example.com'), true)
  assert.equal(isHttpUrl('file:///C:/secret.txt'), false)
  assert.equal(isHttpUrl('--exec calc'), false)
  assert.equal(isHttpUrl(undefined), false)
})

test('pasted text yields each link once, in order', () => {
  const text = 'voici https://a.example/1\nhttps://b.example/2 et https://a.example/1 fin'
  assert.deepEqual(extractUrls(text), ['https://a.example/1', 'https://b.example/2'])
  assert.deepEqual(extractUrls('rien ici'), [])
})

test('the link is always the last argument, after the option terminator', () => {
  const env = { ffmpeg: 'C:\\bin\\ffmpeg.exe', cookiesBrowser: 'firefox' }
  for (const args of [
    probeArgs('https://example.com/v', env),
    downloadArgs({ url: 'https://example.com/v', mode: 'video', quality: '720', directory: 'D:\\Vidéos' }, env),
  ]) {
    assert.deepEqual(args.slice(-2), ['--', 'https://example.com/v'])
    assert.equal(args[args.indexOf('--ffmpeg-location') + 1], 'C:\\bin\\ffmpeg.exe')
    assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox')
  }
})

test('video downloads cap the resolution only when a quality is chosen', () => {
  const sort = (quality) => {
    const args = downloadArgs({ url: 'https://e.example', mode: 'video', quality, directory: 'D:\\x' }, {})
    return args[args.indexOf('-S') + 1]
  }
  assert.equal(sort('1080'), 'res:1080,vcodec:h264,acodec:m4a')
  assert.equal(sort('best'), 'res,vcodec:h264,acodec:m4a')
})

test('audio downloads extract an mp3 and never merge to mp4', () => {
  const args = downloadArgs({ url: 'https://e.example', mode: 'audio', directory: 'D:\\x' }, {})
  assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3')
  assert.equal(args.includes('--merge-output-format'), false)
  assert.equal(args.includes('--ffmpeg-location'), false)
})

test('progress lines are parsed, with the estimate as fallback total', () => {
  assert.deepEqual(parseProgress('PRG|500|1000|NA|2048.5|12'), { downloaded: 500, total: 1000, speed: 2048.5, eta: 12 })
  assert.deepEqual(parseProgress('PRG|500|NA|2000.0|NA|NA'), { downloaded: 500, total: 2000, speed: null, eta: null })
  assert.equal(parseProgress('[download] Destination: clip.mp4'), null)
})

test('a single video is summarized with its available heights, tallest first', () => {
  const summary = summarize({
    title: 'Clip',
    uploader: 'Quelqu’un',
    duration: 42,
    thumbnail: 'https://cdn.example/t.jpg',
    webpage_url: 'https://example.com/v/1',
    formats: [
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'vp9', height: 1080 },
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'none', acodec: 'opus' },
    ],
  }, 'https://short.example/x')
  assert.equal(summary.kind, 'video')
  assert.equal(summary.url, 'https://example.com/v/1')
  assert.deepEqual(summary.heights, [1080, 720])
})

test('a playlist keeps only entries with a usable link', () => {
  const summary = summarize({
    _type: 'playlist',
    title: 'Ma liste',
    entries: [{ url: 'https://example.com/1', title: 'Un' }, { url: 'abc', title: 'Cassé' }, { webpage_url: 'https://example.com/3' }],
  }, 'https://example.com/list')
  assert.equal(summary.kind, 'playlist')
  assert.deepEqual(summary.entries, [
    { url: 'https://example.com/1', title: 'Un' },
    { url: 'https://example.com/3', title: '' },
  ])
})
