'use strict'

/**
 * Launches the real app and saves screenshots of each view.
 *
 *   npx electron scripts/smoke.js <output folder> [link]
 *
 * Nothing is downloaded unless SMOKE_DOWNLOAD=1, which downloads `link` into
 * the configured folder.
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [outDir, link = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'] = process.argv.slice(2)
if (!outDir) {
  console.error('usage: electron scripts/smoke.js <output folder> [link]')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.on('browser-window-created', (_event, win) => {
  const page = win.webContents
  const errors = []
  page.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  const shot = async (name) => {
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const evaluate = (code) => page.executeJavaScript(code)
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)

  page.once('did-finish-load', async () => {
    try {
      await delay(1200)
      await shot('1-accueil')

      if (process.env.SMOKE_DOWNLOAD === '1') {
        const before = await evaluate(`document.querySelectorAll('#items .item').length`)
        await evaluate(`document.getElementById('link').value = ${JSON.stringify(link)}`)
        await click('#download')
        for (let i = 0; i < 240; i++) {
          await delay(500)
          const status = await evaluate(`document.querySelectorAll('#items .item').length > ${before} ? document.querySelector('#items .item').dataset.status : ''`)
          if (status === 'running') await shot('2-en-cours')
          if (status && status !== 'queued' && status !== 'running') break
          if (await evaluate(`!document.getElementById('notice').hidden && !document.getElementById('notice').classList.contains('is-info')`)) break
        }
        await delay(400)
        await shot('3-termine')
      }

      await click('[data-nav="batch"]')
      await delay(500)
      await shot('4-lot')
      await click('[data-nav="download"]')
      await click('[data-quality="720"]')
      await click('[data-mode="audio"]')
      await delay(300)
      const badge = await evaluate(`document.getElementById('quality-badge').textContent`)
      await click('[data-quality="best"]')
      await click('[data-mode="video"]')
      await click('[data-nav="settings"]')
      await delay(300)
      await shot('5-reglages')

      console.log(JSON.stringify(await evaluate(`({
        firstItem: document.querySelector('#items .item')?.innerText ?? null,
        items: document.querySelectorAll('#items .item').length,
        count: document.getElementById('history-count').textContent,
        notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
        tools: document.getElementById('tools').textContent,
        directory: document.getElementById('directory').textContent,
        font: getComputedStyle(document.querySelector('.workspace')).fontFamily,
        fontLoaded: document.fonts.check('14px Geist'),
      })`)), 'badge(audio+standard)=', badge)
      console.log('console errors:', JSON.stringify(errors))
    } catch (error) {
      console.error('SMOKE FAIL', error)
      process.exitCode = 1
    } finally {
      app.quit()
    }
  })
})

require('../main.js')
