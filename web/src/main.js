import "./styles.css";
import {
  loadData, saveData, uid, now,
  upsertDeck, removeDeck,
  upsertCard, removeCard,
  renameTagEverywhere, deleteTagEverywhere,
  exportJSON, importJSON, mergeData,
  normalizeTags, addSession
} from "./lib/storage.js";
import { makeSample } from "./lib/sample.js";
import { RATINGS, shuffle, applySessionRating, touchProgress } from "./lib/session.js";
import { checkForUpdates, checkForUpdatesOnStartup } from "./lib/updates.js";

const $ = (sel, el = document) => el.querySelector(sel);

const routes = [
  { id: "library", label: "Library" },
  { id: "study", label: "Study" },
  { id: "stats", label: "Stats" },
  { id: "settings", label: "Settings" }
];

let data = loadData();

// First run sample
if (data.decks.length === 0 && data.cards.length === 0) {
  const sample = makeSample();
  data.decks.push(...(sample.decks ?? []));
  data.cards.push(...(sample.cards ?? []));
  data.tags = Array.from(new Set([...(data.tags ?? []), ...(sample.tags ?? [])]));
  data.settings.lastDeckId = sample.decks?.[0]?.id ?? null;
  saveData(data);
}

let state = {
  route: parseHash() ?? "library",
  library: {
    selection: { type: "deck", id: data.settings.lastDeckId ?? (data.decks[0]?.id ?? null) }
  },
  study: {
    mode: "builder", // builder | session | summary
    selectedDeckIds: [],
    selectedTags: [],
    addedCardIds: [],
    excludedCardIds: [],
    order: [],
    queue: [],
    idx: 0,
    showBack: false,
    startedAt: null,
    summary: null
  }
};

initDefaults();

const toasts = [];
function toast(title, description = "", ms = 2600) {
  const id = uid("toast");
  toasts.push({ id, title, description });
  renderToasts();
  setTimeout(() => {
    const i = toasts.findIndex(t => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
    renderToasts();
  }, ms);
}

function parseHash() {
  const h = (location.hash || "").replace("#", "").trim();
  return routes.some(r => r.id === h) ? h : null;
}

window.addEventListener("hashchange", () => {
  state.route = parseHash() ?? "library";
  // When leaving Study, keep mode but don't force reset
  render();
});

function setRoute(r) {
  location.hash = `#${r}`;
}

function initDefaults() {
  // ensure library selection is valid
  if (state.library.selection?.type === "deck") {
    if (!deckById(state.library.selection.id)) {
      state.library.selection = { type: "deck", id: data.decks[0]?.id ?? null };
    }
  }
  if (state.library.selection?.type === "tag") {
    if (!allTags().includes(state.library.selection.name)) {
      state.library.selection = { type: "deck", id: data.decks[0]?.id ?? null };
    }
  }

  // default study selection: last deck
  if (state.study.selectedDeckIds.length === 0 && state.study.selectedTags.length === 0 && state.study.addedCardIds.length === 0) {
    const last = data.settings.lastDeckId ?? data.decks[0]?.id ?? null;
    if (last) state.study.selectedDeckIds = [last];
  }

  rebuildSessionOrder({ silent: true });
}

function deckById(id) { return data.decks.find(d => d.id === id) ?? null; }
function cardById(id) { return data.cards.find(c => c.id === id) ?? null; }

function allTags() {
  return (data.tags ?? []).slice().sort((a, b) => a.localeCompare(b));
}

function totalCardsInDeck(deckId) {
  return data.cards.filter(c => c.deckId === deckId).length;
}

function effectiveCardTags(card) {
  const deck = deckById(card.deckId);
  const base = new Set([...(deck?.tags ?? []), ...(card.tags ?? [])]);
  for (const t of (card.tagExcludes ?? [])) base.delete(t);
  return Array.from(base);
}

function cardsForTag(tag) {
  return data.cards.filter(c => effectiveCardTags(c).includes(tag));
}

function uniqueIds(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function sessionBaseIds() {
  const ids = [];
  const deckSet = new Set(state.study.selectedDeckIds);
  if (deckSet.size) {
    for (const c of data.cards) if (deckSet.has(c.deckId)) ids.push(c.id);
  }
  const tagSet = new Set(state.study.selectedTags);
  if (tagSet.size) {
    for (const c of data.cards) {
      const tags = effectiveCardTags(c);
      if (tags.some(t => tagSet.has(t))) ids.push(c.id);
    }
  }
  ids.push(...state.study.addedCardIds);
  return uniqueIds(ids);
}

function rebuildSessionOrder({ silent = false } = {}) {
  const base = sessionBaseIds();
  const excluded = new Set(state.study.excludedCardIds);
  const filtered = base.filter(id => !excluded.has(id) && cardById(id));
  state.study.order = shuffle(filtered);
  if (!silent) toast("Session updated", `${state.study.order.length} cards`);
}

function resetSessionRuntime() {
  state.study.queue = [];
  state.study.idx = 0;
  state.study.showBack = false;
  state.study.startedAt = null;
  state.study.summary = null;
}

function startSession() {
  if (!state.study.order.length) {
    toast("No cards", "Add at least one deck, tag, or card.");
    return;
  }
  state.study.mode = "session";
  state.study.queue = state.study.order.slice();
  state.study.idx = 0;
  state.study.showBack = false;
  state.study.startedAt = now();
  state.study.summary = {
    totalPlanned: state.study.order.length,
    again: 0,
    hard: 0,
    easy: 0,
    reveals: 0,
    endedAt: null,
    perCard: {} // id -> {again, hard, easy, seen}
  };
}

function endSessionToSummary() {
  if (!state.study.summary) state.study.summary = {};
  state.study.summary.endedAt = now();

  // Persist session log for Stats
  try {
    const sum = state.study.summary;
    const log = {
      id: uid("sess"),
      startedAt: state.study.startedAt ?? null,
      endedAt: sum.endedAt ?? null,
      totalPlanned: sum.totalPlanned ?? 0,
      again: sum.again ?? 0,
      hard: sum.hard ?? 0,
      easy: sum.easy ?? 0,
      reveals: sum.reveals ?? 0,
      sources: {
        deckIds: [...(state.study.selectedDeckIds ?? [])],
        tags: [...(state.study.selectedTags ?? [])]
      },
      perCard: sum.perCard ?? {}
    };
    addSession(data, log);
    saveData(data);
  } catch {}

  state.study.mode = "summary";
  state.study.queue = [];
  state.study.idx = 0;
  state.study.showBack = false;
}

function ensureLibraryDeckSelected() {
  const sel = state.library.selection;
  if (sel?.type === "deck") {
    if (!deckById(sel.id)) {
      state.library.selection = { type: "deck", id: data.decks[0]?.id ?? null };
    }
  }
}

function createShell() {
  const app = document.createElement("div");
  app.className = "shell";
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <img class="logoimg" src="./pwa/icon-192.png" alt="Flashlearn logo" />
        <h1>Flashlearn</h1>
      </div>

      <div class="nav" role="navigation" aria-label="App navigation">
        ${routes.map(r => `
          <button class="navbtn" data-route="${r.id}" aria-current="${state.route === r.id ? "page" : "false"}">
            <span class="dot" aria-hidden="true"></span>
            <span>${r.label}</span>
          </button>
        `).join("")}
      </div>

      <div class="foot">
        You are an oficial alpha tester.
      </div>
    </aside>

    <main class="content">
      <div class="container wide" id="view"></div>
    </main>

    <div class="toast-wrap" id="toasts"></div>
  `;
  return app;
}

function renderToasts() {
  const el = $("#toasts");
  if (!el) return;
  el.innerHTML = toasts.map(t => `
    <div class="toast" role="status" aria-live="polite">
      <div class="t">${escapeHtml(t.title)}</div>
      ${t.description ? `<div class="d">${escapeHtml(t.description)}</div>` : ""}
    </div>
  `).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  ensureLibraryDeckSelected();

  const root = $("#app");
  root.innerHTML = "";
  root.appendChild(createShell());

  document.querySelectorAll(".navbtn").forEach(btn => {
    btn.addEventListener("click", () => setRoute(btn.dataset.route));
  });

  const view = $("#view");
  if (!view) return;

  if (state.route === "library") renderLibrary(view);
  if (state.route === "study") renderStudy(view);
  if (state.route === "stats") renderStats(view);
  if (state.route === "settings") renderSettings(view);

  renderToasts();
}

/* -----------------------------
   LIBRARY
------------------------------ */

function renderLibrary(view) {
  const decks = data.decks.slice().sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const tags = allTags();

  const sel = state.library.selection;

  view.classList.remove("session");
  view.innerHTML = `
    <div class="header">
      <div class="hgroup">
        <h2>Library</h2>
        <p>${data.cards.length} cards • ${data.decks.length} decks • ${tags.length} tags</p>
      </div>
      <div class="row">
        <button class="btn" id="btnImportCsvLibrary">Import CSV</button>
        <button class="btn primary" id="btnQuickStudy">Study</button>
      </div>
    </div>

    <div class="split">
      <div class="panes">
        <section class="card headered">
          <div class="pane-head">
            <strong>Decks</strong>
            <button class="btn small primary" id="btnCreateDeck">Create</button>
          </div>
          <div class="pane-body">
            <div class="list" id="deckList">
              ${decks.map(d => `
                <div class="item ${sel?.type==="deck" && sel.id===d.id ? "active" : ""}" data-pick-deck="${d.id}">
                  <div>
                    <div class="title">${escapeHtml(d.name)}</div>
                    <div class="sub">${totalCardsInDeck(d.id)} cards</div>
                  </div>
                  <span class="badge">${(d.tags ?? []).length} tags</span>
                </div>
              `).join("") || `<div class="helper">No decks yet.</div>`}
            </div>
          </div>
        </section>

        <section class="card headered">
          <div class="pane-head">
            <strong>Tags</strong>
            <button class="btn small" id="btnCreateTag">Create</button>
          </div>
          <div class="pane-body">
            <div class="chips" id="tagList">
              ${tags.map(t => `
                <span class="chip" data-pick-tag="${escapeHtml(t)}">
                  <b>${escapeHtml(t)}</b>
                  <span class="badge">${cardsForTag(t).length}</span>
                </span>
              `).join("") || `<span class="helper">No tags yet.</span>`}
            </div>
          </div>
        </section>
      </div>

      <section class="card pad" id="detail"></section>
    </div>
  `;

  $("#btnImportCsvLibrary").addEventListener("click", () => openCsvImportEntry());
  $("#btnQuickStudy").addEventListener("click", () => setRoute("study"));
  $("#btnCreateDeck").addEventListener("click", () => openDeckModal());
  $("#btnCreateTag").addEventListener("click", () => openTagModal());

  // list handlers
  view.querySelectorAll("[data-pick-deck]").forEach(el => {
    el.addEventListener("click", () => {
      state.library.selection = { type: "deck", id: el.getAttribute("data-pick-deck") };
      data.settings.lastDeckId = state.library.selection.id;
      saveData(data);
      renderLibrary(view);
    });
  });

  view.querySelectorAll("[data-pick-tag]").forEach(el => {
    el.addEventListener("click", () => {
      state.library.selection = { type: "tag", name: el.getAttribute("data-pick-tag") };
      renderLibrary(view);
    });
  });

  // detail render
  const detail = $("#detail");
  if (!detail) return;

  if (sel?.type === "tag") renderTagDetail(detail, sel.name);
  else renderDeckDetail(detail, sel?.id ?? data.decks[0]?.id ?? null);
}

function renderDeckDetail(el, deckId) {
  const deck = deckById(deckId);
  if (!deck) {
    el.innerHTML = `<strong>No deck selected</strong>`;
    return;
  }

  const cards = data.cards
    .filter(c => c.deckId === deck.id)
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      <div>
        <div class="row">
          <strong style="font-size:16px">${escapeHtml(deck.name)}</strong>
          <span class="badge">${cards.length} cards</span>
        </div>
        <div class="chips" style="margin-top:10px">
          ${(deck.tags ?? []).map(t => `<span class="chip"><b>${escapeHtml(t)}</b></span>`).join("") || `<span class="helper">No deck tags</span>`}
        </div>
      </div>
      <div class="row">
        <button class="btn" id="btnEditDeck">Edit</button>
        <button class="btn danger" id="btnDeleteDeck">Delete</button>
      </div>
    </div>

    <hr class="sep" />

    <div class="row" style="justify-content:space-between">
      <div class="row" style="flex:1">
        <input class="input" id="deckCardSearch" placeholder="Search cards…" />
      </div>
      <div class="row">
        <button class="btn primary" id="btnCreateCard">Create card</button>
        <button class="btn" id="btnImportCsvDeck">Import CSV</button>
        <button class="btn" id="btnStudyDeck">Study deck</button>
      </div>
    </div>

    <div style="height:10px"></div>

    <table class="table" aria-label="Deck cards">
      <thead>
        <tr>
          <th>Front</th>
          <th>Back</th>
          <th>Tags</th>
          <th class="muted">Last</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="deckCardsBody"></tbody>
    </table>
  `;

  $("#btnEditDeck").addEventListener("click", () => openDeckModal(deck));
  $("#btnDeleteDeck").addEventListener("click", () => {
    if (!confirm(`Delete deck "${deck.name}" and all its cards?`)) return;
    removeDeck(data, deck.id);
    saveData(data);
    toast("Deck deleted");
    state.library.selection = { type: "deck", id: data.decks[0]?.id ?? null };
    render();
  });

  $("#btnCreateCard").addEventListener("click", () => openCardModal({ mode: "create", deckId: deck.id }));
  $("#btnImportCsvDeck").addEventListener("click", () => {
    openCsvImportWizard({ defaultDeckId: deck.id, lockToDefaultDeck: true });
  });
  $("#btnStudyDeck").addEventListener("click", () => {
    state.study.mode = "builder";
    resetSessionRuntime();
    state.study.selectedDeckIds = [deck.id];
    state.study.selectedTags = [];
    state.study.addedCardIds = [];
    state.study.excludedCardIds = [];
    rebuildSessionOrder({ silent: true });
    setRoute("study");
  });

  const tbody = $("#deckCardsBody");
  const search = $("#deckCardSearch");

  function draw() {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? cards.filter(c => (c.front + " " + c.back + " " + (c.notes ?? "")).toLowerCase().includes(q)) : cards;

    tbody.innerHTML = filtered.map(c => {
      const tags = effectiveCardTags(c);
      return `
        <tr>
          <td>${escapeHtml(c.front)}</td>
          <td>${escapeHtml(c.back)}</td>
          <td>${tags.length ? tags.slice(0, 3).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join(" ") : `<span class="muted">—</span>`}</td>
          <td class="muted">${formatLast(c.progress?.lastReviewed)}</td>
          <td class="actions">
            <button class="btn small" data-edit="${c.id}">Edit</button>
            <button class="btn small danger" data-del="${c.id}">Delete</button>
          </td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="5" class="muted">No cards.</td></tr>`;

    tbody.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del");
        const c = cardById(id);
        if (!c) return;
        if (!confirm(`Delete this card?\n\n${c.front} → ${c.back}`)) return;
        removeCard(data, id);
        saveData(data);
        toast("Card deleted");
        renderLibrary($("#view"));
      });
    });

    tbody.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => openCardModal({ mode: "edit", cardId: btn.getAttribute("data-edit") }));
    });
  }

  search.addEventListener("input", draw);
  draw();
}

