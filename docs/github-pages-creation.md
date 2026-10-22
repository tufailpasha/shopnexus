Create a GitHub Pages website for hosting a public video tutorial playlist.

Requirements:

- Pure HTML, CSS, and JavaScript.
- No build system.
- Works directly on GitHub Pages.
- Responsive design.
- Dark mode UI.
- Left sidebar playlist.
- Main video player area.
- No user authentication.
- No backend.

Video source:

Read playlist data from:

assets/videos/playlist.csv

CSV format:

title,gumlet_id,description
Introduction,abc123,Getting started
Installation,def456,Installation guide
Configuration,ghi789,System configuration

Behavior:

1. Load and parse playlist.csv on page load.
2. Populate the playlist sidebar.
3. Automatically load first video.
4. Clicking a playlist item loads the selected Gumlet video.
5. Highlight active video.
6. Show title and description below player.
7. Display video count.
8. Next and Previous buttons.
9. Keyboard navigation:
   - ← previous video
   - → next video

Video embedding:

Use Gumlet embed URL or you choose best:

https://play.gumlet.io/embed/{gumlet_id}

Example:

<iframe
  src="https://play.gumlet.io/embed/abc123"
  allowfullscreen>
</iframe>

Project structure:

/
├── index.html
├── assets/
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   └── app.js
│   └── videos/
│       └── playlist.csv

Features:

- Search box filtering playlist titles.
- Playlist scrolls independently.
- Active item remains visible.
- Mobile-friendly.
- Works without any framework.

Styling:

- Modern documentation website look.
- Dark theme.
- Sidebar width 320px.
- Rounded cards.
- Clean typography.
- Accent color #4f46e5.
- Hover effects.

GitHub Pages compatibility:

- Use only relative paths.
- No server-side code.
- No npm dependencies.
- No React/Vue/Angular.

Deliver complete code for:
- index.html
- assets/css/styles.css
- assets/js/app.js

Include comments explaining the main logic.

## As implemented (maintenance guide)

The site was implemented per the spec above, with the following notes for
future maintainers (full details live in the root `README.md`):

- **CSV schema.** The playlist file is a Gumlet export. The parser is
  header-driven and accepts either the minimal `title,gumlet_id,description`
  layout from this spec **or** the Gumlet export layout
  (`asset_id, title, status, playback_url, thumbnail_url, embed_url, tags,
  created_at, updated_at`). Column order is irrelevant; unknown columns are
  ignored.
- **Adding videos.** Append/replace rows in `assets/videos/playlist.csv`,
  commit, push — GitHub Pages redeploys automatically. No code changes.
- **Robustness.** HTTPS-only URL allow-list, RFC 4180 CSV parsing, debounced
  diacritic-insensitive search, deep links (`#video=<asset_id>`), theme
  toggle persisted in `localStorage`, and a 15 s embed watchdog with a
  direct-open fallback link.
- **Deployment.** Serve the repo root from GitHub Pages (main branch, `/`
  folder). A `404.html` is included; all asset paths are relative so a
  custom domain works without changes.
