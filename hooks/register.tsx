import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OpenedFile, SessionFile } from '../types'
import { fileHref, pathFromHref, previewParts, splitFrontmatter, wikiNames } from './markdown'
import { paletteFor } from './palette'
import { readError } from './read-error'

const PANE = 'file-viewer'
const COMMAND = 'view-file'
const TOOL = 'mcp__file-viewer__open_file'
// One drawing holds 100000 characters; leave room for the header.
const MAX_CHARS = 90_000
const MAX_HISTORY = 20
const MAX_RECENT = 8
const MAX_SESSION_FILES = 300
const MAX_LISTED = 150

// Change the tag when OpenedFile's fields change: it declines what an earlier
// version stored, which outlives a reload.
const opened = atom({ plugin: 'file-viewer', key: 'opened' } as const, null, {
  shape: 'opened-2',
})
const history = atom({ plugin: 'file-viewer', key: 'history' } as const, [])
const isRaw = atom({ plugin: 'file-viewer', key: 'isRaw' } as const, false)
const recent = atom({ plugin: 'file-viewer', key: 'recent' } as const, [])
const isBarHidden = atom({ plugin: 'file-viewer', key: 'isBarHidden' } as const, false)
const sessionFiles = atom({ plugin: 'file-viewer', key: 'sessionFiles' } as const, [])
const paneView = atom({ plugin: 'file-viewer', key: 'paneView' } as const, 'file')
const filesFilter = atom({ plugin: 'file-viewer', key: 'filesFilter' } as const, '')

// The tools whose calls put a file on the session's list, and what each did to it.
const TRACKED: Record<string, { field: 'file_path' | 'notebook_path'; action: SessionFile['action'] }> = {
  Read: { field: 'file_path', action: 'read' },
  Edit: { field: 'file_path', action: 'edited' },
  Write: { field: 'file_path', action: 'written' },
  NotebookEdit: { field: 'notebook_path', action: 'edited' },
}

const KINDS: Record<string, string> = {
  md: 'Markdown', mdc: 'Markdown', markdown: 'Markdown', ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', java: 'Java', json: 'JSON', sql: 'SQL', xml: 'XML', yml: 'YAML', yaml: 'YAML',
  properties: 'Properties', gradle: 'Gradle', kts: 'Kotlin', py: 'Python', ps1: 'PowerShell',
  sh: 'Shell', txt: 'Text', log: 'Log', html: 'HTML', css: 'CSS',
}

const isMarkdown = (path: string) => /\.(md|mdc|markdown)$/i.test(path)

const baseName = (path: string) => path.split(/[\\/]/).pop() || path

const folderOf = (path: string) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut < 0 ? '' : path.slice(0, cut + 1)
}

// One spelling per file: Windows paths ignore case and take either slash.
const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase()

const kindOf = (path: string) => {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()

  return ext === undefined ? 'File' : (KINDS[ext] ?? ext.toUpperCase())
}