function renderTagDetail(el, tagName) {
  const tag = String(tagName ?? "").trim();
  if (!tag) {
    el.innerHTML = `<strong>No tag selected</strong>`;
    return;
  }

  const cards = cardsForTag(tag)
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      <div>
        <div class="row">
          <strong style="font-size:16px">${escapeHtml(tag)}</strong>
          <span class="badge">${cards.length} cards</span>
        </div>
        <div class="helper" style="margin-top:6px">Cards can be removed from this tag.</div>
      </div>
      <div class="row">
        <button class="btn" id="btnRenameTag">Rename</button>
        <button class="btn danger" id="btnDeleteTag">Delete</button>
      </div>
    </div>

    <hr class="sep" />

    <div class="row" style="justify-content:space-between">
      <div class="row" style="flex:1">
        <input class="input" id="tagCardSearch" placeholder="Search…" />
      </div>
      <div class="row">
        <button class="btn primary" id="btnAddToTag">Add card</button>
        <button class="btn" id="btnStudyTag">Study tag</button>
      </div>
    </div>

    <div style="height:10px"></div>

    <table class="table" aria-label="Tag cards">
      <thead>
        <tr>
          <th>Front</th>
          <th>Back</th>
          <th class="muted">Deck</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="tagCardsBody"></tbody>
    </table>
  `;

  $("#btnRenameTag").addEventListener("click", () => openTagModal({ mode: "rename", tag }));
  $("#btnDeleteTag").addEventListener("click", () => {
    if (!confirm(`Delete tag "${tag}" everywhere?`)) return;
    deleteTagEverywhere(data, tag);
    saveData(data);
    toast("Tag deleted");
    state.library.selection = { type: "deck", id: data.decks[0]?.id ?? null };
    render();
  });

  $("#btnStudyTag").addEventListener("click", () => {
    state.study.mode = "builder";
    resetSessionRuntime();
    state.study.selectedDeckIds = [];
    state.study.selectedTags = [tag];
    state.study.addedCardIds = [];
    state.study.excludedCardIds = [];
    rebuildSessionOrder({ silent: true });
    setRoute("study");
  });

  $("#btnAddToTag").addEventListener("click", () => {
    const items = data.cards
      .filter(c => !effectiveCardTags(c).includes(tag))
      .map(c => ({
        id: c.id,
        title: c.front,
        subtitle: `${deckById(c.deckId)?.name ?? "Deck"} • ${c.back}`
      }));
    openPicker({
      title: `Add to “${tag}”`,
      placeholder: "Search cards…",
      items,
      onPick: (id) => {
        const c = cardById(id);
        if (!c) return;
        // Add as explicit card tag
        c.tags = normalizeTags([...(c.tags ?? []), tag]);
        // Ensure not excluded
        c.tagExcludes = (c.tagExcludes ?? []).filter(t => t !== tag);
        c.updatedAt = now();
        upsertCard(data, c);
        saveData(data);
        toast("Added to tag");
        renderLibrary($("#view"));
      }
    });
  });

  const tbody = $("#tagCardsBody");
  const search = $("#tagCardSearch");

  function removeFromTag(card) {
    // Guarantee the tag no longer applies to this card (even if inherited from the deck)
    const deck = deckById(card.deckId);
    const deckHas = (deck?.tags ?? []).includes(tag);

    card.tags = (card.tags ?? []).filter(t => t !== tag);

    if (deckHas) {
      card.tagExcludes = normalizeTags([...(card.tagExcludes ?? []), tag]);
    }

    card.updatedAt = now();
    upsertCard(data, card);
    saveData(data);
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? cards.filter(c => (c.front + " " + c.back).toLowerCase().includes(q)) : cards;

    tbody.innerHTML = filtered.map(c => `
      <tr>
        <td>${escapeHtml(c.front)}</td>
        <td>${escapeHtml(c.back)}</td>
        <td class="muted">${escapeHtml(deckById(c.deckId)?.name ?? "—")}</td>
        <td class="actions">
          <button class="btn small" data-edit="${c.id}">Edit</button>
          <button class="btn small" data-remove="${c.id}">Remove</button>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="muted">No cards.</td></tr>`;

    tbody.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const c = cardById(btn.getAttribute("data-remove"));
        if (!c) return;
        removeFromTag(c);
        toast("Removed from tag");
        renderLibrary($("#view"));
      });
    });

    tbody.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => openCardModal({ mode: "edit", cardId: btn.getAttribute("data-edit") }));
    });
  }

  search.addEventListener("input", draw);
  draw();
}

function formatLast(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 10) return `${days}d`;
  return d.toISOString().slice(0, 10);
}

/* -----------------------------
   STUDY
------------------------------ */

function renderStudy(view) {
  if (state.study.mode === "session") {
    view.classList.add("session");
    view.innerHTML = `
      <div class="header">
        <div class="hgroup">
          <h2>Study</h2>
          <p>${state.study.queue.length} cards in session</p>
        </div>
      </div>

      <section class="card study-card" id="studySessionCard"></section>
    `;
    renderStudySession();
    return;
  }

  
  if (state.study.mode === "summary") {
    view.classList.add("session");
    view.innerHTML = `
      <div class="header">
        <div class="hgroup">
          <h2>Session</h2>
          <p>Summary</p>
        </div>
      </div>

      <section class="card pad" id="studySummary"></section>
    `;
    renderStudySummary({ focused: true });
    return;
  }

view.classList.remove("session");
  const planned = state.study.order.length;
  const hasAny = state.study.selectedDeckIds.length || state.study.selectedTags.length || state.study.addedCardIds.length;

  view.innerHTML = `
    <div class="header">
      <div class="hgroup">
        <h2>Study</h2>
        <p>${planned} cards ready</p>
      </div>
      <div class="row">
        <button class="btn" id="btnClearSession">Clear</button>
        <button class="btn primary" id="btnStartSession" ${planned ? "" : "disabled"}>Start</button>
      </div>
    </div>

    <section class="card pad" id="studyBuilder"></section>
    <section class="card pad" id="studyList"></section>
  `;

  $("#btnClearSession").addEventListener("click", () => {
    state.study.selectedDeckIds = [];
    state.study.selectedTags = [];
    state.study.addedCardIds = [];
    state.study.excludedCardIds = [];
    state.study.order = [];
    resetSessionRuntime();
    state.study.mode = "builder";
    renderStudy(view);
  });

  $("#btnStartSession").addEventListener("click", () => {
    startSession();
    render();
  });

  renderStudyBuilder(hasAny);
  renderStudyList();
}

function renderStudyBuilder(hasAny) {
  const el = $("#studyBuilder");
  const decks = data.decks.slice().sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const tags = allTags();

  if (!hasAny && !state.study.order.length) {
    // First pick — gradual UX
    el.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div>
          <strong>Pick a starting point</strong>
          <div class="helper" style="margin-top:6px">Choose one deck or one tag. You can add more after.</div>
        </div>
      </div>

      <hr class="sep" />

      <div class="split" style="grid-template-columns: 1fr 1fr">
        <div>
          <div class="helper">Decks</div>
          <div class="list" style="max-height:260px">
            ${decks.map(d => `
              <div class="item" data-add-deck="${d.id}">
                <div>
                  <div class="title">${escapeHtml(d.name)}</div>
                  <div class="sub">${totalCardsInDeck(d.id)} cards</div>
                </div>
                <button class="btn small">Select</button>
              </div>
            `).join("") || `<div class="helper">No decks.</div>`}
          </div>
        </div>

        <div>
          <div class="helper">Tags</div>
          <div class="chips" style="margin-top:10px">
            ${tags.map(t => `
              <span class="chip" data-add-tag="${escapeHtml(t)}">
                <b>${escapeHtml(t)}</b>
                <span class="badge">${cardsForTag(t).length}</span>
              </span>
            `).join("") || `<span class="helper">No tags.</span>`}
          </div>
        </div>
      </div>
    `;

    el.querySelectorAll("[data-add-deck]").forEach(x => {
      x.addEventListener("click", () => {
        state.study.selectedDeckIds = uniqueIds([...state.study.selectedDeckIds, x.getAttribute("data-add-deck")]);
        rebuildSessionOrder({ silent: true });
        renderStudy($("#view"));
      });
    });

    el.querySelectorAll("[data-add-tag]").forEach(x => {
      x.addEventListener("click", () => {
        state.study.selectedTags = uniqueIds([...state.study.selectedTags, x.getAttribute("data-add-tag")]);
        rebuildSessionOrder({ silent: true });
        renderStudy($("#view"));
      });
    });

    return;
  }

  const selDecks = state.study.selectedDeckIds.map(id => deckById(id)).filter(Boolean);
  const selTags = state.study.selectedTags;

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      <div>
        <strong>Session sources</strong>
        <div style="height:8px"></div>
        <div class="chips" id="sourceChips"></div>
      </div>
      <div class="row">
        <button class="btn" id="btnShuffleOrder">Shuffle</button>
        <button class="btn" id="btnAddDeck">Add deck</button>
        <button class="btn" id="btnAddTag">Add tag</button>
        <button class="btn primary" id="btnAddCard">Add card</button>
      </div>
    </div>
  `;

  const chipsEl = $("#sourceChips");
  chipsEl.innerHTML = `
    ${selDecks.map(d => `
      <span class="chip">
        <b>${escapeHtml(d.name)}</b>
        <span class="x" data-rem-deck="${d.id}" aria-label="Remove">×</span>
      </span>
    `).join("")}
    ${selTags.map(t => `
      <span class="chip">
        <b>#${escapeHtml(t)}</b>
        <span class="x" data-rem-tag="${escapeHtml(t)}" aria-label="Remove">×</span>
      </span>
    `).join("")}
    ${(!selDecks.length && !selTags.length && !state.study.addedCardIds.length) ? `<span class="helper">No sources selected.</span>` : ""}
  `;

  chipsEl.querySelectorAll("[data-rem-deck]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-rem-deck");
      state.study.selectedDeckIds = state.study.selectedDeckIds.filter(x => x !== id);
      rebuildSessionOrder({ silent: true });
      renderStudy($("#view"));
    });
  });
  chipsEl.querySelectorAll("[data-rem-tag]").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-rem-tag");
      state.study.selectedTags = state.study.selectedTags.filter(x => x !== t);
      rebuildSessionOrder({ silent: true });
      renderStudy($("#view"));
    });
  });

  $("#btnShuffleOrder").addEventListener("click", () => {
    state.study.order = shuffle(state.study.order);
    toast("Shuffled");
    renderStudyList();
  });

  $("#btnAddDeck").addEventListener("click", () => {
    openPicker({
      title: "Add deck",
      placeholder: "Search decks…",
      items: decks.map(d => ({ id: d.id, title: d.name, subtitle: `${totalCardsInDeck(d.id)} cards` })),
      onPick: (id) => {
        state.study.selectedDeckIds = uniqueIds([...state.study.selectedDeckIds, id]);
        rebuildSessionOrder({ silent: true });
        renderStudy($("#view"));
      }
    });
  });

  $("#btnAddTag").addEventListener("click", () => {
    openPicker({
      title: "Add tag",
      placeholder: "Search tags…",
      items: tags.map(t => ({ id: t, title: t, subtitle: `${cardsForTag(t).length} cards` })),
      onPick: (t) => {
        state.study.selectedTags = uniqueIds([...state.study.selectedTags, t]);
        rebuildSessionOrder({ silent: true });
        renderStudy($("#view"));
      }
    });
  });

  $("#btnAddCard").addEventListener("click", () => {
    const items = data.cards.map(c => ({
      id: c.id,
      title: c.front,
      subtitle: `${deckById(c.deckId)?.name ?? "Deck"} • ${c.back}`
    }));
    openPicker({
      title: "Add card",
      placeholder: "Search cards…",
      items,
      onPick: (id) => {
        state.study.addedCardIds = uniqueIds([...state.study.addedCardIds, id]);
        // Ensure it's not excluded
        state.study.excludedCardIds = state.study.excludedCardIds.filter(x => x !== id);
        rebuildSessionOrder({ silent: true });
        renderStudy($("#view"));
      }
    });
  });
}

function renderStudyList() {
  const el = $("#studyList");
  const ids = state.study.order.slice();
  const cards = ids.map(cardById).filter(Boolean);

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:center">
      <strong>Cards</strong>
      <span class="badge">${cards.length}</span>
    </div>

    <hr class="sep" />

    <table class="table" aria-label="Session cards">
      <thead>
        <tr>
          <th>Front</th>
          <th class="muted">Deck</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="sessionBody"></tbody>
    </table>
  `;

  const tbody = $("#sessionBody");
  tbody.innerHTML = cards.map(c => `
    <tr>
      <td>${escapeHtml(c.front)}</td>
      <td class="muted">${escapeHtml(deckById(c.deckId)?.name ?? "—")}</td>
      <td class="actions"><button class="btn small" data-remove-session="${c.id}">Remove</button></td>
    </tr>
  `).join("") || `<tr><td colspan="3" class="muted">No cards selected.</td></tr>`;

  tbody.querySelectorAll("[data-remove-session]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-remove-session");
      state.study.excludedCardIds = uniqueIds([...state.study.excludedCardIds, id]);
      rebuildSessionOrder({ silent: true });
      renderStudy($("#view"));
    });
  });
}

