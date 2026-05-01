#!/bin/bash
cd "$HOME/Documents/Claude/Projects/GoFirstApp" || exit 1

echo "=== Git status ==="
git log --oneline -3
echo ""
echo "=== Remote ==="
git remote -v
echo ""
echo "=== Attempting push with verbose output ==="
GIT_TERMINAL_PROMPT=1 git push origin main --force --verbose 2>&1
echo ""
echo "Exit code: $?"
echo ""
read -n 1 -p "Press any key to close..."
