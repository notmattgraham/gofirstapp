# GoFirst Privacy Policy

_Last updated: May 10, 2026_

GoFirst is a personal productivity and commitment-tracking app operated by GoFirst Brand. This policy describes what we collect, why, and how we handle it.

We try to keep this short and in plain language. If anything is unclear, email **help@gofirstbrand.com**.

## What we collect

When you sign in and use GoFirst, we store the following on our servers:

- **Account info from your sign-in provider.** When you sign in with Google or Apple, we receive your email address, name, and (from Google) profile picture. We use this to identify your account and address messages to you. With Apple's "Hide My Email" option, we receive a relay address instead of your real email; that works fine.
- **Profile information you enter.** Display name, profile picture you upload, free-form location string (e.g. "Austin, TX"), and the time of day you choose as your daily deadline.
- **Your tasks and quit-streaks.** Anything you add to your task list, recurring schedules, completion history, categories, notes, and the dates you've committed each day.
- **Messages.** Direct messages you send and receive in the app, including any image attachments you choose to send.
- **Free-form notes.** The persistent scratch pad on your profile tab.
- **Push subscription information.** If you turn on push notifications, your browser's push endpoint and encryption keys. We use these only to deliver notifications you've opted into.
- **Activity timestamps.** When you last opened the app (used to show "active now" / "5m ago" status to your friends), and lightweight timestamps so we can throttle reminders.
- **Timezone.** Detected from your browser, used so the day-end deadline math runs in your local time.

We do **not** collect:

- Your physical location, GPS coordinates, or IP-derived location.
- Browsing history outside of GoFirst.
- Contacts, calendars, photos other than what you explicitly upload, or any device-level data.
- Any data for advertising. We do not run ads.

## How we use what we collect

- To run your account and your task list.
- To deliver direct messages between you and other users you choose to connect with.
- To send push notifications you've enabled (deadline reminders, new messages, friend requests, daily reengagement nudges if you haven't opened the app in 24 hours).
- To show your friends the lightweight presence and progress indicators you both opted into when adding each other (current day's execution rate, last-seen timestamp, weekly progress bar).
- To let other users find you by name or by the city/state you've entered in your profile.

We do **not** sell your data, share it with advertisers, or send it to third-party analytics services.

## Who can see what

- **Your tasks, streaks, notes, and messages** are visible only to you, except:
  - A coach you opt into can see your tasks and analytics. You start that relationship by tapping the Get-a-coach offer in the app or by being marked as a coaching client by the admin.
  - The app-wide admin can see basic per-user analytics from a private dashboard.
- **Your display name, profile picture, location string, and last-seen timestamp** are visible to other authenticated users in friend search and friends lists. This is the data needed to make the social features (friends, DMs, "find people in my area") work.
- **Your email address** is never shown to other users. It's used only by you to sign in.

## Subprocessors

We use the following third-party services to run GoFirst:

- **Railway** — hosts the application server and PostgreSQL database (where your data is stored).
- **Google** — authentication via Sign in with Google.
- **Apple** — authentication via Sign in with Apple.
- **Stripe** — payment processing for the coaching subscription, used only if you choose to purchase coaching. We do not handle or store payment card information ourselves.

We do not use third-party analytics, error reporting, advertising, or behavioral-tracking services.

## Data retention and deletion

You can delete your account at any time by emailing **help@gofirstbrand.com**. We will delete:

- Your user record
- Every task, streak, message, friendship, and push subscription tied to your account

Cascading deletion is configured at the database level, so the deletion is irreversible. We complete account deletion within 30 days of receiving the request.

We do not retain backups indefinitely; database backups are rolling and expire on Railway's standard schedule (typically within 30 days).

## Children

GoFirst is not directed at children under 13. We do not knowingly collect data from anyone under 13. If you believe a child has provided us data, email help@gofirstbrand.com and we'll delete it.

## Security

Authentication runs through Google's and Apple's OAuth flows. We do not store passwords. Session cookies are signed and transmitted over HTTPS only. Database backups are encrypted at rest on Railway's infrastructure.

We do our best, but no system is perfectly secure. If you suspect unauthorized access to your account, email help@gofirstbrand.com.

## Changes

We may update this policy over time. Material changes will be announced in the app via the system-broadcast feature.

## Contact

Questions, complaints, or deletion requests: **help@gofirstbrand.com**
