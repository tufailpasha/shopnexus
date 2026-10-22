# ShopNexus Tutorials — Video Playlist

A fast, dependency-free video tutorial website for hosting a **public Gumlet-hosted
video playlist**. It is a pure HTML/CSS/JavaScript site — no frameworks, no build
step, no backend — and is designed to deploy as-is to **GitHub Pages**.

> **Status:** live-ready. The playlist currently contains **2 videos** and grows
> by editing a single CSV file. No code changes are required to add more videos.

---

## 1. Features

| Area | Capability |
| --- | --- |
| **Playlist** | Driven entirely by `assets/videos/playlist.csv` — add a row, push, done. |
| **Playback** | Videos stream through the Gumlet embed player (`play.gumlet.io`) in an `<iframe>`. |
| **Search** | Instant, debounced, diacritic-insensitive filtering across title, description, status and tags. |
| **Navigation** | Previous/Next buttons, keyboard `←` / `→`, and shareable deep links (`#video=<id>`). |
| **UX** | Dark UI by default with a persisted light-theme toggle, loading states, error recovery with retry, and a 15 s watchdog that offers a direct-open link if an embed is slow. |
| **Responsive** | 320 px sidebar on desktop, off-canvas drawer + top bar on mobile. |
| **Accessibility** | Keyboard operable, `aria-current`/`aria-live`, skip link, visible focus rings, reduced-motion support. |
| **Robustness** | RFC 4180 CSV parser, header-alias mapping, URL allow-listing, forgiving fallbacks for missing columns. |

## 2. Project structure

```
/
├── index.html               # Page shell (header, sidebar, player, controls)
├── 404.html                 # GitHub Pages custom 404
├── .nojekyll                # Tells Pages to serve the repo as static files
├── .editorconfig            # Shared editor conventions
├── .gitignore
├── LICENSE                  # GNU GPL v3
├── README.md
├── docs/
│   └── github-pages-creation.md   # Original spec + maintenance guide
└── assets/
    ├── favicon.svg
    ├── css/
    │   └── styles.css         # Theming via CSS custom properties (dark/light)
    ├── js/
    │   └── app.js             # All application logic (~600 lines, commented)
    └── videos/
        └── playlist.csv       # ← the playlist. Edit this file to add videos.
```

## 3. Running locally

There is nothing to install. Either open `index.html` directly, or serve the
directory so that `fetch()` works with a real origin:

```bash
# from the repository root
python3 -m http.server 8080
# → http://localhost:8080
```

> Opening `index.html` via `file://` still works in most browsers; serving over
> HTTP/HTTPS is recommended because some browsers restrict `fetch()` of local
> files from `file://` origins.

## 4. Adding videos (future-proofing)

The playlist scales indefinitely. Each row of `assets/videos/playlist.csv` is
one video.

### 4.1 Supported columns

The parser is **header-driven**, so column order does not matter and any subset
may be present. Recognised headers (case-insensitive, with aliases in
parentheses):

| Field | Headers accepted | Required? |
| --- | --- | --- |
| Unique id | `asset_id`, `gumlet_id`, `video_id`, `id`, `uuid` | No* |
| Title | `title`, `name`, `video_title`, `heading` | No |
| Description | `description`, `desc`, `summary`, `about`, `details` | No |
| Embed URL | `embed_url`, `embed`, `player_url` | No* |
| Thumbnail | `thumbnail_url`, `thumbnail`, `poster`, `image`, `thumb` | No |
| Status | `status`, `state` | No |
| Tags | `tags`, `tag`, `keywords` | No |
| Created | `created_at`, `created` | No |
| Updated | `updated_at`, `updated` | No |

\* At least one of **embed URL** or **Gumlet id** is required per row — the
embed URL defaults to `https://play.gumlet.io/embed/{gumlet_id}` when omitted.

### 4.2 What to paste

The current file is a **Gumlet export**, so the simplest workflow is:

1. In the Gumlet console, export the updated playlist to CSV.
2. Replace `assets/videos/playlist.csv` with the export.
3. Commit and push:

   ```bash
   git add assets/videos/playlist.csv
   git commit -m "playlist: add new tutorial(s)"
   git push
   ```