// Accepts a path as people paste it: quoted, or starting with ~.
const cleanPath = async ($: EngineInterface, raw: string) => {
  const path = raw.trim().replace(/^["']+|["']+$/g, '')
  if (path !== '~' && !/^~[\\/]/.test(path)) {
    return path
  }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home === undefined ? path : home + path.slice(1)
}

// [[name]] links to name.md (or name itself) beside the file, as memory files use them.
const resolveLinks = async ($: EngineInterface, path: string, text: string) => {
  const links: Record<string, string> = {}
  for (const name of wikiNames(splitFrontmatter(text).body)) {
    const target = `${folderOf(path)}${isMarkdown(name) ? name : `${name}.md`}`
    if (await $.fs.exists(target).catch(() => false)) {
      links[name] = target
    }
  }

  return links
}

const load = async ($: EngineInterface, path: string): Promise<OpenedFile> => {
  try {
    const text = await $.fs.read(path)
    const isCut = text.length > MAX_CHARS
    const shown = isCut ? text.slice(0, MAX_CHARS) : text
    const links = isMarkdown(path) ? await resolveLinks($, path, shown) : {}

    return { path, text: shown, isCut, error: null, links }
  } catch (err) {
    return { path, text: '', isCut: false, error: readError(err), links: {} }
  }
}

const remember = async ($: EngineInterface, path: string) => {
  const list = await update($, recent, paths => [path, ...paths.filter(one => one !== path)].slice(0, MAX_RECENT))
  await $.store.set('recent', list).catch(() => undefined)
}

// Opens a path in the pane, remembering the one it replaces for Back.
// Never rejects: a command or tool call that throws would fail the person's turn.
const show = async ($: EngineInterface, path: string): Promise<OpenedFile> => {
  const file = await load($, path)
  try {
    const before = await read($, opened)
    if (before !== null && before.path !== file.path) {
      await update($, history, list => [...list, before.path].slice(-MAX_HISTORY))
    }
    await update($, opened, () => file)
    await update($, paneView, () => 'file')
    if (file.error === null) {
      await remember($, file.path)
    }
    await $.ui.open({ id: PANE, title: baseName(file.path) })
  } catch (err) {
    const error = `Could not open the pane: ${err instanceof Error ? err.message : String(err)}`

    return { ...file, error }
  }

  return file
}

// Puts a file at the top of the session's list. An edit outranks a read of the same
// file, so a file read after it was edited still shows EDITED.
const recordFile = async ($: EngineInterface, path: string, action: SessionFile['action']) => {
  await update($, sessionFiles, list => {
    const key = pathKey(path)
    const before = list.find(one => pathKey(one.path) === key)
    const kept = before !== undefined && action === 'read' ? before.action : action
    const rest = list.filter(one => pathKey(one.path) !== key)

    return [{ path, action: kept }, ...rest].slice(0, MAX_SESSION_FILES)
  })
}

const showFiles = async ($: EngineInterface) => {
  await update($, paneView, () => 'files')
  await $.ui.open({ id: PANE, title: 'Files' })
}

const palette = async ($: EngineInterface) => {
  const rows = await $.config.list().catch(() => [])

  return paletteFor(rows.find(row => row.key === 'theme')?.value)
}

const setBarHidden = async ($: EngineInterface, value: boolean) => {
  await update($, isBarHidden, () => value)
  await $.store.set('isBarHidden', value).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Open a file in a pane, even one outside the session folders: /view-file <path> (bare: this session's files and the bar)",
    })
    await $.tool.register({
      name: 'open_file',
      description:
        "Show a file to the user in the File viewer pane. Use it when the user wants to see a file the app's own file pane refuses (outside the session's folders), or asks to open or view a file.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path, or ~/...' } },
        required: ['path'],
      },
      isDeferred: false,
    })
    // What the bar showed last session; state starts empty in a new one.
    const saved = await $.store.get('recent').catch(() => undefined)
    if (Array.isArray(saved) && (await read($, recent)).length === 0) {
      const paths = saved.filter((one): one is string => typeof one === 'string').slice(0, MAX_RECENT)
      await update($, recent, () => paths)
    }
    if ((await $.store.get('isBarHidden').catch(() => undefined)) === true) {
      await update($, isBarHidden, () => true)
    }

    return next(e)
  })

  // Lists each file a Read, Edit, Write or NotebookEdit call touched, once the call succeeds.
  on('tool.call', async ($, e, next) => {
    const tracked = TRACKED[e.tool]
    if (tracked === undefined) {
      return next(e)
    }
    const ran = await next(e)
    const path = (e as unknown as Record<string, unknown>)[tracked.field]
    if (typeof path === 'string' && path !== '' && ran.deny === undefined && ran.isError !== true) {
      await recordFile($, path, tracked.action).catch(() => undefined)
    }

    return ran
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === '') {
      await setBarHidden($, false).catch(() => undefined)
      await showFiles($).catch(() => undefined)

      return { text: `Showing this session's files; the Files bar is above the prompt. Or run /${COMMAND} <path>.` }
    }
    const path = await cleanPath($, e.args).catch(() => e.args.trim())
    const file = await show($, path)

    return { text: file.error ?? `Opened ${file.path}` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { path: raw } = e as unknown as { path?: unknown }
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { deny: 'path is required' }
    }
    const path = await cleanPath($, raw).catch(() => raw.trim())
    const file = await show($, path)
    if (file.error !== null) {
      return { deny: `Could not read ${file.path}: ${file.error}` }
    }

    return { result: `Opened ${file.path} in the File viewer pane.` }
  })

  // The quick-open bar: this session's files and the files opened lately.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBarHidden))) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const paths = await read($, recent)
    const current = (await read($, opened))?.path
    const touched = (await read($, sessionFiles)).length
    const c = await palette($)

    // Room left beside Files, the label and Hide for the recent-file buttons, about a cell a letter.
    let room = Math.max(0, (e.props.bodyColumns ?? 80) - 32)
    const fitting = paths.filter(path => {
      const width = baseName(path).length + 4
      room -= width

      return room >= 0
    })

    const open = async (path: string) => {
      const file = await show($, path)
      if (file.error !== null) {
        await $.ui.toast(`Could not open ${baseName(file.path)}: ${file.error}`)
      }
    }

    return (
      <Box gap="sm" alignItems="center">
        <Button key="files" label={`Files (${touched})`} onPress={() => showFiles($)} />
        {fitting.length > 0 && (
          <Text size="footnote" weight="semibold" color={c.accent}>
            Recent
          </Text>
        )}
        {fitting.map((path, index) => (
          <Button key={`recent-${index}`} label={path === current ? `• ${baseName(path)}` : baseName(path)} onPress={() => open(path)} />
        ))}
        <Box flexGrow={1} />
        <Button
          key="hide-bar"
          label="Hide"
          onPress={async () => {
            await setBarHidden($, true)
            await $.ui.toast(`Files bar hidden. Type /${COMMAND} to bring it back.`)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Code, Markdown, Text } = table
    // The phone app draws no field yet; there the list goes unfiltered.
    const Input = 'Input' in table ? table.Input : undefined
    const file = await read($, opened)
    const c = await palette($)

    if (file === null || (await read($, paneView)) === 'files') {
      const files = await read($, sessionFiles)
      const filter = await read($, filesFilter)
      const words = filter.toLowerCase().split(/\s+/).filter(word => word !== '')
      const shown = files.filter(one => words.every(word => one.path.toLowerCase().includes(word)))
      const tagColor = { read: c.muted, edited: c.accent, written: c.success }

      return (
        <Box flexDirection="column" gap="md" paddingX="md" paddingY="md" backgroundColor={c.page} flexGrow={1} minHeight="100%">
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="semibold" color={c.accent}>
              THIS SESSION
            </Text>
            <Text size="title" weight="bold" color={c.strong}>
              Files
            </Text>
            <Text size="footnote" color={c.muted}>
              Files Claude read, edited or wrote in this session, newest first. Click one to open it.
            </Text>
            {file !== null && (
              <Box gap="xs" marginTop="xs">
                <Button key="to-file" label={`Back to ${baseName(file.path)}`} onPress={() => update($, paneView, () => 'file')} />
              </Box>
            )}
          </Box>

          {Input !== undefined && files.length > 0 && (
            <Input
              key="filter"
              value={filter}
              placeholder="Filter by name or folder"
              submitLabel="filter"
              onInput={(value: string) => update($, filesFilter, () => value)}
              onSubmit={(value: string) => update($, filesFilter, () => value)}
            />
          )}

          {files.length === 0 ? (
            <Box flexDirection="column" borderStyle="round" borderColor={c.border} backgroundColor={c.card} paddingX="md" paddingY="sm">
              <Text color={c.text}>No files yet.</Text>
              <Text size="footnote" color={c.muted}>
                Files appear here as Claude reads or edits them. To open any other file, run /{COMMAND} followed by its path.
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" borderStyle="round" borderColor={c.border} backgroundColor={c.card} paddingX="md" paddingY="sm" gap="xs">
              <Text size="caption" weight="semibold" color={c.muted}>
                {shown.length === files.length ? `${files.length} FILES` : `${shown.length} OF ${files.length} FILES`}
              </Text>
              {shown.length === 0 && <Text size="footnote" color={c.muted}>Nothing matches the filter.</Text>}
              {shown.slice(0, MAX_LISTED).map((one, index) => (
                <Box gap="sm" alignItems="center">
                  <Box width={8} flexShrink={0}>
                    <Text size="caption" weight="semibold" color={tagColor[one.action]}>
                      {one.action.toUpperCase()}
                    </Text>
                  </Box>
                  <Button key={`file-${index}`} label={baseName(one.path)} onPress={() => show($, one.path)} />
                  <Box flexGrow={1} flexShrink={1}>
                    <Text size="footnote" color={c.muted} wrap="truncate-start">
                      {folderOf(one.path)}
                    </Text>
                  </Box>
                </Box>
              ))}
              {shown.length > MAX_LISTED && (
                <Text size="caption" color={c.muted}>
                  {shown.length - MAX_LISTED} more: filter to narrow the list.
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const earlier = await read($, history)
    const isSource = (await read($, isRaw)) || !isMarkdown(file.path)
    const hrefs = Object.fromEntries(Object.entries(file.links).map(([name, path]) => [name, fileHref(path)]))
    const { properties, markdown } = previewParts(file.text, hrefs)
    const lead = properties?.find(([key]) => key === 'description')?.[1]
    const rows = (properties ?? []).filter(([key]) => key !== 'description')
    const keyWidth = Math.min(22, Math.max(8, ...rows.map(([key]) => key.length + 2)))

    const back = async () => {
      const previous = earlier[earlier.length - 1]
      if (previous === undefined) {
        return
      }
      await update($, history, list => list.slice(0, -1))
      const fresh = await load($, previous)
      await update($, opened, () => fresh)
      await $.ui.open({ id: PANE, title: baseName(previous) })
    }
    const reload = async () => {
      const fresh = await load($, file.path)
      await update($, opened, () => fresh)
    }
    const follow = async (link: { href: string }) => {
      const path = pathFromHref(link.href)
      if (path !== null) {
        await show($, path)
      }
    }

    return (
      <Box flexDirection="column" gap="md" paddingX="md" paddingY="md" backgroundColor={c.page} flexGrow={1} minHeight="100%">
        <Box flexDirection="column" gap="xs">
          <Text size="caption" weight="semibold" color={c.accent}>
            {kindOf(file.path).toUpperCase()}
          </Text>
          <Text size="title" weight="bold" color={c.strong}>
            {baseName(file.path)}
          </Text>
          <Text size="footnote" color={c.muted} wrap="truncate-start">
            {folderOf(file.path)}
          </Text>
          <Box gap="xs" marginTop="xs">
            <Button key="files" label="Files" onPress={() => showFiles($)} />
            {earlier.length > 0 && <Button key="back" label="Back" onPress={back} />}
            <Button key="reload" label="Reload" onPress={reload} />
            {isMarkdown(file.path) && (
              <Button key="raw" label={isSource ? 'Formatted' : 'Source'} onPress={() => update($, isRaw, value => !value)} />
            )}
          </Box>
        </Box>

        {file.error !== null && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={c.errorBorder}
            backgroundColor={c.errorCard}
            paddingX="md"
            paddingY="sm"
          >
            <Text weight="semibold" color={c.errorText}>
              Could not read the file
            </Text>
            <Text size="footnote" color={c.text}>
              {file.error}
            </Text>
          </Box>
        )}

        {file.error === null && !isSource && lead !== undefined && <Text color={c.muted}>{lead}</Text>}

        {file.error === null && !isSource && rows.length > 0 && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={c.border}
            backgroundColor={c.card}
            paddingX="md"
            paddingY="sm"
            gap="xs"
          >
            <Box gap="sm">
              <Box width={keyWidth} flexShrink={0}>
                <Text size="caption" weight="semibold" color={c.muted}>
                  PROPERTY
                </Text>
              </Box>
              <Text size="caption" weight="semibold" color={c.muted}>
                VALUE
              </Text>
            </Box>
            {rows.map(([key, value]) => (
              <Box gap="sm">
                <Box width={keyWidth} flexShrink={0}>
                  <Text size="footnote" weight="semibold" color={c.strong} wrap="truncate-end">
                    {key}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text size="footnote" color={c.text}>
                    {value}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {file.error === null &&
          (isSource ? (
            <Box borderStyle="round" borderColor={c.border} backgroundColor={c.code} paddingX="sm" paddingY="xs">
              <Code source={file.text} path={file.path} startLine={1} />
            </Box>
          ) : (
            <Markdown key="preview" text={markdown} onLinkPress={follow} pressableLinks={Object.values(hrefs)} />
          ))}

        {file.isCut && (
          <Text size="caption" color={c.muted}>
            Showing the first {MAX_CHARS.toLocaleString()} characters.
          </Text>
        )}
      </Box>
    )
  })
}
