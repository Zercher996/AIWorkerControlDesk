const zlib = require('zlib')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseRgb(color) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function colorDistance(a, b) {
  const ca = parseRgb(a)
  const cb = parseRgb(b)
  if (!ca || !cb) return Number.POSITIVE_INFINITY
  return Math.sqrt(
    (ca[0] - cb[0]) ** 2
    + (ca[1] - cb[1]) ** 2
    + (ca[2] - cb[2]) ** 2
  )
}

function isVisibleRegion(region) {
  return Boolean(
    region
    && region.width >= 24
    && region.height >= 24
    && region.display !== 'none'
    && region.visibility !== 'hidden'
    && Number(region.opacity) > 0.05
  )
}

async function assertVisibleShell(page, expectedTheme) {
  const snapshot = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const appShell = document.querySelector('.app-shell')
    const topbar = document.querySelector('.top-menu-bar')
    const projectPanel = document.querySelector('.project-panel')
    const sessionRadar = document.querySelector('.session-radar')
    const rightColumn = document.querySelector('.right-column')
    const activeRightPane = document.querySelector('.right-column .content-layer.is-active')
    const rootStyle = getComputedStyle(root)
    const bodyStyle = getComputedStyle(body)

    function rectInfo(element) {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        backgroundColor: style.backgroundColor,
        color: style.color
      }
    }

    const shellStyle = appShell ? getComputedStyle(appShell) : null

    return {
      theme: root.dataset.theme,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      tokens: {
        bgBase: rootStyle.getPropertyValue('--bg-base').trim(),
        bgPanel: rootStyle.getPropertyValue('--bg-panel').trim(),
        textPrimary: rootStyle.getPropertyValue('--text-primary').trim(),
        borderColor: rootStyle.getPropertyValue('--border-color').trim(),
        surfaceTerminalHeader: rootStyle.getPropertyValue('--surface-terminal-header').trim()
      },
      body: {
        backgroundColor: bodyStyle.backgroundColor,
        color: bodyStyle.color
      },
      shell: appShell && shellStyle ? {
        ...rectInfo(appShell),
        gridTemplateColumns: shellStyle.gridTemplateColumns,
        gridTemplateRows: shellStyle.gridTemplateRows
      } : null,
      regions: {
        topbar: rectInfo(topbar),
        projectPanel: rectInfo(projectPanel),
        sessionRadar: rectInfo(sessionRadar),
        rightColumn: rectInfo(rightColumn),
        activeRightPane: rectInfo(activeRightPane)
      }
    }
  })

  const tokens = snapshot.tokens
  const missingTokens = Object.entries(tokens)
    .filter(([, value]) => !value)
    .map(([name]) => name)
  assert(missingTokens.length === 0, `Theme tokens should resolve for ${expectedTheme}: ${missingTokens.join(', ')}`)
  assert(snapshot.theme === expectedTheme, `Expected ${expectedTheme} theme, got ${snapshot.theme || 'unset'}`)
  assert(snapshot.viewport.width >= 600 && snapshot.viewport.height >= 400, `Viewport should have visible size: ${JSON.stringify(snapshot.viewport)}`)
  assert(snapshot.shell, 'App shell should exist for visual smoke check')
  assert(snapshot.shell.display === 'grid', `App shell should use grid layout, got ${snapshot.shell.display}`)
  assert(isVisibleRegion(snapshot.shell), `App shell should be visible: ${JSON.stringify(snapshot.shell)}`)
  assert(snapshot.shell.width >= snapshot.viewport.width * 0.8, `App shell width should fill the window: ${JSON.stringify(snapshot.shell)}`)
  assert(snapshot.shell.height >= snapshot.viewport.height * 0.8, `App shell height should fill the window: ${JSON.stringify(snapshot.shell)}`)
  assert(colorDistance(snapshot.body.backgroundColor, snapshot.body.color) > 64, `Body text should contrast with background: ${JSON.stringify(snapshot.body)}`)
  assert(colorDistance(snapshot.regions.topbar?.backgroundColor, snapshot.regions.topbar?.color) > 32, `Topbar should not be washed out: ${JSON.stringify(snapshot.regions.topbar)}`)

  for (const [name, region] of Object.entries(snapshot.regions)) {
    assert(isVisibleRegion(region), `${name} should have visible area in ${expectedTheme}: ${JSON.stringify(region)}`)
  }
}

function parsePngColorType(buffer) {
  const pngSignature = '89504e470d0a1a0a'
  assert(buffer.subarray(0, 8).toString('hex') === pngSignature, 'Screenshot should be a PNG image')
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'IHDR') {
      return {
        width: buffer.readUInt32BE(offset + 8),
        height: buffer.readUInt32BE(offset + 12),
        bitDepth: buffer[offset + 16],
        colorType: buffer[offset + 17]
      }
    }
    offset += 12 + length
  }
  throw new Error('Screenshot PNG is missing IHDR')
}