A minimal row in the classic three-column layout also works:

```csv
title,gumlet_id,description
Checkout flow,abc123,How to configure the checkout
```

and a **headerless** positional file (`title,gumlet_id,description` rows only)
is detected automatically.

### 4.3 Data quality rules

- **HTTPS only.** Embed URLs and thumbnails must use `https://`; anything else
  is dropped from the playlist (the row is skipped and a warning is logged).
- **Host allow-list.** Embeds are restricted to Gumlet plus major video
  providers (`assets/js/app.js` → `CONFIG.ALLOWED_EMBED_HOSTS`).
- **Duplicate ids.** Two rows sharing the same `asset_id` are treated as the
  same video for deep-linking purposes.
- **Status values** such as `generating-subtitles` are displayed as a status
  badge under the player — there is no gate on non-`ready` videos.

## 5. GitHub Pages deployment

1. Push the repository to GitHub (`origin` is already configured).
2. In the repository: **Settings → Pages → Build and deployment**
   → *Build and deploy from branch* → branch **`main`**, folder **`/ (root)`**.
3. Save. Pages publishes the site at `https://<user>.github.io/shopnexus/`
   (or `https://<user>.github.io/shopnexus` for a project page).

Every time you push a changed `playlist.csv`, Pages redeploys automatically.

### 5.1 Custom domain (optional)

1. Add a CNAME record pointing to the repository and create `CNAME` (containing
   the domain) in the repo root.
2. Under **Settings → Pages → Custom domain**, enable the domain and install
   the Let's Encrypt certificate.
3. Because all asset paths in the site are **relative**, no configuration
   changes are needed when you switch domains.

## 6. Usage & keyboard shortcuts

| Input | Effect |
| --- | --- |
| Click a playlist item | Plays that video and updates the share link. |
| `←` / `→` | Previous / next video (skipped while typing in a field). |
| `/` | Focus the search box. |
| `Esc` | Clear search focus / close the mobile drawer. |
| Theme button | Toggle dark ↔ light (remembered in `localStorage`). |
| URL hash | `https://…/shopnexus/#video=<asset_id>` opens a specific video. |

## 7. Security & hardening notes

- **No execution of CSV content.** Playlist cells are only ever written to the
  DOM through `textContent`; no `innerHTML` is fed untrusted data.
- **Embed allow-list.** Only HTTPS URLs on an allow-listed host are embedded,
  so a malformed CSV cannot load an arbitrary frame.
- **No external scripts.** The only network calls are the CSV `fetch` and the
  Gumlet player iframes — there are no CDN or analytics dependencies.
- **No PII.** No accounts, no cookies, no tracking; the only storage is the
  optional theme preference in `localStorage`.

## 8. Testing

There is no build system, so there is no test runner either. The parsing and
rendering pipeline (CSV → playlist → player) is exercised with a small Node
harness that stubs the DOM and asserts every format scenario:

```bash
node /tmp/opencode/test-app.js   # development helper, not committed
```

Manual checklist before pushing:

- [ ] Page loads and the first video autoplays.
- [ ] Search filters the sidebar and the counter reads “n of m videos”.
- [ ] `←`/`→` navigate; disabled state appears at the ends.
- [ ] Theme toggle persists across reloads.
- [ ] On mobile, the drawer opens/closes and the scrim closes it.
- [ ] Adding a new CSV row shows up after a hard refresh.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| “We could not load the playlist” | `playlist.csv` missing or a path case mismatch; check the file exists at `assets/videos/playlist.csv`. |
| Player spinner never resolves | The embed host is slow or the video is still processing; use the **Open video directly** link that appears after 15 s. |
| Some rows missing from the sidebar | Rows without a usable HTTPS embed URL are intentionally skipped; check the console for `[tutorials] Skipping row …`. |
| Blank page after rebranding the repo | GitHub Pages URL changed with the repo name; re-verify the deploy branch in Settings. |

## 10. License

Released under the **GNU General Public License v3** — see [LICENSE](LICENSE).
