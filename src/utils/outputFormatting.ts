import type { SessionOutputEvent } from '../types/workerDesk'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ansiPattern = new RegExp(`${ESC}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[PX^_][\\s\\S]*?${ESC}\\\\)`, 'g')
const excessiveBlankLinesPattern = /\n{4,}/g

function removeInvisibleControlChars(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) continue
    result += char
  }
  return result
}

export function formatOutputForDisplay(raw: string): string {
  if (!raw) return ''

  const normalized = raw
    .replace(ansiPattern, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line)
    .join('\n')

  return removeInvisibleControlChars(normalized).replace(excessiveBlankLinesPattern, '\n\n\n')
}

export function joinOutputChunksForDisplay(chunks: SessionOutputEvent[]): string {
  return formatOutputForDisplay(chunks.map((event) => event.chunk).join(''))
}
