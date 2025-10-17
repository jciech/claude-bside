#!/usr/bin/env bash
# Scan for potential secrets before writing files

CONTENT="$1"

# Check for common secret patterns
if echo "$CONTENT" | grep -qE "(sk-ant-[a-zA-Z0-9_-]{20,})|(ANTHROPIC_API_KEY\s*=\s*sk-ant-)"; then
  echo "⚠️  WARNING: Detected potential API key in content!"
  echo "   Make sure you're not committing secrets to version control"
  echo "   API keys should only be in .env (which is gitignored)"
fi

# Check if writing to .env
if [ "$2" = ".env" ] || [ "$2" = "./.env" ]; then
  # .env is fine, it's gitignored
  exit 0
fi

exit 0
