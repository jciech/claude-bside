#!/usr/bin/env bash
echo '{"async":true,"asyncTimeout":30000}'

# Silently check if dependencies need updating
if [ ! -d "node_modules" ] || [ package.json -nt node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install --silent 2>&1 | grep -v "^npm WARN" || {
    echo "⚠️  Dependencies installation failed. Run: npm install"
  }
fi

# Check if .env file exists
if [ ! -f ".env" ]; then
  echo "⚠️  No .env file found. Create one with:"
  echo "    echo 'ANTHROPIC_API_KEY=sk-ant-your-key' > .env"
fi

# Check if API key is set
if [ -f ".env" ] && ! grep -q "ANTHROPIC_API_KEY=sk-ant-" .env 2>/dev/null; then
  echo "⚠️  ANTHROPIC_API_KEY not properly set in .env file"
fi

# Check if ports are available
if command -v lsof &> /dev/null; then
  if lsof -ti:3000 &> /dev/null; then
    echo "ℹ️  Port 3000 is already in use (backend)"
  fi
  if lsof -ti:5173 &> /dev/null; then
    echo "ℹ️  Port 5173 is already in use (frontend)"
  fi
fi

echo "✅ Session ready!"
echo ""
echo "Quick start:"
echo "  Terminal 1: npm run server:dev"
echo "  Terminal 2: npm run client"
echo "  Browser: http://localhost:5173"
