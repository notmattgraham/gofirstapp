# App Store listing — GoFirst

Draft copy + assets checklist for App Store Connect submission. Edit
freely before submission. Reviewers care most about an honest, plain
description; flowery marketing copy actually hurts your odds.

---

## App name

**GoFirst** (30 char limit)

## Subtitle

**Daily commitment, not to-dos** (30 char limit)

Alternatives if the above doesn't land:
- _Plan tomorrow, execute today_
- _Commit. Execute. Repeat._

## Promotional text

(170 char limit — can be updated without re-submission)

Plan tomorrow's tasks today. Commit and lock the list. Execute before your day-end deadline. Track what you actually did vs. what you said you would.

## Description

(4000 char limit — body of the listing)

GoFirst is a commitment device. It works on one rule: plan your tasks the day before, lock the list when you commit, and execute before your day ends.

No more reshuffling priorities mid-morning. No more endless to-do lists you'll never finish. Once you commit, the list is closed. What you complete by your deadline counts. What you don't, doesn't.

**How it works**

- Plan your list the night before
- Tap Commit when it's the list you'll actually execute
- The list is locked — you can't add or remove tasks once committed
- Mark tasks complete throughout your day
- At your daily deadline, the day rolls over. Whatever you finished counts. Whatever you didn't is a miss.

**Built for real days**

- Set your own day-end time — works for night-shift workers, late risers, anyone whose day isn't a 9-to-5
- Recurring tasks for habits (daily, weekly, custom days of week)
- Quit-streaks to track days since you stopped a bad habit
- Push reminders at 2 hours and 1 hour before your deadline

**Track what's actually happening**

- Daily execution rate (completed vs scheduled)
- Per-category analytics so you see where you're winning and where you're falling off
- Week-at-a-glance heatmap
- Streak rankings across your recurring tasks

**Friends, lightweight**

- Add friends by name or location to see each other's daily execution and stay accountable
- Direct messages with friends
- Optional 1:1 coaching from a real person who can see your task list and reply

GoFirst is free to use. Optional coaching subscription available via gofirstbrand.com.

---

## Keywords

(100 char limit, comma-separated, no spaces around commas — most influential field for App Store search)

```
productivity,goals,habits,focus,discipline,planner,accountability,routine,commitment,streaks
```

## App category

- Primary: **Productivity**
- Secondary: **Lifestyle**

## Support URL

`https://gofirstbrand.com/support` _(create this page before submission — a simple "email help@gofirstbrand.com" page is enough)_

## Marketing URL

`https://gofirstbrand.com` _(optional but recommended)_

## Privacy policy URL

`https://gofirstbrand.com/privacy` _(host the PRIVACY.md content from this repo at that URL)_

---

## What's new (for v1.0 release notes)

```
First release. Plan tomorrow's tasks, commit and lock the list, execute before your deadline. Recurring tasks, quit-streaks, friend accountability, and optional 1:1 coaching.
```

---

## App Review Information

### Sign-in account for the review team

```
review-account@gofirstbrand.com   <-- create a real test account before submission
Password: (we use Google + Apple OAuth — provide a working Google account)
```

### Contact

- First name: Matt
- Last name: Graham
- Phone: (your number)
- Email: help@gofirstbrand.com

### Notes for the reviewer

```
GoFirst is a commitment-device productivity app. Sign in with Apple or Google to begin.
On first sign-in, the user completes a short commitment ritual (4 steps) before reaching
the main task interface. The reviewer can use the test account above to skip directly
to the post-onboarding state.

The app does not offer any in-app purchases. The optional coaching subscription is sold
exclusively on the web at gofirstbrand.com (not linked from inside the iOS app).

Direct messaging is between users who have explicitly added each other as friends. No
broadcast, no anonymous messaging, no spam vectors.
```

---

## Privacy "nutrition" label (App Privacy section)

Data collected and linked to the user:

- **Contact Info → Email Address**
  - Used for: App functionality (sign-in), Customer support
- **Contact Info → Name**
  - Used for: App functionality (display + friend search)
- **User Content → Photos**
  - Used for: App functionality (profile picture only, uploaded by user)
- **User Content → Other User Content** (tasks, notes, messages)
  - Used for: App functionality
- **Identifiers → User ID**
  - Used for: App functionality
- **Usage Data → Other Usage Data** (last-seen timestamp)
  - Used for: App functionality (friend presence indicator)
- **Location → Coarse Location** _(free-form city/state string user enters; opt-in)_
  - Used for: App functionality (friend search by area)

Data not collected:

- Financial info (payment is handled by Stripe directly, never touches our servers)
- Precise location, contacts, calendars, browsing history, search history, fitness, health, sensitive info, diagnostics, advertising data

---

## Asset checklist

### App icons

- [ ] 1024 × 1024 (App Store Connect listing — no transparency, no rounded corners)
- [ ] All in-app sizes generated from the 1024 (Xcode handles this automatically from a single `AppIcon.appiconset/AppIcon-1024.png`)

Source available in repo: `public/applogo.svg` — verify it renders cleanly at 1024px before committing the icon. If it doesn't, we'll need a higher-res raster.

### Screenshots

Required: at least one screenshot for each of these device classes.

- [ ] 6.7" iPhone (iPhone 15 Pro Max, etc.) — 1290 × 2796 portrait
- [ ] 6.1" iPhone (iPhone 15, etc.) — optional if you cover 6.7"
- [ ] iPad — if app supports iPad

Recommended screen ideas (one per shot, with a single piece of overlay text):

1. **Tasks list mid-day** with the "X tasks left" pill highlighted — caption: "Plan it. Commit it. Execute it."
2. **The commit ceremony** post-commit (green check + "Committed.") — caption: "The list is locked. Now go."
3. **Analytics tab** with the ring + week heatmap — caption: "See what you actually did."
4. **Social tab** with friends' rings + DMs — caption: "Friends keep you honest."
5. **Profile** with day-end time + location set — caption: "Built for your hours, not anyone else's."

### App preview video (optional, 15-30s)

Not required for v1.0. Skip.

---

## Pre-submission checklist

- [ ] Apple Developer Program enrolled & paid
- [ ] Bundle identifier registered in Apple Developer Portal (`com.gofirstbrand.app`)
- [ ] App ID + Services ID created (Services ID is the `APPLE_CLIENT_ID` for Sign in with Apple — typically `com.gofirstbrand.web`)
- [ ] Sign in with Apple key (.p8 file) downloaded — only needed if/when we exchange the code for tokens. For our setup (verifying the id_token from the form-post) we only need APPLE_CLIENT_ID
- [ ] Return URLs configured at Apple: `https://gofirstbrand.com/api/auth/apple/callback` (or wherever Railway is hosted)
- [ ] Privacy policy hosted at a public URL
- [ ] Support page hosted at a public URL
- [ ] Test account created on production for reviewers
- [ ] Production env vars set on Railway: `APPLE_CLIENT_ID`, `BASE_URL` (must be the public origin — not `localhost`), all existing keys
- [ ] App icons generated at 1024×1024 (no transparency)
- [ ] Screenshots produced for required device classes
- [ ] App Store Connect listing filled (name, subtitle, description, keywords, categories)
- [ ] TestFlight build uploaded
- [ ] Internal tester (you) confirms sign-in + sign-out + task flow work on TestFlight
- [ ] Submit for review
