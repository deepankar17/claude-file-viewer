import { expect, mock, test } from 'claude-code/testing'

import { fileHref, frontmatterRows, pathFromHref, previewParts, readableValue } from '../hooks/markdown'

const PANE = {
  plugin: 'file-viewer',
  component: 'Pane',
  requestId: 'file-viewer',
  props: {
    title: 'notes.md',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAR = {
  plugin: 'file-viewer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const MEMORY = [
  '---',
  'name: notes',
  'description: "Say \\"hi\\" politely"',
  'metadata:',
  '  type: feedback',
  '  modified: 2026-10-28T07:15:42.382Z',
  '---',
  '',
  '**Why:** see [[other]] and [[missing]].',
].join('\n')

const FILES: Record<string, string> = {
  'C:/home/notes.md': MEMORY,
  'C:/home/other.md': '# Other',
  'C:/home/app.ts': 'export const x = 1\n',
}

// The engine hands paths on with Windows separators, and Windows ignores case.
const slashed = (path: string) => {
  const key = path.replace(/\\/g, '/').toLowerCase()

  return Object.keys(FILES).find(one => one.toLowerCase() === key) ?? key
}

const engine = (on: Parameters<Parameters<typeof test>[1]>[1], stored: Record<string, unknown> = {}) => {
  mock.store(on, stored)
  on('command.register', () => ({ value: { command: 'view-file' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-viewer__open_file' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: {} }))
  on('env.get', () => ({ value: 'C:/home' }))
  on('fs.exists', (_, e) => ({ value: FILES[slashed(e.path)] !== undefined }))
  on('fs.read', (_, e) => {
    const text = FILES[slashed(e.path)]
    if (text === undefined) {
      throw new Error(`ENOENT: no such file, open '${e.path}'`)
    }

    return { value: text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's own drawing of a site the mod hands back (a hidden bar).
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<readonly { text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '')

test('frontmatter flattens to rows, nested keys dotted', async () => {
  expect(frontmatterRows('name: a\ndescription: "x \\"y\\""\nmetadata:\n  type: feedback\ntags:\n  - one\n  - two')).toEqual([
    ['name', 'a'],
    ['description', 'x "y"'],
    ['metadata.type', 'feedback'],
    ['tags', 'one, two'],
  ])
  expect(frontmatterRows('weird line without colon')).toBeNull()
  expect(readableValue('2026-10-28T07:15:42.382Z')).toBe('28 Oct 2026, 07:15 UTC')
})

test('a file without frontmatter is left as written; rich frontmatter stays as yaml', async () => {
  expect(previewParts('# Title\n\n---\n\ntext', {})).toEqual({ properties: null, markdown: '# Title\n\n---\n\ntext' })
  expect(previewParts('---\nodd\n---\nbody', {}).markdown).toBe('```yaml\nodd\n```\n\nbody')
})

test('file links round-trip, spaces and parens included', async () => {
  const path = 'C:\\Users\\me\\My (notes)\\a.md'
  expect(pathFromHref(fileHref(path))).toBe(path)
})

test('a memory file shows a title, its description, a properties card and linked [[names]]', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'view-file', args: '"~/notes.md"' })
  expect(ran.text).toBe('Opened C:/home/notes.md')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all).toContain('MARKDOWN')
    expect(all).toContain('notes.md')
    expect(all).toContain('Say "hi" politely')
    expect(all).toContain('PROPERTY')
    expect(all).toContain('metadata.type')
    expect(all).toContain('28 Oct 2026, 07:15 UTC')
    const body = (await ui.find({ type: 'Markdown' }))?.text ?? ''
    expect(body).not.toContain('metadata')
    expect(body).toContain('[other](file:///C:/home/other.md)')
    expect(body).toContain('[[missing]]')
    await ui.unmount()
  }
})

test('Source shows the raw text; open_file shows code and refuses a missing file', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'view-file', args: 'C:/home/notes.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'raw' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await texts(ui)).not.toContain('PROPERTY')
  await ui.press({ key: 'raw' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()

  const ok = await $.tool.call({ tool: 'mcp__file-viewer__open_file', path: 'C:/home/app.ts' })
  expect(ok.deny).toBeUndefined()
  const code = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await code.find({ type: 'Code' })).toBeDefined()
  expect(await texts(code)).toContain('TYPESCRIPT')
  expect(await code.find({ type: 'Button', key: 'back' })).toBeDefined()
  await code.unmount()

  const missing = await $.tool.call({ tool: 'mcp__file-viewer__open_file', path: 'C:/nope.md' })
  expect(missing.text ?? missing.deny).toMatch(/Could not read C:\/nope.md/)
})

test('the bar has no path field, lists recent files from the last session, opens them, and hides', async ($, on) => {
  engine(on, { recent: ['C:/home/other.md'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface })
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'files' }))?.text).toBe('Files (0)')
    expect((await ui.find({ type: 'Button', key: 'recent-0' }))?.text).toBe('other.md')
    await ui.unmount()
  }

  await $.command.run({ command: 'view-file', args: '~/notes.md' })
  const bar = await $.ui.mount({ ...BAR, surface: 'desktop' })
  expect((await bar.find({ type: 'Button', key: 'recent-0' }))?.text).toBe('• notes.md')
  expect((await bar.find({ type: 'Button', key: 'recent-1' }))?.text).toBe('other.md')

  await bar.press({ key: 'recent-1' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await texts(pane)).toContain('other.md')
  await pane.unmount()

  await bar.press({ key: 'hide-bar' })
  expect(await bar.find({ type: 'Button', key: 'files' })).toBeUndefined()
  await bar.unmount()

  await $.command.run({ command: 'view-file', args: '' })
  const shown = await $.ui.mount({ ...BAR, surface: 'desktop' })
  expect(await shown.find({ type: 'Button', key: 'files' })).toBeDefined()
  await shown.unmount()
})

test('the pane draws in the slate palette, and its light twin under a light theme', async ($, on) => {
  let theme = 'dark'
  engine(on)
  on('config.list', () => ({ value: [{ key: 'theme', value: theme }] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'view-file', args: 'C:/home/notes.md' })

  const dark = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await dark.find({ type: 'Text', text: 'MARKDOWN' }))?.props).toMatchObject({ color: '#79a8ff' })
  expect((await dark.find({ type: 'Box' }))?.props).toMatchObject({ backgroundColor: '#131a24' })
  await dark.unmount()

  theme = 'light-daltonized'
  const light = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await light.find({ type: 'Text', text: 'MARKDOWN' }))?.props).toMatchObject({ color: '#2f6fdb' })
  await light.unmount()
})

