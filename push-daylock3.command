#!/bin/bash
cd "$HOME/Documents/Claude/Projects/GoFirstApp" || exit 1

echo "=== GoFirst — push index.html only — $(date) ==="
echo ""

rm -f .git/*.lock 2>/dev/null
echo "Lock files cleared."

# Save the new index.html content from the local commit
echo "Saving new index.html from local commit..."
git show HEAD:public/index.html > /tmp/gofirst_index_new.html 2>/dev/null || {
  echo "No local commit found, using working tree copy..."
  cp public/index.html /tmp/gofirst_index_new.html
}

# Sync local repo to match GitHub exactly
echo "Syncing with GitHub (this removes local commits that can't be pushed)..."
git fetch origin main 2>&1
git reset --hard origin/main 2>&1
echo "Synced. Now at: $(git log --oneline -1)"

# Restore the new index.html
echo "Restoring updated index.html..."
cp /tmp/gofirst_index_new.html public/index.html

# Check if there's actually a diff
if git diff --quiet public/index.html; then
  echo "(index.html is already up to date on GitHub — nothing to push)"
else
  echo "Changes detected. Committing index.html..."
  git add public/index.html
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
    osascript -e 'display dialog "Push failed." with title "GoFirst" buttons {"OK"} with icon stop' 2>/dev/null
  fi
fi

echo ""
read -n 1 -p "Press any key to close..."
