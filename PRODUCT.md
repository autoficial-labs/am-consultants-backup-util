# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop app for Windows, and macOS, built with Tauri: the UI is web technology inside a native window, so it follows web design rules within desktop conventions such as a window frame, tray icon and native folder pickers.)

## Stack

Delegated: Tauri 2 (Rust backup engine) + React + Fluent UI React v9 for the UI; Cloudflare Worker API with D1 (accounts, permissions, file index) and R2 (file data, archives). Chosen for a small install size (~10 MB), native performance for hashing/compression, and Fluent 2 as the requested design language.

## Users

- **Primary: office staff at AM True Tax** (accountants, office managers): not IT people. They set the folder once, glance at the dashboard to confirm backups are happening, and restore files when something goes wrong, often under stress ("Tally data got corrupted this afternoon").
- **Secondary: staff with restricted accounts** who can only see or restore the client folders the administrator shares with them; some may also back up their own copies (write access).

## Product Purpose

AM Backup keeps a Tally data folder continuously backed up to Cloudflare and makes it easy to get back to any earlier moment. Success: nobody at the office ever loses a day of Tally work, and restoring takes minutes without calling for help.

## Positioning

Backup built around how Tally behaves: it waits for Tally to close before reading company files (so copies are never half-written), keeps every change so a restore can rewind to "2 hours ago", and shows exactly what a restore will change before it touches anything.

## Operating Context

- Tally (both TallyPrime and Tally.ERP 9 are in use or possible) keeps company data in a data folder with one subfolder per company (numeric names like `10001`); files such as `Company.900` / `.1800`, `TranMgr`, `LinkMgr`.
- Tally holds files open while it runs; reading them mid-write gives corrupt copies.
- The app runs in the background with a tray icon, starts with Windows, and is opened mainly to check status or restore.
- One super-admin account manages users, folder sharing, schedules and restores.

## Capabilities and Constraints

- Incremental backups of new/changed/deleted files; content-addressed and de-duplicated in R2.
- Complete backups: whole folder as one highly compressed archive on a schedule (zstd up to level 19). No encryption (confirmed by the client).
- Point-in-time restore (presets 2/4/6/8 hours and custom), restore of any complete backup from history, choice of restore destination, visual comparison before restoring.
- Users: read-only or read & write; folder scope = everything / only selected / all except selected / nothing; revoke access instantly.
- Local testing with Localflare; production deployment is configurable.

## Brand Commitments

- Product name on screen and in the Start menu: **AM Backup**.
- About section must credit **"Developed by AFLABS"** linking to autoficial.ltd.
- Visual language: Microsoft Fluent 2 (binding, requested by the client).

## Evidence on Hand

No testimonials, customer logos or performance claims exist; do not invent any.

## Product Principles

1. **Calm confidence.** The first thing anyone sees answers "are my files safe?" in one glance.
2. **Choices, not blanks.** Prefer pickers, presets, toggles and trees over typed fields; type only what cannot be chosen.
3. **Show before you change.** Every restore previews exactly what will be added, replaced or removed.
4. **Never surprise Tally.** Respect open files; warn plainly when Tally is running.
5. **Plain words.** Speak like a helpful colleague, not a sysadmin.

## Accessibility & Inclusion

Keyboard operable throughout, WCAG AA contrast in light and dark themes, status never conveyed by color alone, respects reduced motion and Windows text scaling.
