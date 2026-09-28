---
description: Show jevrail's recent guard decisions
argument-hint: "[count]"
allowed-tools: Bash(node:*)
---
Recent jevrail decisions (newest last):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/jevrail.mjs" log $ARGUMENTS`

Summarize these for the user in a few lines: which commands were asked about or blocked, and why. Do not rerun any of them.
