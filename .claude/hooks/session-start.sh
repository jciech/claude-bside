#!/usr/bin/env bash
echo '{"async":true,"asyncTimeout":30000}'

if [ ! -d "node_modules" ] || [ package.json -nt node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install --silent 2>&1 | grep -v "^npm WARN" || {
    echo "⚠️  Dependencies installation failed. Run: npm install"
  }
fi

if [ ! -f ".env" ] || ! grep -q "^ANTHROPIC_API_KEY=sk-ant-" .env 2>/dev/null; then
  echo "ℹ️  No ANTHROPIC_API_KEY in .env — the room will run on the scripted autopilot."
fi

echo "✅ Session ready!"
echo ""
echo "  npm run dev        # server + client on http://localhost:3000"
echo "  npm test           # unit + integration tests"
echo "  npm run bside -- status"
