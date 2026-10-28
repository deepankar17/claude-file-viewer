export type OpenedFile = {
  path: string
  text: string
  isCut: boolean
  error: string | null
  // [[name]] in the file -> the path of the sibling file it names, when there is one.
  links: Record<string, string>
}

// A file Claude touched with a tool in this session; `action` is the last thing done to it.
export type SessionFile = {
  path: string
  action: 'read' | 'edited' | 'written'
}

declare module 'claude-code' {
  interface PluginState {
    'file-viewer': {
      opened: Shaped<OpenedFile | null>
      // Paths opened before this one, newest last, for Back.
      history: string[]
      // Markdown shown as source instead of formatted.
      isRaw: boolean
      // Files opened lately, newest first; kept across sessions in $.store.
      recent: string[]
      // The quick-open bar above the prompt is hidden; kept across sessions.
      isBarHidden: boolean
      // Files touched by Read, Edit, Write and NotebookEdit this session, newest first.
      sessionFiles: SessionFile[]
      // What the pane shows: the open file, or the session's file list.
      paneView: 'file' | 'files'
      // The file list's filter text.
      filesFilter: string
    }
  }
}
