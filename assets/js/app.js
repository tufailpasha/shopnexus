/*!
 * ShopNexus Tutorials — playlist player
 * ===========================================================================
 * A dependency-free, build-free front-end for a Gumlet-hosted video playlist.
 *
 * How it works
 *   1. CONFIG      — every tunable constant in one place.
 *   2. CSV parser  — RFC 4180 compliant (quoted fields, escaped quotes,
 *                    embedded commas/newlines, UTF-8 BOM tolerant).
 *   3. Normaliser  — maps the playlist columns onto one internal video model,
 *                    so both the Gumlet export layout and the minimal
 *                    "title,gumlet_id,description" layout are supported.
 *   4. State       — one small state object is the single source of truth.
 *   5. Renderers   — pure-ish functions that turn state into DOM.
 *   6. Actions     — user intents (select / search / navigate / theme).
 *
 * Extending the playlist only ever means adding rows to
 * assets/videos/playlist.csv — no code change required.
 *
 * @license GPL-3.0-or-later
 */

(function () {
  "use strict";

  /* ======================================================================
   * 1. Configuration
   * ==================================================================== */
  const CONFIG = {
    /** Location of the playlist source (relative → works on any Pages path). */
    CSV_URL: "assets/videos/playlist.csv",

    /** Fallback embed URL template, used when a row has no explicit embed URL. */
    EMBED_BASE: "https://play.gumlet.io/embed/",

    /**
     * Hosts that are allowed to be embedded. Anything else is rejected so a
     * malformed or hostile CSV cannot inject an arbitrary frame.
     */
    ALLOWED_EMBED_HOSTS: [
      "gumlet.io",
      "gumlet.com",
      "youtube.com",
      "youtube-nocookie.com",
      "vimeo.com",
      "player.vimeo.com",
      "dailymotion.com",
      "dai.ly",
    ],

    /** localStorage key used to remember the colour theme. */
    THEME_STORAGE_KEY: "shopnexus.tutorials.theme",

    /** Hash format used for shareable deep links, e.g. "#video=<asset id>". */
    HASH_PREFIX: "#video=",

    /** Debounce delay (ms) for the search box. */
    SEARCH_DEBOUNCE_MS: 150,

    /** How long to wait for the embedded player before offering a fallback link. */
    EMBED_LOAD_TIMEOUT_MS: 15000,
  };

  /**
   * Accepted column aliases. The first match wins, so the most specific
   * names are listed first. Matching is case-insensitive and underscore
   * based; a fuzzy "contains" pass is used as a last resort.
   */
  const COLUMN_ALIASES = {
    uid: ["asset_id", "gumlet_id", "video_id", "id", "uuid"],
    title: ["title", "name", "video_title", "heading"],
    description: ["description", "desc", "summary", "about", "details"],
    embedUrl: ["embed_url", "embed", "player_url"],
    thumbnailUrl: ["thumbnail_url", "thumbnail", "poster", "image", "thumb"],
    status: ["status", "state"],
    tags: ["tags", "tag", "keywords"],
    createdAt: ["created_at", "created"],
    updatedAt: ["updated_at", "updated"],
  };

  /** Header used when the CSV ships without a header row. */
  const FALLBACK_HEADER = ["title", "gumlet_id", "description"];

  /* ======================================================================
   * 2. DOM references
   * ==================================================================== */
  const $ = (selector, scope) => (scope || document).querySelector(selector);

  const els = {
    player: $("#player"),
    overlayText: $("#player-overlay-text"),
    spinner: $("#player-spinner"),
    retryButton: $("#retry-button"),
    playlistList: $("#playlist-list"),
    playlistEmpty: $("#playlist-empty"),
    videoCount: $("#video-count"),
    searchInput: $("#search-input"),
    searchClear: $("#search-clear"),
    videoTitle: $("#video-title"),
    videoPosition: $("#video-position"),
    videoDescription: $("#video-description"),
    videoBadges: $("#video-badges"),
    prevButton: $("#prev-button"),
    nextButton: $("#next-button"),
    sidebar: $("#sidebar"),
    menuToggle: $("#menu-toggle"),
    scrim: $("#scrim"),
    themeToggle: $("#theme-toggle"),
    themeToggleMobile: $("#theme-toggle-mobile"),
  };

  /* ======================================================================
   * 3. Application state
   * ==================================================================== */
  const state = {
    /** Every valid video in the playlist, in file order. */
    videos: [],
    /** The subset matching the current search query. */
    visible: [],
    /** Unique id of the currently playing video (null until something plays). */
    activeUid: null,
    /** Current search query. */
    query: "",
    /** Colour theme: "dark" (default) or "light". */
    theme: "dark",
  };

  /** Timer handle for the embedded-player watchdog. */
  let embedWatchdog = null;

  /* ======================================================================
   * 4. Small utilities
   * ==================================================================== */

  /**
   * Debounce a function. Used so that typing in the search box does not
   * re-render the playlist on every keystroke.
   *
   * @param {Function} fn
   * @param {number} wait
   * @returns {Function}
   */
  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Lower-case, strip diacritics and collapse whitespace so that searches
   * are forgiving ("cafe" matches "Café").
   *
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeText(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Normalise a CSV header cell: trim, lower-case, spaces → underscores.
   *
   * @param {string} cell
   * @returns {string}
   */
  function normalizeHeader(cell) {
    return String(cell || "")
      .trim()
      .replace(/^"|"$/g, "")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
  }

  /**
   * Read a value from a row using a list of accepted column aliases.
   * Exact matches win; a "contains" match is the fallback.
   *
   * @param {string[]} row
   * @param {string[]} headers
   * @param {string[]} aliases
   * @returns {string}
   */
  function pickValue(row, headers, aliases) {
    for (let a = 0; a < aliases.length; a += 1) {
      const index = headers.indexOf(aliases[a]);
      if (index !== -1) {
        const value = (row[index] || "").trim();
        if (value) return value;
      }
    }
    for (let a = 0; a < aliases.length; a += 1) {
      for (let h = 0; h < headers.length; h += 1) {
        if (headers[h].indexOf(aliases[a]) !== -1) {
          const value = (row[h] || "").trim();
          if (value) return value;
        }
      }
    }
    return "";
  }

  /**
   * Split a tags cell into a clean array. Supports comma / semicolon / pipe
   * separated values as well as a JSON array.
   *
   * @param {string} raw
   * @returns {string[]}
   */
  function parseTags(raw) {
    const value = String(raw || "").trim();
    if (!value) return [];

    if (value.charAt(0) === "[") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((tag) => String(tag).trim()).filter(Boolean);
        }
      } catch (error) {
        /* Not JSON after all — fall through to the delimiter based split. */
      }
    }

    return value
      .split(/[,;|]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  /**
   * Validate a candidate URL: HTTPS only and hosted on an allow-listed domain.
   *
   * @param {string} candidate
   * @returns {string} The normalised URL, or "" when the URL is not allowed.
   */
  function sanitizeUrl(candidate) {
    const value = String(candidate || "").trim();
    if (!value) return "";

    let url;
    try {
      url = new URL(value, window.location.href);
    } catch (error) {
      return "";
    }

    if (url.protocol !== "https:") return "";

    const host = url.hostname.toLowerCase();
    const allowed = CONFIG.ALLOWED_EMBED_HOSTS.some(
      (domain) => host === domain || host.endsWith("." + domain)
    );

    return allowed ? url.href : "";
  }

  /**
   * Format an ISO timestamp for display. Returns "" for missing/invalid data.
   *
   * @param {string} raw
   * @returns {string}
   */
  function formatDate(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);
    } catch (error) {
      return date.toISOString().slice(0, 10);
    }
  }

  /* ======================================================================
   * 5. CSV parsing
   * ==================================================================== */

  /**
   * Parse CSV text into an array of rows (arrays of cells).
   * Handles quoted fields, escaped quotes (""), embedded commas and
   * newlines, CRLF/CR line endings and a UTF-8 BOM.
   *
   * @param {string} text
   * @returns {string[][]}
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let index = 0;

    const source = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    while (index < source.length) {
      const char = source[index];

      if (inQuotes) {
        if (char === '"') {
          if (source[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        field = "";
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
      } else {
        field += char;
      }

      index += 1;
    }

    /* Flush the last field/row (files without a trailing newline). */
    if (field !== "" || row.length > 0) {
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    }

    return rows;
  }

  /* ======================================================================
   * 6. Normalising rows into the internal video model
   * ==================================================================== */

  /**
   * Turn a raw CSV row into a video object.
   *
   * @param {string[]} row
   * @param {string[]} headers
   * @param {number} index Position of the row inside the file.
   * @returns {object|null} The video, or null when the row is unusable.
   */
  function normalizeRow(row, headers, index) {
    if (!row || row.every((cell) => String(cell).trim() === "")) return null;

    const rawUid = pickValue(row, headers, COLUMN_ALIASES.uid);
    const title = pickValue(row, headers, COLUMN_ALIASES.title) || "Untitled video";
    const description = pickValue(row, headers, COLUMN_ALIASES.description);
    const embedCandidate =
      pickValue(row, headers, COLUMN_ALIASES.embedUrl) ||
      (rawUid ? CONFIG.EMBED_BASE + encodeURIComponent(rawUid) : "");
    const embedUrl = sanitizeUrl(embedCandidate);

    if (!embedUrl) {
      console.warn("[tutorials] Skipping row " + (index + 1) + ": no usable embed URL.");
      return null;
    }

    const thumbnailUrl = sanitizeUrl(
      pickValue(row, headers, COLUMN_ALIASES.thumbnailUrl)
    );

    return {
      uid: rawUid || embedUrl || String(index),
      title: title,
      description: description,
      embedUrl: embedUrl,
      thumbnailUrl: thumbnailUrl,
      status: pickValue(row, headers, COLUMN_ALIASES.status),
      tags: parseTags(pickValue(row, headers, COLUMN_ALIASES.tags)),
      createdAt: formatDate(pickValue(row, headers, COLUMN_ALIASES.createdAt)),
      updatedAt: formatDate(pickValue(row, headers, COLUMN_ALIASES.updatedAt)),
    };
  }

  /**
   * Parse the playlist file into video objects.
   *
   * @param {string} text
   * @returns {object[]}
   */
  function buildPlaylist(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];

    /* Detect whether the first row is a header or an actual data row. */
    const knownHeaders = new Set(
      Object.keys(COLUMN_ALIASES).reduce(function (acc, key) {
        return acc.concat(COLUMN_ALIASES[key]);
      }, [])
    );
    const hasHeaderRow = rows[0].some(function (cell) {
      return knownHeaders.has(normalizeHeader(cell));
    });

    const headers = hasHeaderRow ? rows[0].map(normalizeHeader) : FALLBACK_HEADER.slice();
    const dataRows = hasHeaderRow ? rows.slice(1) : rows;

    return dataRows
      .map(function (row, index) {
        return normalizeRow(row, headers, index + (hasHeaderRow ? 1 : 0));
      })
      .filter(Boolean);
  }

  /* ======================================================================
   * 7. Rendering
   * ==================================================================== */

  /**
   * Render the playlist sidebar.
   */
  function renderPlaylist() {
    const list = els.playlistList;
    list.textContent = "";

    if (!state.visible.length) {
      els.playlistEmpty.hidden = false;
      return;
    }
    els.playlistEmpty.hidden = true;

    const fragment = document.createDocumentFragment();

    state.visible.forEach(function (video, index) {
      const item = document.createElement("li");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "playlist-item";
      button.dataset.uid = video.uid;
      button.setAttribute(
        "aria-current",
        video.uid === state.activeUid ? "true" : "false"
      );
      if (video.uid === state.activeUid) button.classList.add("is-active");

      const number = document.createElement("span");
      number.className = "playlist-item__index";
      number.textContent = String(index + 1);
      button.appendChild(number);

      if (video.thumbnailUrl) {
        const thumb = document.createElement("img");
        thumb.className = "playlist-item__thumb";
        thumb.src = video.thumbnailUrl;
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.decoding = "async";
        button.appendChild(thumb);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "playlist-item__thumb playlist-item__thumb--placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        button.appendChild(placeholder);
      }

      const body = document.createElement("span");
      body.className = "playlist-item__body";

      const title = document.createElement("span");
      title.className = "playlist-item__title";
      title.textContent = video.title;
      body.appendChild(title);

      const metaParts = [];
      if (video.status) metaParts.push(video.status);
      if (video.tags.length) metaParts.push(video.tags.join(", "));
      if (metaParts.length) {
        const meta = document.createElement("span");
        meta.className = "playlist-item__meta";
        meta.textContent = metaParts.join(" • ");
        body.appendChild(meta);
      }

      button.appendChild(body);
      button.addEventListener("click", function () {
        selectVideo(video.uid);
      });

      item.appendChild(button);
      fragment.appendChild(item);
    });

    list.appendChild(fragment);
  }

  /**
   * Render the "N videos" counter in the sidebar header.
   */
  function renderCount() {
    const total = state.videos.length;
    const shown = state.visible.length;

    if (!total) {
      els.videoCount.textContent = "No videos";
      return;
    }

    if (shown === total) {
      els.videoCount.textContent = total + (total === 1 ? " video" : " videos");
    } else {
      els.videoCount.textContent = shown + " of " + total + " videos";
    }
  }

  /**
   * Render the player area for a video.
   *
   * @param {object} video
   */
  function renderPlayer(video) {
    window.clearTimeout(embedWatchdog);

    /* Reset the player: keep the persistent overlay, drop the old frame. */
    const oldFrame = els.player.querySelector(".player__frame");
    if (oldFrame) oldFrame.remove();

    const oldNotice = els.player.querySelector(".player__notice");
    if (oldNotice) oldNotice.remove();

    els.player.dataset.state = "loading";
    els.overlayText.textContent = "Loading “" + video.title + "”…";
    els.spinner.hidden = false;
    els.retryButton.hidden = true;

    const frame = document.createElement("iframe");
    frame.className = "player__frame";
    frame.src = video.embedUrl;
    frame.title = video.title + " — video player";
    frame.setAttribute(
      "allow",
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    );
    frame.setAttribute("allowfullscreen", "");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("loading", "eager");
    frame.addEventListener("load", function () {
      window.clearTimeout(embedWatchdog);
      els.player.dataset.state = "ready";
      const notice = els.player.querySelector(".player__notice");
      if (notice) notice.remove();
    });

    els.player.appendChild(frame);

    /* Watchdog: if the embedded player never reports "load", offer a link
       that opens the video directly in a new tab. */
    embedWatchdog = window.setTimeout(function () {
      if (els.player.dataset.state === "ready") return;
      showEmbedNotice(video);
    }, CONFIG.EMBED_LOAD_TIMEOUT_MS);
  }

  /**
   * Show a fallback link when the embedded player fails to load.
   *
   * @param {object} video
   */
  function showEmbedNotice(video) {
    if (els.player.querySelector(".player__notice")) return;

    const notice = document.createElement("div");
    notice.className = "player__notice";

    const text = document.createElement("span");
    text.textContent = "The player is taking longer than expected.";
    notice.appendChild(text);

    const link = document.createElement("a");
    link.href = video.embedUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open video directly";
    notice.appendChild(link);

    els.player.appendChild(notice);
  }

  /**
   * Render the title, description and metadata badges.
   *
   * @param {object} video
   */
  function renderDetails(video) {
    els.videoTitle.textContent = video.title;
    document.title = video.title + " — ShopNexus Tutorials";

    const position = state.visible.findIndex(function (item) {
      return item.uid === video.uid;
    });
    const number = position === -1 ? 0 : position + 1;
    els.videoPosition.textContent =
      state.visible.length > 1
        ? "Video " + number + " of " + state.visible.length
        : "Video";

    if (video.description) {
      els.videoDescription.textContent = video.description;
      els.videoDescription.hidden = false;
    } else {
      els.videoDescription.textContent = "";
      els.videoDescription.hidden = true;
    }

    els.videoBadges.textContent = "";

    if (video.status) {
      els.videoBadges.appendChild(createBadge(video.status, "badge--status"));
    }
    video.tags.forEach(function (tag) {
      els.videoBadges.appendChild(createBadge(tag));
    });
    if (video.createdAt) {
      els.videoBadges.appendChild(createBadge("Added " + video.createdAt));
    }
  }

  /**
   * Create a small metadata badge.
   *
   * @param {string} text
   * @param {string} [variant]
   * @returns {HTMLElement}
   */
  function createBadge(text, variant) {
    const badge = document.createElement("span");
    badge.className = variant ? "badge " + variant : "badge";
    badge.textContent = text;
    return badge;
  }

  /**
   * Enable/disable the Previous and Next buttons.
   */
  function renderControls() {
    const index = state.visible.findIndex(function (item) {
      return item.uid === state.activeUid;
    });

    const hasPrevious = index > 0;
    const hasNext = index !== -1 && index < state.visible.length - 1;

    els.prevButton.disabled = !hasPrevious;
    els.nextButton.disabled = !hasNext;
  }

  /**
   * Keep the active playlist item visible inside the scrolling sidebar.
   */
  function scrollActiveIntoView() {
    const active = els.playlistList.querySelector(".playlist-item.is-active");
    if (!active) return;

    if (typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /* ======================================================================
   * 8. Actions (user intents)
   * ==================================================================== */

  /**
   * Select (and play) a video.
   *
   * @param {string} uid
   * @param {{ updateHash?: boolean }} [options]
   */
  function selectVideo(uid, options) {
    const settings = options || {};
    const video = state.videos.find(function (item) {
      return item.uid === uid;
    });
    if (!video) return;

    state.activeUid = video.uid;

    renderPlayer(video);
    renderDetails(video);
    renderControls();
    renderPlaylist();
    scrollActiveIntoView();

    if (settings.updateHash !== false) updateHash(video.uid);
    closeDrawer();
  }

  /**
   * Move to the previous/next video relative to the current one.
   *
   * @param {number} delta -1 for previous, +1 for next.
   */
  function goRelative(delta) {
    if (!state.visible.length) return;

    let index = state.visible.findIndex(function (item) {
      return item.uid === state.activeUid;
    });

    if (index === -1) {
      index = delta > 0 ? -1 : state.visible.length;
    }

    const target = index + delta;
    if (target < 0 || target >= state.visible.length) return;

    selectVideo(state.visible[target].uid);
  }

  /**
   * Apply the search query to the playlist.
   *
   * @param {string} query
   */
  function applySearch(query) {
    state.query = query;
    const needle = normalizeText(query);

    state.visible = needle
      ? state.videos.filter(function (video) {
          const haystack = normalizeText(
            [video.title, video.description, video.status, video.tags.join(" ")]
              .filter(Boolean)
              .join(" ")
          );
          return haystack.indexOf(needle) !== -1;
        })
      : state.videos.slice();

    renderPlaylist();
    renderCount();
    renderControls();

    /* Keep the active video highlighted when it survived the filter. */
    const active = state.visible.find(function (item) {
      return item.uid === state.activeUid;
    });
    if (active) {
      renderDetails(active);
      scrollActiveIntoView();
    } else if (state.visible.length) {
      /* The active video was filtered out — start the filtered list. */
      selectVideo(state.visible[0].uid);
    } else {
      els.videoPosition.textContent = "Video";
      els.videoTitle.textContent = "No matching video";
      els.videoDescription.textContent = "";
      els.videoDescription.hidden = true;
      els.videoBadges.textContent = "";
    }
  }

  /**
   * Update the address bar hash so the current video can be shared/bookmarked.
   *
   * @param {string} uid
   */
  function updateHash(uid) {
    const hash = CONFIG.HASH_PREFIX + encodeURIComponent(uid);
    if (window.location.hash === hash) return;

    try {
      window.history.replaceState(null, "", hash);
    } catch (error) {
      window.location.hash = hash;
    }
  }

  /**
   * Read the video id from the address bar hash.
   *
   * @returns {string|null}
   */
  function readHash() {
    const hash = window.location.hash || "";
    if (hash.indexOf(CONFIG.HASH_PREFIX) !== 0) return null;

    try {
      return decodeURIComponent(hash.slice(CONFIG.HASH_PREFIX.length));
    } catch (error) {
      return hash.slice(CONFIG.HASH_PREFIX.length);
    }
  }

  /**
   * Apply a colour theme and remember the choice.
   *
   * @param {"dark"|"light"} theme
   * @param {boolean} [persist]
   */
  function applyTheme(theme, persist) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", state.theme);

    [els.themeToggle, els.themeToggleMobile].forEach(function (button) {
      if (!button) return;
      button.setAttribute("aria-pressed", state.theme === "light" ? "true" : "false");
    });

    if (persist !== false) {
      try {
        window.localStorage.setItem(CONFIG.THEME_STORAGE_KEY, state.theme);
      } catch (error) {
        /* Storage unavailable (private mode) — the theme still applies. */
      }
    }
  }

  /**
   * Read the persisted theme preference.
   *
   * @returns {"dark"|"light"}
   */
  function readStoredTheme() {
    try {
      const stored = window.localStorage.getItem(CONFIG.THEME_STORAGE_KEY);
      return stored === "light" ? "light" : "dark";
    } catch (error) {
      return "dark";
    }
  }

  /**
   * Open the playlist drawer (mobile).
   */
  function openDrawer() {
    els.sidebar.classList.add("is-open");
    els.scrim.hidden = false;
    document.body.classList.add("drawer-open");
    els.menuToggle.setAttribute("aria-expanded", "true");
  }

  /**
   * Close the playlist drawer (mobile).
   */
  function closeDrawer() {
    if (!els.sidebar.classList.contains("is-open")) return;
    els.sidebar.classList.remove("is-open");
    els.scrim.hidden = true;
    document.body.classList.remove("drawer-open");
    els.menuToggle.setAttribute("aria-expanded", "false");
  }

  /* ======================================================================
   * 9. Loading the playlist
   * ==================================================================== */

  /**
   * Fetch and render the playlist. Errors are surfaced in the player area
   * with a retry affordance instead of failing silently.
   */
  function loadPlaylist() {
    showOverlay("Loading playlist…", { spinner: true, retry: false });

    window
      .fetch(CONFIG.CSV_URL, { cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.text();
      })
      .then(function (text) {
        const videos = buildPlaylist(text);

        if (!videos.length) {
          throw new Error("The playlist file does not contain any playable videos.");
        }

        state.videos = videos;
        state.visible = videos.slice();

        renderPlaylist();
        renderCount();

        /* Deep link: honour #video=<id> when it points at a known video. */
        const hashUid = readHash();
        const initial =
          (hashUid &&
            videos.find(function (video) {
              return video.uid === hashUid;
            })) ||
          videos[0];

        selectVideo(initial.uid);
      })
      .catch(function (error) {
        console.error("[tutorials] Failed to load playlist:", error);
        state.videos = [];
        state.visible = [];
        state.activeUid = null;
        renderPlaylist();
        renderCount();
        renderControls();
        const servingFromFile =
          typeof window.location !== "undefined" &&
          String(window.location.protocol) === "file:";

        showOverlay(
          servingFromFile
            ? "This page is served from the filesystem (file://), where fetch() is blocked by browsers. Start a local static server (e.g. `python3 -m http.server`) and reload."
            : "We could not load the playlist. Check that assets/videos/playlist.csv exists and that the page is served over HTTP.",
          { spinner: false, retry: true }
        );

        els.videoTitle.textContent = "Playlist unavailable";
        els.videoPosition.textContent = "Video";
        els.videoDescription.hidden = true;
        els.videoDescription.textContent = "";
        els.videoBadges.textContent = "";
      });
  }

  /**
   * Show the player overlay.
   *
   * @param {string} message
   * @param {{ spinner: boolean, retry: boolean }} options
   */
  function showOverlay(message, options) {
    els.player.dataset.state = "error";
    els.overlayText.textContent = message;
    els.spinner.hidden = !options.spinner;
    els.retryButton.hidden = !options.retry;
  }

  /* ======================================================================
   * 10. Event wiring
   * ==================================================================== */

  /**
   * Attach every listener. Kept separate from init() for readability.
   */
  function bindEvents() {
    /* Search ------------------------------------------------------------ */
    const onSearch = debounce(function (value) {
      applySearch(value);
      els.searchClear.hidden = !value;
    }, CONFIG.SEARCH_DEBOUNCE_MS);

    els.searchInput.addEventListener("input", function (event) {
      onSearch(event.target.value);
    });

    els.searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        els.searchInput.value = "";
        applySearch("");
        els.searchClear.hidden = true;
        els.searchInput.blur();
      }
    });

    els.searchClear.addEventListener("click", function () {
      els.searchInput.value = "";
      applySearch("");
      els.searchClear.hidden = true;
      els.searchInput.focus();
    });

    /* Navigation -------------------------------------------------------- */
    els.prevButton.addEventListener("click", function () {
      goRelative(-1);
    });

    els.nextButton.addEventListener("click", function () {
      goRelative(1);
    });

    els.retryButton.addEventListener("click", loadPlaylist);

    /* Theme ------------------------------------------------------------- */
    [els.themeToggle, els.themeToggleMobile].forEach(function (button) {
      if (!button) return;
      button.addEventListener("click", function () {
        applyTheme(state.theme === "dark" ? "light" : "dark");
      });
    });

    /* Mobile drawer ----------------------------------------------------- */
    els.menuToggle.addEventListener("click", function () {
      if (els.sidebar.classList.contains("is-open")) {
        closeDrawer();
      } else {
        openDrawer();
      }
    });

    els.scrim.addEventListener("click", closeDrawer);

    /* Deep links -------------------------------------------------------- */
    window.addEventListener("hashchange", function () {
      const uid = readHash();
      if (uid && uid !== state.activeUid) selectVideo(uid, { updateHash: false });
    });

    /* Keyboard shortcuts ------------------------------------------------ */
    document.addEventListener("keydown", function (event) {
      const target = event.target;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (event.key === "Escape") {
        closeDrawer();
        return;
      }

      if (isTyping) return;

      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goRelative(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goRelative(1);
      }
    });

    /* Resize: close the drawer when returning to the desktop layout ----- */
    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) closeDrawer();
    });
  }

  /* ======================================================================
   * 11. Bootstrap
   * ==================================================================== */

  /**
   * Entry point.
   */
  function init() {
    applyTheme(readStoredTheme(), false);
    bindEvents();
    loadPlaylist();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
