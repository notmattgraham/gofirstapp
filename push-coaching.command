#!/bin/bash
cd "$HOME/Documents/Claude/Projects/GoFirstApp" || exit 1

echo "=== GoFirst push — $(date) ==="
echo ""

# Remove any stale locks
rm -f .git/*.lock 2>/dev/null

# Delete keepalive workflow — PAT doesn't have 'workflow' scope
rm -rf .github/workflows/keepalive.yml .github/workflows .github 2>/dev/null

# Mixed reset to origin/main: resets HEAD + index to remote, keeps working tree
echo "Squashing all unpushed commits into one..."
git fetch origin
git reset origin/main

# Stage everything (keepalive.yml is gone so it won't appear)
git add -A

# Single clean commit
git -c user.email=notmattgraham@gmail.com -c user.name="Matt Graham" \
    commit -m "Add coaching/chat: WebSocket messaging, coach inbox, dynamic tab layout for coaching clients"

echo ""
echo "Remote: $(git remote get-url origin)"
echo "Pushing..."
if git push -u origin main --force 2>&1; then
  echo ""
  echo "Pushed. Railway redeploys in ~30s."
  osascript -e 'display notification "Pushed to GitHub. Railway will redeploy." with title "GoFirst"' 2>/dev/null
else
  echo ""
  echo "Push failed — see output above."
fi

echo ""
read -n 1 -p "Press any key to close..."