function renderStudySession() {
  const wrap = $("#studySessionCard");
  const queue = state.study.queue;
  const idx = state.study.idx;
  const id = queue[idx] ?? null;

  if (!id) {
    endSessionToSummary();
    render();
    return;
  }

  const card = cardById(id);
  if (!card) {
    state.study.idx += 1;
    renderStudySession();
    return;
  }

  const total = state.study.summary?.totalPlanned ?? queue.length;
  const doneSoFar = (state.study.summary?.easy ?? 0);
  const progress = Math.round(((idx) / Math.max(1, total)) * 100);

  
  // per-card choice state
  state.study.choiceState ??= {};
  const _cs = state.study.choiceState[card.id] ?? { selectedIds: [], checked: false };
  state.study.choiceState[card.id] = _cs;

  const mediaHtml = card.imageData
    ? `<div class="study-media" style="margin-top:12px"><img src="${card.imageData}" alt="" /></div>`
    : "";

  let qaHtml = "";
  if (card.kind === "single" || card.kind === "multi") {
    const opts = (card.choices?.options ?? []).filter(o => String(o.text ?? "").trim().length);
    const correct = new Set(card.choices?.correctIds ?? []);
    const selected = new Set(_cs.selectedIds ?? []);
    const checked = state.study.showBack;

    qaHtml = `
      <div class="opt-list">
        ${opts.map(o => {
          const isCorrect = correct.has(o.id);
          const isSelected = selected.has(o.id);
          const cls = checked
            ? (isCorrect ? "opt correct" : (isSelected && !isCorrect ? "opt wrong" : "opt"))
            : "opt";
          return `
            <label class="${cls}">
              <input ${card.kind === "single" ? "type=\"radio\"" : "type=\"checkbox\""} name="choiceOpt" value="${o.id}" ${isSelected ? "checked" : ""} ${checked ? "disabled" : ""} />
              <div>
                <div style="font-weight:700">${escapeHtml(o.text)}</div>
                ${checked && isCorrect ? `<div class="helper">Correct</div>` : ""}
                ${checked && isSelected && !isCorrect ? `<div class="helper">Your choice</div>` : ""}
              </div>
            </label>
          `;
        }).join("")}
      </div>

      ${checked
        ? `${card.back || card.notes ? `<div class="study-back" style="margin-top:12px">${escapeHtml(card.back || "")}${card.notes ? `<div class="helper" style="margin-top:10px">${escapeHtml(card.notes)}</div>` : ""}</div>` : ""}`
        : `<button class="btn primary" id="btnReveal">Check</button>`
      }
    `;
  } else {
    qaHtml = state.study.showBack
      ? `<div class="study-back">${escapeHtml(card.back)}${card.notes ? `<div class="helper" style="margin-top:10px">${escapeHtml(card.notes)}</div>` : ""}</div>`
      : `<button class="btn primary" id="btnReveal">Reveal</button>`;
  }

wrap.innerHTML = `
    <div class="study-topbar">
      <div class="row">
        <span class="badge">${idx + 1} / ${queue.length}</span>
        <span class="badge">${doneSoFar} done</span>
      </div>
      <div class="row">
        <div class="progress" aria-label="Progress"><div style="width:${progress}%"></div></div>
        <button class="btn" id="btnEndNow">End</button>
      </div>
    </div>

    <div class="study-front">${escapeHtml(card.front)}</div>
    ${mediaHtml}
    ${qaHtml}

    <div class="study-actions" id="studyActions"></div>
  `;

  $("#btnEndNow").addEventListener("click", () => {
    if (!confirm("End session?")) return;
    endSessionToSummary();
    render();
  });

  const actions = $("#studyActions");
  if (!state.study.showBack) {
    actions.innerHTML = `
      ${card.kind === "single" || card.kind === "multi" ? "Select your answer, then check." : "Recall the back, then reveal."}
      <button class="btn" id="btnSkip">Skip</button>
    `;
        if (card.kind === "single" || card.kind === "multi") {
      wrap.querySelectorAll('input[name="choiceOpt"]').forEach(inp => {
        inp.addEventListener("change", () => {
          const id = inp.value;
          if (card.kind === "single") {
            _cs.selectedIds = [id];
            // keep radios in sync (browser usually does)
          } else {
            const set = new Set(_cs.selectedIds ?? []);
            if (inp.checked) set.add(id); else set.delete(id);
            _cs.selectedIds = [...set];
          }
        });
      });
    }

$("#btnReveal").addEventListener("click", () => {
      if (card.kind === "single" || card.kind === "multi") {
        if (!(_cs.selectedIds?.length)) {
          toast("Pick an answer", "Select an option before checking.");
          return;
        }
      }
      state.study.showBack = true;
      if (state.study.summary) state.study.summary.reveals += 1;
      renderStudySession();
    });
    $("#btnSkip").addEventListener("click", () => {
      state.study.idx += 1;
      state.study.showBack = false;
      renderStudySession();
    });
    return;
  }

  actions.innerHTML = `
    <div class="row">
      <button class="btn danger" data-rate="${RATINGS.AGAIN}">Again</button>
      <button class="btn" data-rate="${RATINGS.HARD}">Hard</button>
      <button class="btn primary" data-rate="${RATINGS.EASY}">Easy</button>
    </div>
    <button class="btn ghost" id="btnEditCard">Edit</button>
  `;

  $("#btnEditCard").addEventListener("click", () => openCardModal({ mode: "edit", cardId: card.id, afterSave: () => renderStudySession() }));

  wrap.querySelectorAll("[data-rate]").forEach(btn => {
    btn.addEventListener("click", () => {
      const rating = btn.getAttribute("data-rate");

      // Progress tracking
      card.progress = touchProgress(card.progress);
      card.updatedAt = now();
      upsertCard(data, card);
      saveData(data);

      // Summary stats
      const sum = state.study.summary;
      if (sum) {
        sum.perCard[card.id] ??= { again: 0, hard: 0, easy: 0, seen: 0 };
        sum.perCard[card.id].seen += 1;
        if (rating === RATINGS.AGAIN) { sum.again += 1; sum.perCard[card.id].again += 1; }
        if (rating === RATINGS.HARD) { sum.hard += 1; sum.perCard[card.id].hard += 1; }
        if (rating === RATINGS.EASY) { sum.easy += 1; sum.perCard[card.id].easy += 1; }
      }

      const res = applySessionRating(queue, idx, rating, { againGap: 4 });
      state.study.queue = res.queue;
      state.study.idx = res.idx;
      state.study.showBack = false;

      renderStudySession();
    });
  });
}

