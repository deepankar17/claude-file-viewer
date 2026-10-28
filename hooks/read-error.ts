// $.fs.read rejects with the call and the OS errno ("$.fs.read(C:\a.md) failed: ENOENT");
// say what that means instead.
export const readError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  if (/\bENOENT\b/.test(message)) {
    return 'The file is not there any more: it was deleted or moved, or its folder (a removed worktree, say) is gone.'
  }
  if (/\b(EACCES|EPERM)\b/.test(message)) {
    return 'You do not have permission to read this file.'
  }
  if (/\bEISDIR\b/.test(message)) {
    return 'This is a folder, not a file.'
  }

  return message
}