function decodePngRows(buffer) {
  const header = parsePngColorType(buffer)
  assert(header.bitDepth === 8, `Screenshot PNG should use 8-bit channels, got ${header.bitDepth}`)

  let offset = 8
  const compressedChunks = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'IDAT') compressedChunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }

  const channelsByColorType = {
    0: 1,
    2: 3,
    4: 2,
    6: 4
  }
  const channels = channelsByColorType[header.colorType]
  assert(channels, `Unsupported screenshot PNG color type: ${header.colorType}`)

  const inflated = zlib.inflateSync(Buffer.concat(compressedChunks))
  const stride = header.width * channels
  const rows = []
  let sourceOffset = 0
  let previous = Buffer.alloc(stride)

  function paethPredictor(a, b, c) {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
  }

  for (let y = 0; y < header.height; y += 1) {
    const filter = inflated[sourceOffset]
    sourceOffset += 1
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride))
    sourceOffset += stride

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      if (filter === 1) row[x] = (row[x] + left) & 0xff
      else if (filter === 2) row[x] = (row[x] + up) & 0xff
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) row[x] = (row[x] + paethPredictor(left, up, upLeft)) & 0xff
      else assert(filter === 0, `Unsupported PNG row filter: ${filter}`)
    }

    rows.push(row)
    previous = row
  }

  return { ...header, channels, rows }
}

async function assertScreenshotNotBlank(page, path, label, options = {}) {
  const buffer = await page.screenshot({ path, fullPage: true })
  const png = decodePngRows(buffer)
  const samples = new Map()
  let minLuma = 255
  let maxLuma = 0
  let coloredSamples = 0
  const stepX = Math.max(1, Math.floor(png.width / 48))
  const stepY = Math.max(1, Math.floor(png.height / 32))

  function readRgb(x, y) {
    const row = png.rows[Math.max(0, Math.min(png.height - 1, y))]
    const index = Math.max(0, Math.min(png.width - 1, x)) * png.channels
    if (png.colorType === 0 || png.colorType === 4) {
      return [row[index], row[index], row[index]]
    }
    return [row[index], row[index + 1], row[index + 2]]
  }

  function rgbDistance(a, b) {
    return Math.sqrt(
      (a[0] - b[0]) ** 2
      + (a[1] - b[1]) ** 2
      + (a[2] - b[2]) ** 2
    )
  }

  for (let y = 0; y < png.height; y += stepY) {
    const row = png.rows[y]
    for (let x = 0; x < png.width; x += stepX) {
      const index = x * png.channels
      let r
      let g
      let b
      if (png.colorType === 0 || png.colorType === 4) {
        r = row[index]
        g = row[index]
        b = row[index]
      } else {
        r = row[index]
        g = row[index + 1]
        b = row[index + 2]
      }
      const luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
      minLuma = Math.min(minLuma, luma)
      maxLuma = Math.max(maxLuma, luma)
      samples.set(`${r},${g},${b}`, true)
      if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3 || Math.abs(r - b) > 3) coloredSamples += 1
    }
  }

  assert(samples.size >= 12, `${label} screenshot should contain varied colors, got ${samples.size}`)
  assert(maxLuma - minLuma >= 20, `${label} screenshot should have visible contrast, luma range ${Math.round(maxLuma - minLuma)}`)
  assert(coloredSamples >= 8, `${label} screenshot should not be a flat white/gray frame, colored samples ${coloredSamples}`)

  if (options.checkWindowControls) {
    const topbarSample = readRgb(Math.max(1, png.width - 220), 16)
    const controlsSample = readRgb(Math.max(1, png.width - 72), 16)
    const distance = rgbDistance(topbarSample, controlsSample)
    assert(distance < 42, `${label} window controls should visually belong to the top bar, distance ${Math.round(distance)}`)
  }
}

async function assertNoForbiddenCopy(page) {
  const forbidden = /健康分|评分|AI 推荐指数|DAG|节点图|工作流|Dieter Rams|Rams/
  const bodyText = await page.locator('body').innerText()
  assert(!forbidden.test(bodyText), 'Forbidden fake scoring or reviewer copy should not render')
}

async function assertCurrentShell(page) {
  const topbar = page.getByLabel('顶部调度栏', { exact: true })
  await topbar.waitFor({ timeout: 5000 })
  await topbar.getByText('AIWorkerControlDesk', { exact: true }).waitFor({ timeout: 5000 })
  await topbar.getByText('本地 AI Worker 调度台', { exact: true }).waitFor({ timeout: 5000 })
  const topbarText = await topbar.innerText()
  assert(!/项目|模型|需接管|运行 \d+|完成 \d+/.test(topbarText), 'Topbar should not duplicate panel state')
  await page.getByRole('heading', { name: '项目', exact: true }).waitFor({ timeout: 5000 })
  await page.getByLabel('启动检查', { exact: true }).waitFor({ timeout: 5000 })
  await page.getByRole('heading', { name: '调度中心', exact: true }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '当前会话', exact: true }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '历史', exact: true }).waitFor({ timeout: 5000 })
  await assertNoForbiddenCopy(page)
}

module.exports = {
  assert,
  assertCurrentShell,
  assertNoForbiddenCopy,
  assertScreenshotNotBlank,
  assertVisibleShell
}
