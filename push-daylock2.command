#!/bin/bash
cd "$HOME/Documents/Claude/Projects/GoFirstApp" || exit 1

echo "=== GoFirst — sync + push index.html — $(date) ==="
echo ""

rm -f .git/*.lock 2>/dev/null
echo "Lock files cleared."

echo ""
echo "Stashing local changes..."
git stash --include-untracked

echo ""
echo "Syncing with GitHub..."
git fetch origin main && git reset --hard origin/main
echo "Local repo now matches GitHub."

echo ""
echo "Restoring local changes..."
git stash pop

echo ""
echo "Staging only index.html..."
git add public/index.html

if git diff --cached --quiet 2>/dev/null; then
  echo "(no changes to index.html — nothing to commit)"
else
  echo "Committing..."
  git -c user.email=notmattgraham@gmail.com -c user.name="Matt Graham" \
      commit -m "Suspend day-lock UI: canEditDay always true, hide lock banner"

  echo ""
  echo "Pushing to GitHub..."
  if git push origin main 2>&1; then
    echo ""
    echo "Done! Railway will redeploy in ~30s."
    osascript -e 'display notification "index.html pushed. Railway redeploying." with title "GoFirst"' 2>/dev/null
  else
    echo ""
    echo "Push failed."
    osascript -e 'display dialog "Push failed — see Terminal for details." with title "GoFirst push" buttons {"OK"} with icon stop' 2>/dev/null
  fi
fi

echo ""
read -n 1 -p "Press any key to close..."
