# Libris Focus Tracker

Libris is an open-source, installable study tracker hosted entirely on GitHub Pages. Your study records stay in this browser using IndexedDB. No login, backend account, database subscription, or API keys are required.

Live site: <https://florencewmk.github.io/libris-focus-tracker/>

## Features

- Library, café, campus, home, or custom-address check-ins
- Google Maps links for every location
- Focus timer with pause/resume, saved history, and seven-day totals
- Local records that survive closing and reopening the app
- JSON backup export and import
- Installable PWA for iPhone and Android
- Offline use after the app has finished downloading on an online visit
- Existing responsive Roboto interface

## Your records and backups

Records are saved on this device in the current browser. They do not sync automatically between devices or between different browsers. GitHub hosts the app files; it does not receive or back up your study records. Clearing site data, removing a browser profile, or a browser reclaiming storage can erase local records. Private browsing may not retain records after the session ends.

Use **Protect local saves** to request protection against automatic browser storage cleanup; the browser decides whether to grant it. On iPhone or iPad, add Libris to the Home Screen and open that installed app: Home Screen web apps are exempt from Safari's seven-day inactivity cleanup of website storage. See [WebKit's storage policy](https://webkit.org/tracking-prevention/). Keep backups even when protection is granted.

Use **Export backup** regularly and save the downloaded JSON file somewhere you keep backups. Use **Import backup** on this or another device to add those records. Import merges records by their IDs; importing the same file twice does not duplicate them. Invalid files are rejected before any records are written. If the same record already exists, the imported copy replaces it.

Only import backups you intend to keep. If a timer is running, stop it before importing. Export/import is a manual way to move records between devices, not live synchronization.

Use one Libris tab or installed window at a time. A second open copy asks you to close the first and reload, so two timers cannot overwrite each other's saved progress.

The versioned JSON format is:

```json
{
  "format": "libris-backup",
  "version": 1,
  "exported_at": "2026-11-12T12:00:00.000Z",
  "study_sessions": [],
  "library_check_ins": []
}
```

## Moving existing cloud records

Earlier releases used Supabase. Those records remain in that project and are not automatically copied into browser storage. If the project is paused, restore access there before exporting its data. Do not delete the old project until you have saved and checked a backup.

Export your own rows from the `study_sessions` and `library_check_ins` tables as JSON, then combine the arrays into one file:

```json
{
  "study_sessions": [],
  "library_check_ins": []
}
```

Replace the empty arrays with the exported rows, retaining fields such as `id`, `location`, `subject`, timestamps, and `duration_seconds`. Import that file in Libris. The importer accepts this older table wrapper and normalizes the former account IDs to local records. Keep your exported backup private; do not commit personal records to the repository.

## Local setup

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev
```

No environment variables or database setup are needed. The development URL and GitHub Pages URL have separate browser storage. The service worker is used only in production builds.

## GitHub Pages deployment

The included `.github/workflows/deploy.yml` builds and deploys the app whenever `main` changes. In repository **Settings → Pages**, choose **GitHub Actions** as the source. The workflow needs no provider secrets; any old Supabase Actions secrets can be removed.

```bash
pnpm build
pnpm preview
```

The build output is `dist/`, and the configured Pages base path is `/libris-focus-tracker/`. Changing the repository path requires updating `vite.config.ts` and `public/manifest.webmanifest`. Changing the host or browser creates a separate local data location, so export first and import at the new address.

Production builds precache the HTML, JavaScript, CSS, manifest, and local icons as one version. Keep the first online visit open long enough for this download to finish before relying on offline use. Updates become active after closing all open Libris tabs and the installed app, then reopening it. Google Maps and the optional Google-hosted font still require internet; the interface uses a system font when that font is unavailable.

## Install on a phone

- iPhone: open the deployed URL in Safari, tap Share, then **Add to Home Screen**.
- Android: open the URL in Chrome and choose **Install app**.

## License

[MIT](LICENSE) — use, modify, and publish it freely.
