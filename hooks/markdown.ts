// Turns a markdown file into what a markdown preview shows: the YAML
// frontmatter as a table instead of a stray heading, and [[wiki-links]] as links.

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const WIKI_LINK = /\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g

export const splitFrontmatter = (text: string) => {
  const match = FRONTMATTER.exec(text)

  return match
    ? { front: match[1] ?? '', body: text.slice(match[0].length) }
    : { front: null, body: text }
}

const unquote = (raw: string) => {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }

  return value
}

// Flattens simple YAML (nested maps, lists of scalars) to dotted rows; null for
// anything richer, which is then shown as a yaml block instead.
export const frontmatterRows = (front: string): [string, string][] | null => {
  const rows: [string, string][] = []
  const parents: { indent: number; key: string }[] = []

  for (const line of front.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item) {
      const last = rows[rows.length - 1]
      if (last === undefined) {
        return null
      }
      const value = unquote(item[1] ?? '')
      last[1] = last[1] === '' ? value : `${last[1]}, ${value}`
      continue
    }
    const pair = /^(\s*)([^:#\s][^:#]*?):(?:\s+(.*))?$/.exec(line)
    if (pair === null) {
      return null
    }
    const indent = pair[1]?.length ?? 0
    while (parents.length > 0 && (parents[parents.length - 1]?.indent ?? 0) >= indent) {
      parents.pop()
    }
    const name = pair[2] ?? ''
    const key = [...parents.map(parent => parent.key), name].join('.')
    const value = pair[3] ?? ''
    if (value.trim() === '') {
      parents.push({ indent, key: name })
    }
    rows.push([key, unquote(value)])
  }

  // A key that only holds nested keys has no row of its own.
  return rows.filter(([key, value]) => value !== '' || !rows.some(([other]) => other.startsWith(`${key}.`)))
}

export const wikiNames = (body: string) => [
  ...new Set([...body.matchAll(WIKI_LINK)].map(match => (match[1] ?? '').trim())),
]

// Links each [[name]] that has a target; the rest stay as written.
export const linkWikiNames = (body: string, hrefs: Readonly<Record<string, string>>) =>
  body.replace(WIKI_LINK, (whole, name: string, label: string | undefined) => {
    const href = hrefs[name.trim()]

    return href === undefined ? whole : `[${(label ?? name).trim()}](${href})`
  })

export const fileHref = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const encoded = encodeURI(slashed).replace(/[()#?]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

  return /^[A-Za-z]:/.test(slashed) ? `file:///${encoded}` : `file://${encoded}`
}

export const pathFromHref = (href: string) => {
  if (!/^file:/i.test(href)) {
    return null
  }
  const path = decodeURIComponent(href.replace(/^file:\/*/i, ''))

  return /^[A-Za-z]:/.test(path) ? path.replace(/\//g, '\\') : `/${path}`
}

// ISO timestamps (2026-10-28T07:15:42.382Z) read as 28 Oct 2026, 07:15 UTC.
export const readableValue = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::[\d.]+)?Z$/.exec(value)
  if (match === null) {
    return value
  }
  const [, year, month, day, hour, minute] = match
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  return `${Number(day)} ${months[Number(month) - 1] ?? month} ${year}, ${hour}:${minute} UTC`
}

// The frontmatter as rows for the pane to draw, and the body as markdown. Frontmatter
// too rich for rows stays in the markdown as a yaml block.
export const previewParts = (text: string, hrefs: Readonly<Record<string, string>>) => {
  const { front, body } = splitFrontmatter(text)
  const markdown = linkWikiNames(body, hrefs)
  if (front === null) {
    return { properties: null, markdown }
  }
  const rows = frontmatterRows(front)
  if (rows === null || rows.length === 0) {
    return { properties: null, markdown: `\`\`\`yaml\n${front}\n\`\`\`\n\n${markdown}` }
  }

  return { properties: rows.map(([key, value]): [string, string] => [key, readableValue(value)]), markdown }
}