function renderStudySummary({ focused = false } = {}) {
  const el = $("#studySummary");
  const sum = state.study.summary;
  if (!sum) {
    el.innerHTML = "";
    return;
  }

  const total = sum.totalPlanned ?? 0;
  const easy = sum.easy ?? 0;
  const hard = sum.hard ?? 0;
  const again = sum.again ?? 0;
  const minutes = sum.endedAt && state.study.startedAt ? Math.max(1, Math.round((sum.endedAt - state.study.startedAt) / 60000)) : 0;
  const pct = total ? Math.round((easy / total) * 100) : 0;

  // build hardest cards list
  const trouble = Object.entries(sum.perCard ?? {})
    .map(([id, s]) => ({ id, score: (s.again ?? 0) * 2 + (s.hard ?? 0), ...s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .filter(x => x.score > 0);

  el.innerHTML = `
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      <div>
        <strong>Session summary</strong>
        <div class="helper" style="margin-top:6px">${minutes ? `${minutes} min` : ""}</div>
      </div>
      <div class="row">
        <button class="btn" id="btnDoneSession">Done</button>
        <button class="btn primary" id="btnStudySame">Study again</button>
      </div>
    </div>

    <hr class="sep" />

    <div class="split" style="grid-template-columns: 1fr 1fr">
      <div class="row" style="gap:18px; align-items:center">
        <div class="ring" id="ring">
          <div class="inner">
            <div class="big">${pct}%</div>
            <div class="small">done</div>
          </div>
        </div>

        <div style="display:grid; gap:10px; flex:1">
          <div class="metric">
            <div class="label">Planned</div>
            <div class="value">${total}</div>
            <div class="hint">cards in this session</div>
          </div>
          <div class="row">
            <span class="badge">Easy: ${easy}</span>
            <span class="badge">Hard: ${hard}</span>
            <span class="badge">Again: ${again}</span>
          </div>
        </div>
      </div>

      <div>
        <strong>Trouble cards</strong>
        <div class="helper" style="margin-top:6px">${trouble.length ? "Most repeated/hard-rated." : "No trouble cards this time."}</div>
        <div style="height:10px"></div>
        <div style="display:grid; gap:8px">
          ${trouble.map(t => {
            const c = cardById(t.id);
            if (!c) return "";
            return `
              <div class="item" style="cursor:default">
                <div>
                  <div class="title">${escapeHtml(c.front)}</div>
                  <div class="sub">${escapeHtml(deckById(c.deckId)?.name ?? "Deck")} • Again ${t.again ?? 0} • Hard ${t.hard ?? 0}</div>
                </div>
                <button class="btn small" data-edit-trouble="${c.id}">Edit</button>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    </div>
  `;

  // ring fill
  const ring = $("#ring");
  if (ring) {
    const deg = total ? Math.round((easy / total) * 360) : 0;
    ring.style.background = `conic-gradient(rgba(36,226,169,.95) 0deg, rgba(36,226,169,.95) ${deg}deg, rgba(255,255,255,.06) ${deg}deg, rgba(255,255,255,.06) 360deg)`;
  }

  $("#btnDoneSession").addEventListener("click", () => {
    state.study.mode = "builder";
    resetSessionRuntime();
    render();
  });

  $("#btnStudySame").addEventListener("click", () => {
    state.study.mode = "builder";
    resetSessionRuntime();
    state.study.order = shuffle(state.study.order.length ? state.study.order : sessionBaseIds());
    startSession();
    render();
  });

  el.querySelectorAll("[data-edit-trouble]").forEach(btn => {
    btn.addEventListener("click", () => openCardModal({ mode: "edit", cardId: btn.getAttribute("data-edit-trouble"), afterSave: () => render() }));
  });
}


/* -----------------------------
   STATS
------------------------------ */

function renderStats(view) {
  view.classList.remove("session");

  const totalDecks = data.decks.length;
  const totalCards = data.cards.length;
  const totalTags = allTags().length;
  const sessions = (data.sessions ?? []).slice().sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const totalSessions = sessions.length;

  const totalReviews = data.cards.reduce((acc, c) => acc + (c.progress?.reviews ?? 0), 0);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const reviewedToday = data.cards.filter(c => (c.progress?.lastReviewed ?? 0) >= startOfDay.getTime()).length;

  const lastSession = sessions[sessions.length - 1] ?? null;

  view.innerHTML = `
    <div class="header">
      <div class="hgroup">
        <h2>Stats</h2>
        <p>Progress over time</p>
      </div>
    </div>

    <section class="card pad">
      <div class="grid3">
        <div class="kpi">
          <div class="label">Cards</div>
          <div class="value">${totalCards}</div>
          <div class="hint">${reviewedToday} reviewed today</div>
        </div>
        <div class="kpi">
          <div class="label">Decks</div>
          <div class="value">${totalDecks}</div>
          <div class="hint">${totalTags} tags</div>
        </div>
        <div class="kpi">
          <div class="label">Sessions</div>
          <div class="value">${totalSessions}</div>
          <div class="hint">${lastSession ? `last: ${formatDateTime(lastSession.endedAt)}` : "—"}</div>
        </div>
      </div>

      <hr class="sep" />

      <div class="split" style="grid-template-columns: 1fr 1fr">
        <div>
          <div class="row" style="justify-content:space-between">
            <strong>Daily sessions</strong>
            <span class="badge">last 14 days</span>
          </div>
          <div style="height:10px"></div>
          <canvas id="cDaily" height="140" style="width:100%"></canvas>
          <div class="helper" style="margin-top:8px">Small streaks beat big bursts.</div>
        </div>

        <div>
          <div class="row" style="justify-content:space-between">
            <strong>Ratings mix</strong>
            <span class="badge">last 12 sessions</span>
          </div>
          <div style="height:10px"></div>
          <canvas id="cMix" height="140" style="width:100%"></canvas>
          <div class="helper" style="margin-top:8px">Easy ends a card for the session; Again repeats soon.</div>
        </div>
      </div>
    </section>

    <section class="card pad">
      <div class="row" style="justify-content:space-between">
        <strong>Insights</strong>
        <span class="badge">${totalReviews} total reviews</span>
      </div>

      <hr class="sep" />

      <div class="split">
        <div>
          <strong>Most reviewed cards</strong>
          <div class="helper" style="margin-top:6px">Top 8 by lifetime review count.</div>
          <div style="height:10px"></div>
          <div class="list" id="topCards"></div>
        </div>

        <div>
          <strong>Last session</strong>
          <div class="helper" style="margin-top:6px">${lastSession ? `${lastSession.totalPlanned} planned · Easy ${lastSession.easy} · Hard ${lastSession.hard} · Again ${lastSession.again}` : "No sessions yet."}</div>
          <div style="height:10px"></div>
          <div class="grid2">
            <div class="kpi" style="padding:12px">
              <div class="label">Completion</div>
              <div class="value">${lastSession ? Math.round(((lastSession.easy ?? 0) / Math.max(1, lastSession.totalPlanned ?? 0)) * 100) : 0}%</div>
              <div class="hint">Easy / planned</div>
            </div>
            <div class="kpi" style="padding:12px">
              <div class="label">Reveals</div>
              <div class="value">${lastSession ? (lastSession.reveals ?? 0) : 0}</div>
              <div class="hint">Shown backs</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  // Fill top cards list
  const top = data.cards
    .slice()
    .sort((a, b) => (b.progress?.reviews ?? 0) - (a.progress?.reviews ?? 0))
    .slice(0, 8);

  const topEl = $("#topCards");
  topEl.innerHTML = top.map(c => `
    <div class="item">
      <div>
        <div class="title">${escapeHtml(c.front || "—")}</div>
        <div class="sub">${escapeHtml(deckById(c.deckId)?.name ?? "Deck")} • ${c.progress?.reviews ?? 0} reviews</div>
      </div>
      <button class="btn small" data-edit="${c.id}">Edit</button>
    </div>
  `).join("") || `<div class="helper">No cards yet.</div>`;

  topEl.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => openCardModal({ mode: "edit", cardId: btn.getAttribute("data-edit"), afterSave: () => render() }));
  });

  // Draw charts
  requestAnimationFrame(() => {
    drawDailySessionsChart($("#cDaily"), sessions);
    drawRatingsMixChart($("#cMix"), sessions);
  });
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.toISOString().slice(0,10)} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600;
  const h = canvas.height || 140;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function drawDailySessionsChart(canvas, sessions) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, w, h } = s;

  const days = 14;
  const buckets = [];
  const nowD = new Date();
  nowD.setHours(0,0,0,0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(nowD.getTime() - i * 86400000);
    const key = d.toISOString().slice(0,10);
    buckets.push({ key, count: 0 });
  }

  for (const sess of sessions) {
    if (!sess.endedAt) continue;
    const key = new Date(sess.endedAt).toISOString().slice(0,10);
    const b = buckets.find(x => x.key === key);
    if (b) b.count += 1;
  }

  const maxV = Math.max(1, ...buckets.map(b => b.count));
  const pad = 10;
  const barW = (w - pad*2) / buckets.length;

  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = cssVar("--stroke", "rgba(255,255,255,.10)");
  ctx.fillRect(pad, h-24, w-pad*2, 1);

  const barColor = cssVar("--accent2", "#24e2a9");
  const faint = cssVar("--faint", "rgba(255,255,255,.5)");
  ctx.font = `12px ${cssVar("--sans", "system-ui")}`;

  for (let i=0; i<buckets.length; i++){
    const v = buckets[i].count;
    const bh = Math.round((h-40) * (v / maxV));
    const x = pad + i*barW + 4;
    const y = (h-24) - bh;
    const bw = Math.max(6, barW - 8);

    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(x, (h-24) - (h-40), bw, (h-40));
    ctx.fillStyle = barColor;
    ctx.fillRect(x, y, bw, bh);

    if (i % 3 === 0) {
      ctx.fillStyle = faint;
      const label = buckets[i].key.slice(5);
      ctx.fillText(label, x, h-8);
    }
  }
}

function drawRatingsMixChart(canvas, sessions) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, w, h } = s;

  const last = sessions.slice(-12);
  const pad = 10;
  const barW = (w - pad*2) / Math.max(1, last.length);

  const cAgain = cssVar("--danger", "#ff4d6d");
  const cHard = cssVar("--warn", "#ffb703");
  const cEasy = cssVar("--accent2", "#24e2a9");
  const faint = cssVar("--faint", "rgba(255,255,255,.5)");

  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = cssVar("--stroke", "rgba(255,255,255,.10)");
  ctx.fillRect(pad, h-24, w-pad*2, 1);

  for (let i=0; i<last.length; i++){
    const s0 = last[i];
    const total = Math.max(1, s0.totalPlanned ?? 1);
    const a = (s0.again ?? 0) / total;
    const hd = (s0.hard ?? 0) / total;
    const e = (s0.easy ?? 0) / total;

    const x = pad + i*barW + 4;
    const bw = Math.max(8, barW - 8);
    const baseY = h-24;
    const fullH = h-40;

    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(x, baseY - fullH, bw, fullH);

    const hEasy = Math.round(fullH * e);
    const hHard = Math.round(fullH * hd);
    const hAgain = Math.round(fullH * a);

    let y = baseY;
    ctx.fillStyle = cEasy; ctx.fillRect(x, y - hEasy, bw, hEasy); y -= hEasy;
    ctx.fillStyle = cHard; ctx.fillRect(x, y - hHard, bw, hHard); y -= hHard;
    ctx.fillStyle = cAgain; ctx.fillRect(x, y - hAgain, bw, hAgain);

    if (i === last.length - 1) {
      ctx.font = `12px ${cssVar("--sans", "system-ui")}`;
      ctx.fillStyle = faint;
      ctx.fillText("latest", x - 4, h-8);
    }
  }
}

/* -----------------------------
   SETTINGS
------------------------------ */

