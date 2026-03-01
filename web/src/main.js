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
import { checkForUpdatesOnStartup } from "./lib/updates.js";

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
        <img class="logoimg" src="./pwa/icon-192.png" alt="" />
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
  view.innerHTML = `
    <div class="header">
      <div class="hgroup">
        <h2>Settings</h2>
        <p>Backups</p>
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
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
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

// Register service worker automatically in production builds
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render();

checkForUpdatesOnStartup();