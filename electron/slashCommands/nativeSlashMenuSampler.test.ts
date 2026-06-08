import { describe, expect, it } from 'vitest'
import { parseNativeSlashMenu } from './nativeSlashMenuSampler'

describe('nativeSlashMenuSampler', () => {
  it('parses Claude slash menu commands, aliases, descriptions, and native order', () => {
    const output = `
/claude-api               Build, debug, and optimize Claude API / Anthropic SDK apps
/review                   Review a pull request
/context                  Visualize current context usage as a colored grid
/usage (cost)             Show session cost, plan usage, and activity stats
/resume (continue)        Resume a previous conversation
/rewind (checkpoint)      Restore the code and/or conversation to a previous point
`

    const items = parseNativeSlashMenu(output)

    expect(items.map((item) => item.displayText)).toEqual([
      '/claude-api',
      '/review',
      '/context',
      '/usage',
      '/resume',
      '/rewind'
    ])
    expect(items.find((item) => item.displayText === '/usage')).toMatchObject({
      aliases: ['cost'],
      description: 'Show session cost, plan usage, and activity stats',
      nativeOrder: 3,
      confidence: 'native-evidence',
      scopeLabel: '当前安装'
    })
    expect(items.find((item) => item.displayText === '/resume')).toMatchObject({ aliases: ['continue'] })
    expect(items.find((item) => item.displayText === '/rewind')).toMatchObject({ aliases: ['checkpoint'] })
  })

  it('parses command names when TUI cursor positioning leaves no spaces before descriptions', () => {
    const output = `
/add-dirAddanewworkingdirectory
/backgroundContinuethissessioninthebackgroundandfreetheterminal
/contextVisualizecurrentcontextusageasacoloredgrid
/usage(cost)Showsessioncost,planusage,andactivitystats
/resume(continue)Resumeapreviousconversation
`

    const items = parseNativeSlashMenu(output)

    expect(items.map((item) => item.displayText)).toEqual(['/add-dir', '/background', '/context', '/usage', '/resume'])
    expect(items.find((item) => item.displayText === '/usage')).toMatchObject({ aliases: ['cost'] })
    expect(items.find((item) => item.displayText === '/context')?.description).toBeTruthy()
  })

  it('ignores prompts, status lines, and malformed slash-like noise', () => {
    const output = `
Claude Code v2.1.140
❯ /c
/statusline text without command description
https://example.com/path
/ok                       Valid command
`

    const items = parseNativeSlashMenu(output)

    expect(items.map((item) => item.displayText)).toEqual(['/ok'])
  })
})