function renderSettings(view) {
  view.classList.remove("session");
  const isDesktop = !!window.__TAURI_INTERNALS__;
  view.innerHTML = `
    <div class="header">
      <div class="hgroup">
        <h2>Settings</h2>
        <p>Backup and restore</p>
      </div>
    </div>

    <section class="card pad">
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Export</strong>
          <div class="helper">Download your data as JSON.</div>
        </div>
        <button class="btn primary" id="btnExportAll">Export</button>
      </div>

      <hr class="sep" />

      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div>
          <strong>Import</strong>
          <div class="helper">Merge or replace.</div>
        </div>
        <div class="row">
          <button class="btn" id="btnImportMerge">Merge</button>
          <button class="btn danger" id="btnImportReplace">Replace</button>
        </div>
      </div>

      <hr class="sep" />

      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div>
          <strong>App updates</strong>
          <div class="helper">${isDesktop ? "Check GitHub Releases for a newer desktop build." : "Only available in the desktop app."}</div>
        </div>
        <button class="btn" id="btnCheckUpdates" ${isDesktop ? "" : "disabled"}>Check now</button>
      </div>

      <hr class="sep" />

      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Reset</strong>
          <div class="helper">Deletes local data on this device.</div>
        </div>
        <button class="btn danger" id="btnResetAll">Reset</button>
      </div>
    </section>
  `;

  $("#btnExportAll").addEventListener("click", () => {
    downloadText(`flashlearn-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(data));
  });

  $("#btnImportMerge").addEventListener("click", async () => {
    const raw = await pickTextFile();
    if (!raw) return;
    try {
      const incoming = importJSON(raw);
      data = mergeData(data, incoming);
      saveData(data);
      toast("Imported", "Merged");
      render();
    } catch (e) {
      toast("Import failed", String(e?.message ?? e));
    }
  });

  $("#btnImportReplace").addEventListener("click", async () => {
    const raw = await pickTextFile();
    if (!raw) return;
    if (!confirm("Replace all local data with the imported backup?")) return;
    try {
      const incoming = importJSON(raw);
      data = incoming;
      saveData(data);
      toast("Imported", "Replaced");
      render();
    } catch (e) {
      toast("Import failed", String(e?.message ?? e));
    }
  });

  $("#btnCheckUpdates")?.addEventListener("click", async () => {
    await checkForUpdates({ notifyNoUpdate: true });
  });

  $("#btnResetAll").addEventListener("click", () => {
    if (!confirm("Delete all local decks/cards/tags?")) return;
    localStorage.clear();
    data = loadData();
    toast("Reset complete");
    state = {
      ...state,
      route: "library",
      library: { selection: { type: "deck", id: data.decks[0]?.id ?? null } },
      study: {
        ...state.study,
        mode: "builder",
        selectedDeckIds: [],
        selectedTags: [],
        addedCardIds: [],
        excludedCardIds: [],
        order: [],
        queue: [],
        idx: 0,
        showBack: false,
        startedAt: null,
        summary: null
      }
    };
    render();
  });
}

/* -----------------------------
   CSV IMPORT
------------------------------ */

const CSV_REQUIRED_FIELDS = ["front", "back"];
const CSV_OPTIONAL_FIELDS = ["deck", "tags", "notes"];
const CSV_FIELD_ALIASES = {
  front: ["front", "question", "prompt", "term", "word", "q", "card_front"],
  back: ["back", "answer", "definition", "meaning", "a", "card_back"],
  deck: ["deck", "deck_name", "collection", "folder", "category"],
  tags: ["tags", "tag", "labels", "topics"],
  notes: ["notes", "note", "hint", "hints", "extra", "explanation"]
};

function buildSimpleCsvPrompt() {
  return [
    "Here is the required CSV format (semicolon separator):",
    "front;back",
    "Include the header row as the first line.",
    "If a value contains ; or a line break, wrap that value in quotes.",
    "Return the result as a CSV file that I can download."
  ].join("\n");
}

function buildAdvancedCsvPrompt() {
  return [
    "Here is the required CSV format (semicolon separator):",
    "front;back;deck;tags;notes",
    "Include the header row as the first line.",
    "tags should use | between tags (example: algebra|exam-prep).",
    "notes can be empty if not needed.",
    "If a value contains ; or a line break, wrap that value in quotes.",
    "Return the result as a CSV file that I can download."
  ].join("\n");
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ""));
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text ?? "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function openCsvImportEntry() {
  const selectedDeck =
    state.library.selection?.type === "deck"
      ? deckById(state.library.selection.id)
      : null;

  if (!selectedDeck) {
    openCsvImportWizard();
    return;
  }

  openModal({
    title: "Import CSV",
    body: `
      <div class="helper">Choose how you want to import cards.</div>
      <div style="height:10px"></div>
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Into selected deck</strong>
          <div class="helper">${escapeHtml(selectedDeck.name)}</div>
        </div>
        <button class="btn primary" id="csvEntrySelected">Use selected deck</button>
      </div>
      <hr class="sep" />
      <div class="row" style="justify-content:space-between">
        <div>
          <strong>Use deck column</strong>
          <div class="helper">Import to multiple decks from the CSV file.</div>
        </div>
        <button class="btn" id="csvEntryMulti">Use CSV deck mapping</button>
      </div>
      <hr class="sep" />
      <details class="card pad" style="border-radius:14px; box-shadow:none;">
        <summary style="cursor:pointer; font-weight:700;">Information & LLM prompt templates</summary>
        <div style="height:10px"></div>
        <div class="helper">
          Use this helper when you generate cards in ChatGPT/another LLM and want to import them here.
          First write your normal request (topic, number of cards, level, style), then paste one of the prompt snippets below at the end.
        </div>
        <div style="height:8px"></div>
        <div class="helper">
          Simple format: <code>front;back</code><br/>
          Advanced format: <code>front;back;deck;tags;notes</code><br/>
          Supported separators in import: <code>;</code>, <code>,</code>, and tab.<br/>
          Recommended/default separator is <code>;</code>.<br/>
          Supported fields: required <code>front</code>, <code>back</code>; optional <code>deck</code>, <code>tags</code>, <code>notes</code>.<br/>
          For tags, use a single cell and separate tags with <code>|</code>.
        </div>
        <div style="height:10px"></div>
        <div class="row" style="justify-content:space-between">
          <div>
            <div><strong>Simple append prompt</strong></div>
            <div class="helper">Paste this at the end of your normal request.</div>
          </div>
          <button class="btn small" id="copySimplePrompt">Copy simple prompt</button>
        </div>
        <div style="height:6px"></div>
        <pre class="helper" id="csvSimplePromptPreview" style="white-space:pre-wrap; border:1px solid var(--stroke); border-radius:12px; padding:10px; background:rgba(255,255,255,.02);"></pre>
        <div style="height:10px"></div>
        <div class="row" style="justify-content:space-between">
          <div>
            <div><strong>Advanced append prompt</strong></div>
            <div class="helper">Paste this at the end of your normal request.</div>
          </div>
          <button class="btn small" id="copyAdvancedPrompt">Copy advanced prompt</button>
        </div>
        <div style="height:6px"></div>
        <pre class="helper" id="csvAdvancedPromptPreview" style="white-space:pre-wrap; border:1px solid var(--stroke); border-radius:12px; padding:10px; background:rgba(255,255,255,.02);"></pre>
      </details>
      <hr class="sep" />
      <div class="row" style="justify-content:flex-end">
        <button class="btn" data-close>Cancel</button>
      </div>
    `,
    onMount(modal) {
      const simplePreview = $("#csvSimplePromptPreview", modal);
      const advancedPreview = $("#csvAdvancedPromptPreview", modal);

      simplePreview.textContent = buildSimpleCsvPrompt();
      advancedPreview.textContent = buildAdvancedCsvPrompt();

      $("#copySimplePrompt", modal).addEventListener("click", async () => {
        const ok = await copyToClipboard(buildSimpleCsvPrompt());
        toast(ok ? "Copied" : "Copy failed", ok ? "Simple prompt copied to clipboard." : "Could not copy prompt.");
      });
      $("#copyAdvancedPrompt", modal).addEventListener("click", async () => {
        const ok = await copyToClipboard(buildAdvancedCsvPrompt());
        toast(ok ? "Copied" : "Copy failed", ok ? "Advanced prompt copied to clipboard." : "Could not copy prompt.");
      });

      $("#csvEntrySelected", modal).addEventListener("click", () => {
        closeModal(modal);
        openCsvImportWizard({ defaultDeckId: selectedDeck.id, lockToDefaultDeck: true });
      });
      $("#csvEntryMulti", modal).addEventListener("click", () => {
        closeModal(modal);
        openCsvImportWizard();
      });
    }
  });
}

async function openCsvImportWizard(opts = {}) {
  const file = await pickCsvFile();
  if (!file) return;

  const requestedDeckId = opts.defaultDeckId ?? null;
  const requestedDeck = requestedDeckId ? deckById(requestedDeckId) : null;
  const lockToDefaultDeck = !!opts.lockToDefaultDeck && !!requestedDeck;
  const defaultDeckId = requestedDeck?.id ?? data.settings.lastDeckId ?? data.decks[0]?.id ?? "";

  const fieldRows = [...CSV_REQUIRED_FIELDS, ...CSV_OPTIONAL_FIELDS];
  const fieldLabels = {
    front: "Front (required)",
    back: "Back (required)",
    deck: "Deck (optional)",
    tags: "Tags (optional)",
    notes: "Notes (optional)"
  };

  const deckOptions = data.decks
    .slice()
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join("");

  openModal({
    title: "Import flashcards from CSV",
    body: `
      <div class="helper">File: ${escapeHtml(file.name)}</div>
      ${lockToDefaultDeck ? `<div class="helper">Deck is fixed to <b>${escapeHtml(requestedDeck.name)}</b>. CSV deck values will be ignored.</div>` : ""}
      <div style="height:10px"></div>
      <div class="grid2">
        <div>
          <label class="helper">Column separator (detected automatically, change if needed)</label>
          <select class="select" id="csvDelimiter">
            <option value=",">Comma (,)</option>
            <option value=";">Semicolon (;)</option>
            <option value="tab">Tab</option>
          </select>
        </div>
        <div>
          <label class="helper">Default deck (used when row has no deck)</label>
          <select class="select" id="csvDefaultDeck">
            ${deckOptions || `<option value="">No decks yet</option>`}
          </select>
        </div>
        <div>
          <label class="helper">Tag separator in CSV</label>
          <select class="select" id="csvTagSep">
            <option value=",">Comma (,)</option>
            <option value=";">Semicolon (;)</option>
            <option value="|">Pipe (|)</option>
          </select>
        </div>
      </div>
      <label class="row" style="margin-top:10px">
        <input type="checkbox" id="csvHasHeader" checked />
        <span>First row contains column names (header)</span>
      </label>
      <div id="csvParseSummary" class="helper"></div>

      <div style="height:10px"></div>

      <div class="csv-map">
        ${fieldRows.map(field => `
          <div>
            <label class="helper">${fieldLabels[field]}</label>
            <select class="select" data-csv-map="${field}">
              <option value="">Do not import</option>
            </select>
          </div>
        `).join("")}
      </div>

      <div style="height:10px"></div>

      <label class="row">
        <input type="checkbox" id="csvCreateDecks" checked />
        <span>Create missing decks from CSV values</span>
      </label>
      <label class="row">
        <input type="checkbox" id="csvSkipDup" checked />
        <span>Skip duplicate front/back cards (same target deck)</span>
      </label>

      <hr class="sep" />
      <div id="csvSummary" class="helper">Run validation to preview rows before import.</div>
      <div style="height:10px"></div>
      <div id="csvPreviewWrap"></div>

      <hr class="sep" />
      <div class="row" style="justify-content:space-between">
        <button class="btn" id="csvDownloadErrors" disabled>Download errors CSV</button>
        <div class="row">
          <button class="btn" data-close>Cancel</button>
          <button class="btn" id="csvValidate">Validate & Preview</button>
          <button class="btn primary" id="csvImport" disabled>Import cards</button>
        </div>
      </div>
    `,
    onMount(modal) {
      const selDelimiter = $("#csvDelimiter", modal);
      const selDefaultDeck = $("#csvDefaultDeck", modal);
      const selTagSep = $("#csvTagSep", modal);
      const cHasHeader = $("#csvHasHeader", modal);
      const cCreateDecks = $("#csvCreateDecks", modal);
      const cSkipDup = $("#csvSkipDup", modal);
      const parseSummaryEl = $("#csvParseSummary", modal);
      const summaryEl = $("#csvSummary", modal);
      const previewWrap = $("#csvPreviewWrap", modal);
      const btnValidate = $("#csvValidate", modal);
      const btnImport = $("#csvImport", modal);
      const btnErrors = $("#csvDownloadErrors", modal);

      if (defaultDeckId && selDefaultDeck) selDefaultDeck.value = defaultDeckId;

      const mappingSelects = {};
      fieldRows.forEach((field) => {
        const select = modal.querySelector(`[data-csv-map="${field}"]`);
        if (!select) return;
        mappingSelects[field] = select;
      });

      let latestValidation = null;
      let parsed = null;
      selDelimiter.value = ";";

      function resetMappingOptions(headers, inferred) {
        const headerOptions = headers.map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`).join("");
        for (const field of fieldRows) {
          const select = mappingSelects[field];
          if (!select) continue;
          select.innerHTML = `
            <option value="">Do not import</option>
            ${headerOptions}
          `;
          if (inferred[field] != null) select.value = String(inferred[field]);
        }
        if (lockToDefaultDeck) {
          selDefaultDeck.disabled = true;
          if (mappingSelects.deck) {
            mappingSelects.deck.value = "";
            mappingSelects.deck.disabled = true;
          }
        }
      }

      function reparseCsv() {
        const delimiterMode = selDelimiter?.value || ";";
        const hasHeaderRow = !!cHasHeader?.checked;
        try {
          parsed = parseCsvFile(file.text, { delimiterMode, hasHeaderRow });
          const inferred = inferCsvMapping(parsed.headers);
          resetMappingOptions(parsed.headers, inferred);
          parseSummaryEl.innerHTML = `
            Parsed: ${parsed.rows.length} rows • delimiter: <code>${escapeHtml(parsed.delimiterName)}</code>
          `;
          clearValidationState();
          if (!parsed.rows.length) {
            summaryEl.textContent = "CSV parsed, but no data rows were found.";
          }
        } catch (e) {
          parsed = null;
          parseSummaryEl.textContent = `Parse error: ${String(e?.message ?? e)}`;
          clearValidationState();
        }
      }

      function readMapping() {
        const out = {};
        for (const field of fieldRows) {
          const raw = mappingSelects[field]?.value ?? "";
          out[field] = raw === "" ? null : Number(raw);
        }
        return out;
      }

      function renderValidation(result) {
        summaryEl.innerHTML = `
          <strong>Validation result:</strong>
          ${result.validRows.length} valid •
          ${result.errorRows.length} invalid •
          ${result.warnRows} warnings
        `;

        if (!result.preview.length) {
          previewWrap.innerHTML = `<div class="helper">No valid preview rows.</div>`;
          return;
        }

        previewWrap.innerHTML = `
          <div class="helper">Previewing first ${result.preview.length} valid rows</div>
          <div style="height:8px"></div>
          <table class="table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Front</th>
                <th>Back</th>
                <th>Deck</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              ${result.preview.map(r => `
                <tr>
                  <td class="muted">${r.rowNumber}</td>
                  <td>${escapeHtml(r.front)}</td>
                  <td>${escapeHtml(r.back)}</td>
                  <td>${escapeHtml(r.deckLabel)}</td>
                  <td>${escapeHtml((r.tags ?? []).join(", ")) || "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `;
      }

      function runValidation() {
        if (!parsed) {
          summaryEl.textContent = "CSV could not be parsed. Check separator/header settings.";
          return;
        }
        const mapping = readMapping();
        if (lockToDefaultDeck) mapping.deck = null;
        const options = {
          defaultDeckId: selDefaultDeck?.value || null,
          tagSeparator: selTagSep?.value || ",",
          createMissingDecks: !!cCreateDecks?.checked,
          skipDuplicates: !!cSkipDup?.checked,
          lockToDefaultDeck
        };
        const result = validateCsvImportRows(parsed, mapping, options);
        latestValidation = { mapping, options, ...result };

        renderValidation(result);
        btnImport.disabled = result.validRows.length === 0;
        btnErrors.disabled = result.errorRows.length === 0;
      }

      btnValidate.addEventListener("click", runValidation);

      function clearValidationState() {
        latestValidation = null;
        btnImport.disabled = true;
        btnErrors.disabled = true;
        summaryEl.textContent = "Run validation to preview rows before import.";
        previewWrap.innerHTML = "";
      }

      [...Object.values(mappingSelects), selDefaultDeck, selTagSep, cCreateDecks, cSkipDup]
        .filter(Boolean)
        .forEach((el) => el.addEventListener("change", clearValidationState));

      [selDelimiter, cHasHeader]
        .filter(Boolean)
        .forEach((el) => el.addEventListener("change", reparseCsv));

      btnImport.addEventListener("click", () => {
        if (!latestValidation) runValidation();
        if (!latestValidation || latestValidation.validRows.length === 0) return;

        const imported = executeCsvImport(latestValidation);
        saveData(data);
        toast(
          "CSV import complete",
          `${imported} imported • ${latestValidation.errorRows.length} skipped`
        );
        closeModal(modal);
        render();
      });

      btnErrors.addEventListener("click", () => {
        if (!latestValidation || !latestValidation.errorRows.length) return;
        const csv = errorRowsToCsv(latestValidation.errorRows);
        downloadText(`flashlearn-csv-errors-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      });

      reparseCsv();
    }
  });
}

function normalizeCsvHeaderName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
}

function inferCsvMapping(headers) {
  const normalized = headers.map(h => normalizeCsvHeaderName(h));
  const out = { front: headers[0] != null ? 0 : null, back: headers[1] != null ? 1 : null, deck: null, tags: null, notes: null };
  for (const field of [...CSV_REQUIRED_FIELDS, ...CSV_OPTIONAL_FIELDS]) {
    const aliases = CSV_FIELD_ALIASES[field] ?? [];
    let idx = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) { idx = i; break; }
    }
    if (idx !== -1) out[field] = idx;
  }
  return out;
}

function detectCsvDelimiter(raw) {
  const candidates = [",", ";", "\t"];
  const sample = String(raw ?? "").split(/\r?\n/).slice(0, 12).join("\n");
  let best = { delimiter: ",", score: -1 };

  for (const delimiter of candidates) {
    let total = 0;
    for (const line of sample.split("\n")) {
      let inQuotes = false;
      let count = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "\"") {
          if (inQuotes && line[i + 1] === "\"") { i += 1; continue; }
          inQuotes = !inQuotes;
          continue;
        }
        if (!inQuotes && ch === delimiter) count += 1;
      }
      total += count;
    }
    if (total > best.score) best = { delimiter, score: total };
  }
  return best.delimiter;
}

function parseCsvRows(raw, delimiter) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === "\"") {
        if (next === "\"") {
          cell += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    cell += ch;
  }

  if (inQuotes) throw new Error("CSV has an unterminated quoted value.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseCsvFile(raw, opts = {}) {
  const delimiterMode = opts.delimiterMode ?? "auto";
  const hasHeaderRow = opts.hasHeaderRow !== false;
  const delimiter = delimiterMode === "auto"
    ? detectCsvDelimiter(raw)
    : delimiterMode === "tab"
      ? "\t"
      : delimiterMode;
  const rows = parseCsvRows(raw, delimiter);
  if (!rows.length) throw new Error("CSV contains no rows.");

  const firstRow = rows[0] ?? [];
  const rawHeaders = hasHeaderRow
    ? firstRow.map(h => String(h ?? "").trim())
    : firstRow.map((_, i) => `column_${i + 1}`);
  if (hasHeaderRow && !rawHeaders.length) throw new Error("CSV header row is empty.");

  const headers = rawHeaders.map((h, i) => h || `column_${i + 1}`);
  const dedupe = new Map();
  const uniqueHeaders = headers.map((h) => {
    const n = dedupe.get(h) ?? 0;
    dedupe.set(h, n + 1);
    return n === 0 ? h : `${h}_${n + 1}`;
  });

  const dataRows = [];
  const startIndex = hasHeaderRow ? 1 : 0;
  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i];
    const values = uniqueHeaders.map((_, idx) => String(row[idx] ?? "").trim());
    if (values.every(v => v === "")) continue;
    dataRows.push({ rowNumber: i + 1, values });
  }

  const delimiterName = delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : "comma";
  return {
    delimiter,
    delimiterName,
    headers: uniqueHeaders,
    rows: dataRows
  };
}

function normalizeDupText(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseTagList(raw, separator) {
  const parts = String(raw ?? "")
    .split(separator || ",")
    .map(x => x.trim())
    .filter(Boolean);
  return normalizeTags(parts);
}

function validateCsvImportRows(parsed, mapping, options) {
  const errors = [];
  const validRows = [];
  let warnings = 0;

  const frontIdx = mapping.front;
  const backIdx = mapping.back;
  const deckIdx = mapping.deck;
  const tagsIdx = mapping.tags;
  const notesIdx = mapping.notes;

  if (frontIdx == null || backIdx == null) {
    return {
      validRows: [],
      errorRows: [{ rowNumber: 1, reason: "Front and back columns are required in mapping." }],
      warnRows: 0,
      preview: []
    };
  }
  if (frontIdx === backIdx) {
    return {
      validRows: [],
      errorRows: [{ rowNumber: 1, reason: "Front and back mappings must use different columns." }],
      warnRows: 0,
      preview: []
    };
  }

  const decksByLower = new Map(data.decks.map(d => [String(d.name ?? "").trim().toLowerCase(), d]));
  const hasDefaultDeck = !!options.defaultDeckId;
  const lockToDefaultDeck = !!options.lockToDefaultDeck;
  const existingDupes = new Set(
    data.cards.map(c => `id:${c.deckId}|${normalizeDupText(c.front)}|${normalizeDupText(c.back)}`)
  );
  const seen = new Set(existingDupes);

  for (const row of parsed.rows) {
    const front = String(row.values[frontIdx] ?? "").trim();
    const back = String(row.values[backIdx] ?? "").trim();
    const notes = notesIdx == null ? "" : String(row.values[notesIdx] ?? "").trim();
    const rawDeck = lockToDefaultDeck || deckIdx == null ? "" : String(row.values[deckIdx] ?? "").trim();
    const tags = tagsIdx == null ? [] : parseTagList(row.values[tagsIdx], options.tagSeparator);

    if (!front || !back) {
      errors.push({ rowNumber: row.rowNumber, reason: "Missing required front or back value." });
      continue;
    }
    if (front.length > 2000 || back.length > 4000 || notes.length > 6000) {
      errors.push({ rowNumber: row.rowNumber, reason: "Field length exceeded (front/back/notes too long)." });
      continue;
    }

    let deckRef = "";
    let deckLabel = "";
    if (rawDeck) {
      const match = decksByLower.get(rawDeck.toLowerCase());
      if (match) {
        deckRef = `id:${match.id}`;
        deckLabel = match.name;
      } else if (options.createMissingDecks) {
        deckRef = `name:${rawDeck.toLowerCase()}`;
        deckLabel = rawDeck;
      } else {
        errors.push({ rowNumber: row.rowNumber, reason: `Deck "${rawDeck}" not found.` });
        continue;
      }
    } else if (hasDefaultDeck) {
      deckRef = `id:${options.defaultDeckId}`;
      const d = deckById(options.defaultDeckId);
      deckLabel = d?.name ?? "Default deck";
    } else {
      deckRef = "id:";
      deckLabel = "Imported CSV";
      warnings += 1;
    }

    const dupeKey = `${deckRef}|${normalizeDupText(front)}|${normalizeDupText(back)}`;
    if (options.skipDuplicates && seen.has(dupeKey)) {
      errors.push({ rowNumber: row.rowNumber, reason: "Duplicate card in target deck." });
      continue;
    }
    seen.add(dupeKey);

    validRows.push({
      rowNumber: row.rowNumber,
      front,
      back,
      notes,
      tags,
      deckRef,
      deckLabel
    });
  }

  return {
    validRows,
    errorRows: errors,
    warnRows: warnings,
    preview: validRows.slice(0, 20)
  };
}

function ensureDeckForCsvRow(row, createdDecksByLower) {
  if (row.deckRef.startsWith("id:")) {
    const id = row.deckRef.slice(3);
    if (id) return id;
  }

  if (row.deckRef.startsWith("name:")) {
    const nameLower = row.deckRef.slice(5);
    const existing = createdDecksByLower.get(nameLower);
    if (existing) return existing.id;

    const deck = {
      id: uid("deck"),
      name: row.deckLabel,
      tags: [],
      createdAt: now(),
      updatedAt: now()
    };
    upsertDeck(data, deck);
    createdDecksByLower.set(nameLower, deck);
    return deck.id;
  }

  // no default deck available; create one lazily once
  const key = "__imported_csv__";
  const existing = createdDecksByLower.get(key);
  if (existing) return existing.id;
  const deck = {
    id: uid("deck"),
    name: "Imported CSV",
    tags: [],
    createdAt: now(),
    updatedAt: now()
  };
  upsertDeck(data, deck);
  createdDecksByLower.set(key, deck);
  return deck.id;
}

function executeCsvImport(validationResult) {
  const createdDecksByLower = new Map(data.decks.map(d => [String(d.name ?? "").trim().toLowerCase(), d]));
  let imported = 0;

  for (const row of validationResult.validRows) {
    const deckId = ensureDeckForCsvRow(row, createdDecksByLower);
    const card = {
      id: uid("card"),
      deckId,
      kind: "basic",
      imageData: null,
      choices: null,
      front: row.front,
      back: row.back,
      notes: row.notes,
      tags: row.tags,
      tagExcludes: [],
      createdAt: now(),
      updatedAt: now(),
      progress: { lastReviewed: null, reviews: 0 }
    };
    upsertCard(data, card);
    imported += 1;
  }

  return imported;
}

function escapeCsvCell(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll("\"", "\"\"")}"`;
  return s;
}

function errorRowsToCsv(rows) {
  const header = ["row_number", "reason"].join(",");
  const lines = rows.map(r => [escapeCsvCell(r.rowNumber), escapeCsvCell(r.reason)].join(","));
  return [header, ...lines].join("\n");
}

/* -----------------------------
   MODALS & PICKERS
------------------------------ */

function openDeckModal(deck = null) {
  const isEdit = !!deck;
  const d = deck ? { ...deck } : {
    id: uid("deck"),
    name: "",
    tags: [],
    createdAt: now(),
    updatedAt: now()
  };

  openModal({
    title: isEdit ? "Edit deck" : "Create deck",
    body: `
      <div>
        <label class="helper">Name</label>
        <input class="input" id="mDeckName" value="${escapeHtml(d.name)}" placeholder="Deck name" />
        <div style="height:10px"></div>
        <label class="helper">Tags (comma separated)</label>
        <input class="input" id="mDeckTags" value="${escapeHtml((d.tags ?? []).join(", "))}" placeholder="e.g. Basics, Travel" />
      </div>
      <hr class="sep" />
      <div class="row" style="justify-content:flex-end">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="mDeckSave">${isEdit ? "Save" : "Create"}</button>
      </div>
    `,
    onMount(modal) {
      $("#mDeckSave", modal).addEventListener("click", () => {
        const name = $("#mDeckName", modal).value.trim();
        const tags = normalizeTags($("#mDeckTags", modal).value.split(",").map(x => x.trim()));
        if (!name) { toast("Missing name"); return; }
        d.name = name;
        d.tags = tags;
        d.updatedAt = now();
        upsertDeck(data, d);
        saveData(data);

        if (!isEdit) {
          state.library.selection = { type: "deck", id: d.id };
          data.settings.lastDeckId = d.id;
          saveData(data);
        }

        toast(isEdit ? "Deck saved" : "Deck created");
        closeModal(modal);
        render();
      });
    }
  });
}

function openTagModal(opts = null) {
  const mode = opts?.mode ?? "create"; // create | rename
  const oldTag = opts?.tag ?? "";

  openModal({
    title: mode === "rename" ? "Rename tag" : "Create tag",
    body: `
      <div>
        <label class="helper">Tag</label>
        <input class="input" id="mTagName" value="${escapeHtml(oldTag)}" placeholder="Tag name" />
      </div>
      <hr class="sep" />
      <div class="row" style="justify-content:flex-end">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="mTagSave">${mode === "rename" ? "Save" : "Create"}</button>
      </div>
    `,
    onMount(modal) {
      const inp = $("#mTagName", modal);
      inp.focus();
      inp.select();

      $("#mTagSave", modal).addEventListener("click", () => {
        const name = String(inp.value ?? "").trim().replace(/\s+/g, " ");
        if (!name) { toast("Missing tag"); return; }

        if (mode === "rename") {
          if (name === oldTag) { closeModal(modal); return; }
          renameTagEverywhere(data, oldTag, name);
          saveData(data);
          toast("Tag renamed");
          // update selection
          if (state.library.selection?.type === "tag") state.library.selection.name = name;
        } else {
          data.tags = uniqueIds([...(data.tags ?? []), name]).sort((a, b) => a.localeCompare(b));
          saveData(data);
          toast("Tag created");
          state.library.selection = { type: "tag", name };
        }

        closeModal(modal);
        render();
      });
    }
  });
}

function openCardModal({ mode, deckId = null, cardId = null, afterSave = null }) {
  const isEdit = mode === "edit";
  const c0 = isEdit ? cardById(cardId) : null;
  if (isEdit && !c0) return;

  const c = isEdit ? { ...c0 } : {
    id: uid("card"),
    deckId: deckId ?? (data.settings.lastDeckId ?? data.decks[0]?.id ?? null),
    front: "",
    back: "",
    notes: "",
    tags: [],
    tagExcludes: [],
    createdAt: now(),
    updatedAt: now(),
    progress: { lastReviewed: null, reviews: 0 },
    kind: "basic",
    imageData: null,
    choices: null
  };

  const deck = deckById(c.deckId);

  // normalize optional fields
  c.kind = c.kind ?? "basic";
  c.imageData = c.imageData ?? null;
  if (c.kind === "single" || c.kind === "multi") {
    c.choices = c.choices ?? { options: [], correctIds: [] };
  } else {
    c.choices = null;
  }

  openModal({
    title: isEdit ? "Edit card" : "Create card",
    body: `
      <div class="row" style="justify-content:space-between; align-items:center">
        <div class="helper">${escapeHtml(deck?.name ?? "Deck")}</div>
        <div class="row">
          ${isEdit ? `<button class="btn small" id="mCardMove">Move</button>` : ""}
          <button class="btn small" id="mCardAddTag">Add tag</button>
        </div>
      </div>

      <div style="height:10px"></div>

      <div class="split" style="grid-template-columns: 1fr 1fr">
        <div>
          <label class="helper">Front</label>
          <input class="input" id="mCardFront" value="${escapeHtml(c.front)}" placeholder="Prompt" />
          <div style="height:10px"></div>
          <label class="helper">Back</label>
          <input class="input" id="mCardBack" value="${escapeHtml(c.back)}" placeholder="Answer" />
          <div style="height:10px"></div>
          <label class="helper">Notes</label>
          <textarea class="textarea" id="mCardNotes" placeholder="Optional">${escapeHtml(c.notes ?? "")}</textarea>
          <div style="height:12px"></div>

          <label class="helper">Card type</label>
          <select class="select" id="mCardKind">
            <option value="basic">Basic (front/back)</option>
            <option value="single">Single choice</option>
            <option value="multi">Multiple choice</option>
          </select>

          <div style="height:12px"></div>

          <label class="helper">Picture (optional)</label>
          <div class="row" style="align-items:flex-start">
            <div style="width:240px; max-width:100%">
              <div id="mImgWrap" style="width:240px; max-width:100%; border:1px solid var(--stroke); border-radius:16px; background:rgba(255,255,255,.03); overflow:hidden; display:grid; place-items:center; padding:10px">
                <div class="helper" id="mImgEmpty">No image</div>
                <img id="mImgPreview" alt="" style="display:none; width:100%; height:auto; object-fit:cover; border-radius:12px" />
              </div>
            </div>
            <div style="flex:1; min-width:220px">
              <input class="input" id="mImgFile" type="file" accept="image/*" />
              <div style="height:10px"></div>
              <button class="btn" id="mImgRemove">Remove image</button>
              <div class="helper" style="margin-top:10px">Stored locally inside your app (data URL).</div>
            </div>
          </div>

          <div id="mChoicesBlock" style="margin-top:14px; display:none"></div>

        </div>

        <div>
          <label class="helper">Tags</label>
          <div class="chips" id="mCardTags" style="margin-top:10px"></div>

          <hr class="sep" />

          <div class="helper">Inherited from deck</div>
          <div class="chips" style="margin-top:10px" id="mDeckTags"></div>

          <div style="height:10px"></div>
          ${(c.tagExcludes ?? []).length ? `
            <div class="helper">Excluded</div>
            <div class="chips" style="margin-top:10px" id="mExcluded"></div>
          ` : ""}
        </div>
      </div>

      <hr class="sep" />

      <div class="row" style="justify-content:flex-end">
        <button class="btn" data-close>Close</button>
        <button class="btn primary" id="mCardSave">${isEdit ? "Save" : "Create"}</button>
      </div>
    `,
    onMount(modal) {
      // init type selector
      const kindSel = $("#mCardKind", modal);
      kindSel.value = c.kind ?? "basic";

      const imgPreview = $("#mImgPreview", modal);
      const imgEmpty = $("#mImgEmpty", modal);
      const imgFile = $("#mImgFile", modal);
      const imgRemove = $("#mImgRemove", modal);

      function refreshImage(){
        const has = !!c.imageData;
        imgPreview.style.display = has ? "block" : "none";
        imgEmpty.style.display = has ? "none" : "block";
        if (has) imgPreview.src = c.imageData;
      }

      async function fileToDataUrl(file){
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Failed to read image"));
          reader.readAsDataURL(file);
        });
      }

      imgFile.addEventListener("change", async () => {
        const f = imgFile.files?.[0];
        if (!f) return;
        // basic size guard (keeps localStorage from exploding)
        if (f.size > 2.5 * 1024 * 1024) {
          toast("Image too large", "Please use an image under ~2.5 MB.");
          imgFile.value = "";
          return;
        }
        try{
          c.imageData = await fileToDataUrl(f);
          refreshImage();
          toast("Image added");
        }catch(e){
          toast("Image failed", String(e?.message ?? e));
        }finally{
          imgFile.value = "";
        }
      });

      imgRemove.addEventListener("click", () => {
        c.imageData = null;
        refreshImage();
        toast("Image removed");
      });

      const choicesBlock = $("#mChoicesBlock", modal);

      function renderChoices(){
        const kind = c.kind;
        if (kind !== "single" && kind !== "multi"){
          choicesBlock.style.display = "none";
          choicesBlock.innerHTML = "";
          return;
        }
        c.choices ??= { options: [], correctIds: [] };
        const opts = c.choices.options ?? [];
        const correct = new Set(c.choices.correctIds ?? []);

        choicesBlock.style.display = "block";
        choicesBlock.innerHTML = `
          <hr class="sep" />
          <div class="row" style="justify-content:space-between; align-items:center">
            <div>
              <div style="font-weight:700">Choices</div>
              <div class="helper">${kind === "single" ? "Select exactly one correct option." : "Select one or more correct options."}</div>
            </div>
            <button class="btn small" id="mAddOpt">Add option</button>
          </div>

          <div style="height:10px"></div>

          <div style="display:grid; gap:10px" id="mOptList">
            ${opts.map(o => `
              <div class="row" style="align-items:center">
                <label class="row" style="gap:8px; flex:1; min-width:240px">
                  <input type="${kind === "single" ? "radio" : "checkbox"}" name="correctOpt" data-correct="${o.id}" ${correct.has(o.id) ? "checked" : ""} />
                  <input class="input" data-opt-text="${o.id}" value="${escapeHtml(o.text)}" placeholder="Option text" />
                </label>
                <button class="btn small danger" data-del-opt="${o.id}">Remove</button>
              </div>
            `).join("") || `<div class="helper">Add at least 2 options.</div>`}
          </div>
        `;

        $("#mAddOpt", modal).addEventListener("click", () => {
          const o = { id: uid("opt"), text: "" };
          c.choices.options.push(o);
          renderChoices();
          // focus new input
          setTimeout(() => modal.querySelector(`[data-opt-text="${o.id}"]`)?.focus(), 0);
        });

        choicesBlock.querySelectorAll("[data-opt-text]").forEach(inp => {
          inp.addEventListener("input", () => {
            const id = inp.getAttribute("data-opt-text");
            const opt = c.choices.options.find(x => x.id === id);
            if (opt) opt.text = inp.value;
          });
        });

        choicesBlock.querySelectorAll("[data-del-opt]").forEach(btn => {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-del-opt");
            c.choices.options = c.choices.options.filter(o => o.id !== id);
            c.choices.correctIds = (c.choices.correctIds ?? []).filter(cid => cid !== id);
            renderChoices();
          });
        });

        choicesBlock.querySelectorAll("[data-correct]").forEach(chk => {
          chk.addEventListener("change", () => {
            const id = chk.getAttribute("data-correct");
            if (kind === "single") {
              c.choices.correctIds = chk.checked ? [id] : [];
              // uncheck others visually
              choicesBlock.querySelectorAll(`[data-correct]`).forEach(other => {
                if (other !== chk) other.checked = false;
              });
            } else {
              const set = new Set(c.choices.correctIds ?? []);
              if (chk.checked) set.add(id); else set.delete(id);
              c.choices.correctIds = [...set];
            }
          });
        });
      }

      kindSel.addEventListener("change", () => {
        c.kind = kindSel.value;
        if (c.kind === "single" || c.kind === "multi") {
          c.choices ??= { options: [], correctIds: [] };
        } else {
          c.choices = null;
        }
        renderChoices();
      });

      refreshImage();
      renderChoices();

      const renderTagChips = () => {
        const tagsEl = $("#mCardTags", modal);
        tagsEl.innerHTML = (c.tags ?? []).map(t => `
          <span class="chip"><b>${escapeHtml(t)}</b><span class="x" data-rem-ctag="${escapeHtml(t)}">×</span></span>
        `).join("") || `<span class="helper">No card tags</span>`;

        tagsEl.querySelectorAll("[data-rem-ctag]").forEach(x => {
          x.addEventListener("click", () => {
            const t = x.getAttribute("data-rem-ctag");
            c.tags = (c.tags ?? []).filter(z => z !== t);
            renderTagChips();
          });
        });

        const deckTagsEl = $("#mDeckTags", modal);
        deckTagsEl.innerHTML = (deck?.tags ?? []).map(t => `
          <span class="chip"><b>${escapeHtml(t)}</b></span>
        `).join("") || `<span class="helper">No deck tags</span>`;

        const exEl = $("#mExcluded", modal);
        if (exEl) {
          exEl.innerHTML = (c.tagExcludes ?? []).map(t => `
            <span class="chip"><b>${escapeHtml(t)}</b><span class="x" data-rem-ex="${escapeHtml(t)}">×</span></span>
          `).join("");
          exEl.querySelectorAll("[data-rem-ex]").forEach(x => {
            x.addEventListener("click", () => {
              const t = x.getAttribute("data-rem-ex");
              c.tagExcludes = (c.tagExcludes ?? []).filter(z => z !== t);
              renderTagChips();
            });
          });
        }
      };

      renderTagChips();

      $("#mCardAddTag", modal).addEventListener("click", () => {
        openPicker({
          title: "Add tag",
          placeholder: "Search tags…",
          items: allTags().map(t => ({ id: t, title: t, subtitle: `${cardsForTag(t).length} cards` })),
          onPick: (t) => {
            c.tags = normalizeTags([...(c.tags ?? []), t]);
            // ensure not excluded
            c.tagExcludes = (c.tagExcludes ?? []).filter(x => x !== t);
            renderTagChips();
          },
          allowCreate: true,
          onCreate: (t) => {
            const name = String(t ?? "").trim().replace(/\s+/g, " ");
            if (!name) return null;
            data.tags = uniqueIds([...(data.tags ?? []), name]).sort((a, b) => a.localeCompare(b));
            saveData(data);
            return name;
          }
        });
      });

      const front = $("#mCardFront", modal);
      front.focus();

      $("#mCardSave", modal).addEventListener("click", () => {
        c.front = $("#mCardFront", modal).value.trim();
        c.back = $("#mCardBack", modal).value.trim();
        c.notes = $("#mCardNotes", modal).value.trim();
        // validation depends on type
        if (c.kind === "basic") {
          if (!c.front || !c.back) { toast("Missing fields", "Front and back required."); return; }
        } else if (c.kind === "single" || c.kind === "multi") {
          const opts = (c.choices?.options ?? []).map(o => ({...o, text: String(o.text ?? "").trim()})).filter(o => o.text.length);
          c.choices.options = opts;
          const correct = (c.choices?.correctIds ?? []).filter(id => opts.some(o => o.id === id));
          c.choices.correctIds = c.kind === "single" ? correct.slice(0,1) : correct;

          if (!c.front) { toast("Missing fields", "Question required."); return; }
          if (opts.length < 2) { toast("Add options", "Please add at least 2 answer options."); return; }
          if (c.choices.correctIds.length < 1) { toast("Mark correct", "Please mark the correct option(s)."); return; }
        }

        c.updatedAt = now();
        if (isEdit) {
          upsertCard(data, c);
        } else {
          // IMPORTANT: upsert a clone so clearing fields for rapid entry does not mutate the stored card
          const created = {
            ...c,
            tags: [...(c.tags ?? [])],
            tagExcludes: [...(c.tagExcludes ?? [])],
            progress: { ...(c.progress ?? { lastReviewed: null, reviews: 0 }) }
          };
          upsertCard(data, created);
        }
        saveData(data);

        if (isEdit) {
          toast("Card saved");
          closeModal(modal);
          afterSave?.();
          render();
        } else {
          toast("Card created");
          // prepare a fresh object for the next card (keep deckId)
          c.id = uid("card");
          c.createdAt = now();
          c.updatedAt = now();
          c.progress = { lastReviewed: null, reviews: 0 };
          c.imageData = null;
          if (c.kind === "single" || c.kind === "multi") c.choices = { options: [], correctIds: [] };

          // clear for rapid entry
          $("#mCardFront", modal).value = "";
          $("#mCardBack", modal).value = "";
          $("#mCardNotes", modal).value = "";
          c.front = ""; c.back = ""; c.notes = "";
          c.tags = [];
          c.tagExcludes = [];
          // reset image preview
          const _imgPrev = $("#mImgPreview", modal);
          const _imgEmpty = $("#mImgEmpty", modal);
          if (_imgPrev) { _imgPrev.style.display = "none"; _imgPrev.src = ""; }
          if (_imgEmpty) { _imgEmpty.style.display = "block"; }
          // rerender choices block
          $("#mCardKind", modal)?.dispatchEvent(new Event("change"));
          renderTagChips();
          $("#mCardFront", modal).focus();
          // keep modal open
          render();
        }
      });

      // Optional move for edit mode
      const moveBtn = $("#mCardMove", modal);
      if (moveBtn) {
        moveBtn.addEventListener("click", () => {
          openPicker({
            title: "Move to deck",
            placeholder: "Search decks…",
            items: data.decks.map(d => ({ id: d.id, title: d.name, subtitle: `${totalCardsInDeck(d.id)} cards` })),
            onPick: (id) => {
              c.deckId = id;
              toast("Moved", deckById(id)?.name ?? "");
              closeModal(modal);
              upsertCard(data, c);
              saveData(data);
              afterSave?.();
              render();
            }
          });
        });
      }
    }
  });
}

function openPicker({ title, placeholder, items, onPick, allowCreate = false, onCreate = null }) {
  const list = (items ?? []).slice();

  openModal({
    title,
    body: `
      <div>
        <input class="input" id="pSearch" placeholder="${escapeHtml(placeholder ?? "Search…")}" />
        <div style="height:10px"></div>
        <div class="list" id="pList" style="max-height: 360px"></div>
        ${allowCreate ? `
          <hr class="sep" />
          <div class="row" style="justify-content:space-between">
            <div class="helper">Not found?</div>
            <button class="btn" id="pCreate">Create</button>
          </div>
        ` : ""}
      </div>
    `,
    onMount(modal) {
      const inp = $("#pSearch", modal);
      const listEl = $("#pList", modal);

      const score = (q, text) => fuzzyScore(q, text);

      const renderList = () => {
        const q = inp.value.trim().toLowerCase();
        const ranked = q
          ? list.map(it => ({ it, s: Math.max(score(q, it.title), score(q, it.subtitle ?? "")) }))
              .filter(x => x.s > 0)
              .sort((a, b) => b.s - a.s)
              .slice(0, 60)
              .map(x => x.it)
          : list.slice(0, 60);

        listEl.innerHTML = ranked.map(it => `
          <div class="item" data-pick="${escapeHtml(it.id)}">
            <div>
              <div class="title">${escapeHtml(it.title)}</div>
              ${it.subtitle ? `<div class="sub">${escapeHtml(it.subtitle)}</div>` : ""}
            </div>
            <button class="btn small">Add</button>
          </div>
        `).join("") || `<div class="helper">No results.</div>`;

        listEl.querySelectorAll("[data-pick]").forEach(x => {
          x.addEventListener("click", () => {
            const id = x.getAttribute("data-pick");
            closeModal(modal);
            onPick?.(id);
          });
        });
      };

      inp.addEventListener("input", renderList);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          // pick first result
          const first = listEl.querySelector("[data-pick]");
          if (first) first.click();
        }
      });

      const createBtn = $("#pCreate", modal);
      if (createBtn && allowCreate) {
        createBtn.addEventListener("click", () => {
          const name = inp.value.trim();
          if (!name) return;
          try {
            const createdId = onCreate ? (onCreate(name) ?? name) : name;
            closeModal(modal);
            onPick?.(createdId);
            toast("Created", String(createdId));
          } catch (e) {
            toast("Create failed", String(e?.message ?? e));
          }
        });
      }

      inp.focus();
      renderList();
    }
  });
}

