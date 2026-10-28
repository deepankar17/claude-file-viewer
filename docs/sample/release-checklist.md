---
name: release-checklist
description: Steps to run before tagging a release of the mod
metadata:
  type: reference
  owner: maintainers
  modified: 2026-10-28T09:30:00.000Z
---

# Release checklist

Run these in the mod's folder before tagging a release. See [[changelog]] for what goes in the notes.

1. **Validate** the manifest and hooks module:
   ```bash
   claude plugin validate .
   ```
2. **Test** every surface the mod draws on:
   ```bash
   claude plugin test .
   ```
3. Bump `version` in `.claude-plugin/plugin.json`.

| Check | Command | Expected |
| --- | --- | --- |
| Manifest | `claude plugin validate .` | Validation passed |
| Tests | `claude plugin test .` | 0 fail |

> Tip: run `/reload-plugins` in open sessions after updating.
