#!/bin/bash
cd "$HOME/Documents/Claude/Projects/GoFirstApp" || exit 1

echo "=== GoFirst — suspend day-lock push — $(date) ==="
echo ""

rm -f .git/*.lock 2>/dev/null
echo "Lock files cleared."

echo "Staging changes..."
git add -A

if git diff --cached --quiet 2>/dev/null; then
  echo "(nothing new to commit — already up to date)"
else
  echo "Committing..."
  git -c user.email=notmattgraham@gmail.com -c user.name="Matt Graham" \
      commit -m "Suspend day-lock UI: canEditDay always true, hide lock banner"
fi

echo ""
echo "Pushing to GitHub..."
if git push -u origin main --force 2>&1; then
  echo ""
  echo "Done. Railway will redeploy in ~30s."
  osascript -e 'display notification "Pushed day-lock suspension. Railway redeploying." with title "GoFirst"' 2>/dev/null
else
  echo ""
  echo "Push failed — check credentials."
  osascript -e 'display dialog "Push failed — see Terminal for details." with title "GoFirst push" buttons {"OK"} with icon stop' 2>/dev/null
fi

echo ""
read -n 1 -p "Press any key to close..."