function fuzzyScore(query, text) {
  const q = String(query ?? "").toLowerCase().trim();
  const t = String(text ?? "").toLowerCase();
  if (!q || !t) return 0;
  if (t.includes(q)) return 120 + Math.min(60, q.length * 6);

  // subsequence scoring
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    // reward closeness
    const gap = found - ti;
    score += Math.max(1, 14 - gap);
    ti = found + 1;

    // reward streak
    if (gap === 0) streak += 1;
    else streak = 0;
    score += streak * 2;
  }
  return score;
}

function openModal({ title, body, onMount }) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="box" role="dialog" aria-modal="true">
      <div class="title">
        <h3>${escapeHtml(title)}</h3>
        <button class="close" data-close aria-label="Close">Close</button>
      </div>
      ${body}
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => closeModal(modal);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  modal.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", close));

  const esc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);

  onMount?.(modal);
  return modal;
}

function closeModal(modal) {
  modal?.remove();
}

/* -----------------------------
   FILE HELPERS
------------------------------ */

function downloadText(filename, text) {
  const lower = String(filename ?? "").toLowerCase();
  const mime = lower.endsWith(".csv")
    ? "text/csv;charset=utf-8"
    : "application/json;charset=utf-8";
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function pickTextFile() {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return resolve(null);
      resolve(await file.text());
    };
    inp.click();
  });
}

async function pickCsvFile() {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".csv,text/csv";
    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      resolve({ name: file.name, text });
    };
    inp.click();
  });
}

// Register service worker automatically in production builds
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();

checkForUpdatesOnStartup();
