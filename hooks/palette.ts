// Slate palette, after the release-changes artifact: navy page, lighter cards
// with hairline borders, one blue accent, grey labels. A light twin for light themes.

export type Palette = {
  page: string
  card: string
  code: string
  border: string
  strong: string
  text: string
  muted: string
  accent: string
  success: string
  errorBorder: string
  errorCard: string
  errorText: string
}

const DARK: Palette = {
  page: '#131a24',
  card: '#171f2b',
  code: '#0e131b',
  border: '#283244',
  strong: '#e8ecf2',
  text: '#c9d1dc',
  muted: '#8e99ab',
  accent: '#79a8ff',
  success: '#6fd3a0',
  errorBorder: '#7f2d3a',
  errorCard: '#26161b',
  errorText: '#ff8f8f',
}

const LIGHT: Palette = {
  page: '#f7f9fc',
  card: '#ffffff',
  code: '#f1f4f8',
  border: '#d6dde7',
  strong: '#141b26',
  text: '#2a3443',
  muted: '#5f6b7c',
  accent: '#2f6fdb',
  success: '#1f8a57',
  errorBorder: '#e3a4ad',
  errorCard: '#fdf1f2',
  errorText: '#b4232f',
}

// Claude Code's theme setting (`dark`, `light-daltonized`, ...); anything not named light is dark.
export const paletteFor = (theme: unknown): Palette =>
  typeof theme === 'string' && theme.toLowerCase().includes('light') ? LIGHT : DARK
