#!/usr/bin/env bash
# Simple post-edit check - just provide helpful tips

FILE_PATH="$1"

# Check if editing JS files
if [[ "$FILE_PATH" == *.js ]]; then
  # Just a silent check - no formatter configured yet
  # Could add eslint or prettier here if added to project later
  :
fi

# Exit successfully - never block
exit 0