test('files Claude reads, edits or writes are listed, newest first, and open from the list', async ($, on) => {
  engine(on)
  // Stands for the tools themselves: a read of a missing file fails.
  on('tool.call', (_, e) => {
    const path = (e as unknown as { file_path?: string }).file_path

    return path === 'C:/nope.md' ? { result: 'File does not exist.', isError: true } : { result: 'ok' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:/home/app.ts' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/home/notes.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\HOME\\notes.md' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/home/other.md', content: '# Other' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/nope.md' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const bar = await $.ui.mount({ ...BAR, surface: 'desktop' })
  expect((await bar.find({ type: 'Button', key: 'files' }))?.text).toBe('Files (3)')
  await bar.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all).toContain('3 FILES')
    expect((await ui.find({ type: 'Button', key: 'file-0' }))?.text).toBe('other.md')
    expect((await ui.find({ type: 'Button', key: 'file-1' }))?.text).toBe('notes.md')
    expect((await ui.find({ type: 'Button', key: 'file-2' }))?.text).toBe('app.ts')
    expect(all.filter(text => /^(READ|EDITED|WRITTEN)$/.test(text))).toEqual(['WRITTEN', 'EDITED', 'READ'])
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'filter', text: 'app', kind: 'change' })
  expect(await texts(ui)).toContain('1 OF 3 FILES')
  await ui.input({ key: 'filter', text: '', kind: 'change' })

  await ui.press({ key: 'file-1' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  expect(await texts(ui)).toContain('notes.md')
  await ui.press({ key: 'files' })
  expect(await texts(ui)).toContain('3 FILES')
  await ui.press({ key: 'to-file' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()
})

test('the phone draws the list without a filter field', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/home/app.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await texts(ui)).toContain('1 FILES')
  expect((await ui.find({ type: 'Button', key: 'file-0' }))?.text).toBe('app.ts')
  await ui.unmount()
})
