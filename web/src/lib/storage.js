const KEY = "vt.data.v4";

/**
 * Data model v4
 * - Global tag registry: data.tags (array of strings)
 * - Decks have tags (array of strings)
 * - Cards can have extra tags (card.tags) and tag exclusions (card.tagExcludes)
 *   Effective tags for a card: union(deck.tags, card.tags) minus card.tagExcludes
 * - No due dates / no SRS schedule
 */

export function now() {
  return Date.now();
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export function emptyData() {
  return {
    version: 4,
    createdAt: now(),
    tags: [],
    decks: [],
    cards: [],
    sessions: [],
    settings: {
      lastDeckId: null
    }
  };
}

export function normalizeChoices(choices, kind){
  if (kind !== "single" && kind !== "multi") return null;
  const c = choices && typeof choices === "object" ? choices : {};
  const options = Array.isArray(c.options) ? c.options : [];
  const normOptions = options
    .filter(o => o && typeof o === "object")
    .map(o => ({
      id: o.id ?? uid("opt"),
      text: String(o.text ?? "").slice(0, 300)
    }))
    .filter(o => o.text.trim().length);

  let correctIds = Array.isArray(c.correctIds) ? c.correctIds : [];
  correctIds = correctIds.filter(id => normOptions.some(o => o.id === id));

  // ensure at least 2 options for UX; but keep as-is
  if (kind === "single" && correctIds.length > 1) correctIds = correctIds.slice(0, 1);

  return { options: normOptions, correctIds };
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const cleaned = tags
    .map(t => String(t ?? "").trim())
    .filter(Boolean)
    .map(t => t.replace(/\s+/g, " "));
  return Array.from(new Set(cleaned));
}

function syncRegistry(data) {
  const set = new Set(normalizeTags(data.tags ?? []));
  for (const d of (data.decks ?? [])) for (const t of normalizeTags(d.tags ?? [])) set.add(t);
  for (const c of (data.cards ?? [])) {
    for (const t of normalizeTags(c.tags ?? [])) set.add(t);
    for (const t of normalizeTags(c.tagExcludes ?? [])) set.add(t);
  }
  data.tags = Array.from(set).sort((a, b) => a.localeCompare(b));
}

function migrateV2toV3(v2) {
  const v3 = emptyData();
  v3.createdAt = v2.createdAt ?? v3.createdAt;
  v3.settings = v2.settings ?? { lastDeckId: null };

  v3.decks = (v2.decks ?? []).map(d => ({
    id: d.id,
    name: d.name ?? "Untitled deck",
    tags: normalizeTags(d.tags ?? []),
    createdAt: d.createdAt ?? now(),
    updatedAt: d.updatedAt ?? now()
  }));

  v3.cards = (v2.cards ?? []).map(c => ({
    id: c.id,
    deckId: c.deckId,
    front: c.front ?? "",
    back: c.back ?? "",
    notes: c.notes ?? "",
    tags: normalizeTags(c.tags ?? []),
    tagExcludes: normalizeTags(c.tagExcludes ?? []),
    createdAt: c.createdAt ?? now(),
    updatedAt: c.updatedAt ?? now(),
    progress: {
      lastReviewed: c.progress?.lastReviewed ?? null,
      reviews: c.progress?.reviews ?? 0
    }
  }));

  v3.tags = normalizeTags(v2.tags ?? []);
  syncRegistry(v3);

  if (v3.settings?.lastDeckId && !v3.decks.some(d => d.id === v3.settings.lastDeckId)) {
    v3.settings.lastDeckId = v3.decks[0]?.id ?? null;
  }
  return v3;
}

function migrateV3toV4(v3) {
  const v4 = emptyData();
  v4.createdAt = v3.createdAt ?? v4.createdAt;
  v4.tags = normalizeTags(v3.tags ?? []);
  v4.decks = (v3.decks ?? []).map(d => ({
    id: d.id,
    name: d.name ?? "Untitled deck",
    tags: normalizeTags(d.tags ?? []),
    createdAt: d.createdAt ?? now(),
    updatedAt: d.updatedAt ?? now()
  }));
  v4.cards = (v3.cards ?? []).map(c => ({
    id: c.id,
    deckId: c.deckId,
    front: c.front ?? "",
    back: c.back ?? "",
    notes: c.notes ?? "",
    tags: normalizeTags(c.tags ?? []),
    tagExcludes: normalizeTags(c.tagExcludes ?? []),
    createdAt: c.createdAt ?? now(),
    updatedAt: c.updatedAt ?? now(),
    progress: {
      lastReviewed: c.progress?.lastReviewed ?? null,
      reviews: c.progress?.reviews ?? 0
    }
  }));
  v4.sessions = Array.isArray(v3.sessions) ? v3.sessions : [];
  v4.settings = v3.settings ?? { lastDeckId: null };
  syncRegistry(v4);

  if (v4.settings?.lastDeckId && !v4.decks.some(d => d.id === v4.settings.lastDeckId)) {
    v4.settings.lastDeckId = v4.decks[0]?.id ?? null;
  }
  return v4;
}


export function loadData() {
  try {
    const raw4 = localStorage.getItem(KEY);
    if (raw4) return repairData(JSON.parse(raw4));

    const raw3 = localStorage.getItem("vt.data.v3");
    if (raw3) {
      const v3 = JSON.parse(raw3);
      const v4 = migrateV3toV4(v3);
      saveData(v4);
      return v4;
    }

    // Backward keys
    const raw2 = localStorage.getItem("vt.data.v2");
    if (raw2) {
      const v2 = JSON.parse(raw2);
      const v3 = migrateV2toV3(v2);
      saveData(v3);
      return v3;
    }

    const raw1 = localStorage.getItem("vt.data.v1");
    if (raw1) {
      // v1 is legacy; try to parse and lift minimally
      const v1 = JSON.parse(raw1);
      const v2like = {
        version: 2,
        createdAt: v1.createdAt,
        decks: (v1.decks ?? []).map(d => ({ ...d, tags: d.tags ?? [] })),
        cards: (v1.cards ?? []).map(c => ({
          ...c,
          progress: { lastReviewed: c.srs?.lastReviewed ?? null, reviews: c.srs?.repetitions ?? 0 }
        })),
        settings: v1.settings ?? { lastDeckId: null }
      };
      const v3 = migrateV2toV3(v2like);
      saveData(v3);
      return v3;
    }

    return emptyData();
  } catch {
    return emptyData();
  }
}

export function saveData(data) {
  syncRegistry(data);
  localStorage.setItem(KEY, JSON.stringify(data));
}

function repairData(data) {
  if (!data || typeof data !== "object") return emptyData();

  if (data.version === 3) {
    const v4 = migrateV3toV4(data);
    saveData(v4);
    return v4;
  }

  if (data.version === 2) {
    const v3 = migrateV2toV3(data);
    const v4 = migrateV3toV4(v3);
    saveData(v4);
    return v4;
  }
  if (data.version === 1) {
    // handled via loadData path, but keep safe
    return migrateV3toV4(migrateV2toV3({
      version: 2,
      createdAt: data.createdAt,
      decks: data.decks ?? [],
      cards: (data.cards ?? []).map(c => ({
        ...c,
        progress: { lastReviewed: c.srs?.lastReviewed ?? null, reviews: c.srs?.repetitions ?? 0 }
      })),
      settings: data.settings ?? { lastDeckId: null }
    }));
  }

  if (data.version !== 4) return emptyData();

  data.tags ??= [];
  data.decks ??= [];
  data.cards ??= [];
  data.sessions ??= [];
  data.settings ??= { lastDeckId: null };

  data.tags = normalizeTags(data.tags);

  data.decks = data.decks.map(d => ({
    id: d.id,
    name: d.name ?? "Untitled deck",
    tags: normalizeTags(d.tags ?? []),
    createdAt: d.createdAt ?? now(),
    updatedAt: d.updatedAt ?? now()
  }));

  data.cards = data.cards.map(c => ({
    id: c.id,
    deckId: c.deckId,
    kind: c.kind ?? "basic",           // "basic" | "single" | "multi"
    imageData: c.imageData ?? null,    // data URL (optional)
    choices: normalizeChoices(c.choices, c.kind),
    front: c.front ?? "",
    back: c.back ?? "",
    notes: c.notes ?? "",
    tags: normalizeTags(c.tags ?? []),
    tagExcludes: normalizeTags(c.tagExcludes ?? []),
    createdAt: c.createdAt ?? now(),
    updatedAt: c.updatedAt ?? now(),
    progress: {
      lastReviewed: c.progress?.lastReviewed ?? null,
      reviews: c.progress?.reviews ?? 0
    }
  }));

  data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  data.sessions = data.sessions
    .filter(s => s && typeof s === "object")
    .map(s => ({
      ...s,
      id: s.id ?? uid("sess"),
      startedAt: s.startedAt ?? null,
      endedAt: s.endedAt ?? null,
      totalPlanned: s.totalPlanned ?? 0,
      again: s.again ?? 0,
      hard: s.hard ?? 0,
      easy: s.easy ?? 0,
      reveals: s.reveals ?? 0,
      sources: s.sources ?? { deckIds: [], tags: [] }
    }));

  syncRegistry(data);
  return data;
}

export function upsertDeck(data, deck) {
  deck.tags = normalizeTags(deck.tags ?? []);
  const i = data.decks.findIndex(d => d.id === deck.id);
  if (i === -1) data.decks.push(deck);
  else data.decks[i] = deck;
  syncRegistry(data);
}

export function removeDeck(data, deckId) {
  data.decks = data.decks.filter(d => d.id !== deckId);
  data.cards = data.cards.filter(c => c.deckId !== deckId);
  if (data.settings.lastDeckId === deckId) data.settings.lastDeckId = null;
  syncRegistry(data);
}

export function upsertCard(data, card) {
  card.tags = normalizeTags(card.tags ?? []);
  card.tagExcludes = normalizeTags(card.tagExcludes ?? []);
  card.progress ??= { lastReviewed: null, reviews: 0 };
  const i = data.cards.findIndex(c => c.id === card.id);
  if (i === -1) data.cards.push(card);
  else data.cards[i] = card;
  syncRegistry(data);
}

export function removeCard(data, cardId) {
  data.cards = data.cards.filter(c => c.id !== cardId);
  syncRegistry(data);
}

export function renameTagEverywhere(data, oldName, newName) {
  const oldT = String(oldName ?? "").trim();
  const newT = String(newName ?? "").trim();
  if (!oldT || !newT) return;
  for (const d of data.decks) {
    d.tags = d.tags.map(t => t === oldT ? newT : t);
  }
  for (const c of data.cards) {
    c.tags = c.tags.map(t => t === oldT ? newT : t);
    c.tagExcludes = c.tagExcludes.map(t => t === oldT ? newT : t);
  }
  data.tags = data.tags.map(t => t === oldT ? newT : t);
  syncRegistry(data);
}

export function deleteTagEverywhere(data, tagName) {
  const t = String(tagName ?? "").trim();
  if (!t) return;
  for (const d of data.decks) d.tags = d.tags.filter(x => x !== t);
  for (const c of data.cards) {
    c.tags = c.tags.filter(x => x !== t);
    c.tagExcludes = c.tagExcludes.filter(x => x !== t);
  }
  data.tags = data.tags.filter(x => x !== t);
  syncRegistry(data);
}


function mergeSessions(a, b) {
  const map = new Map();
  for (const s of (Array.isArray(a) ? a : [])) map.set(s.id, s);
  for (const s of (Array.isArray(b) ? b : [])) map.set(s.id, s);
  return Array.from(map.values()).sort((x, y) => (x.endedAt ?? 0) - (y.endedAt ?? 0)).slice(-500);
}

export function addSession(data, session) {
  data.sessions ??= [];
  data.sessions.push(session);
  data.sessions = mergeSessions(data.sessions, []);
}

export function exportJSON(data) {
  syncRegistry(data);
  return JSON.stringify({ ...data, exportedAt: now() }, null, 2);
}

export function importJSON(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || (parsed.version !== 4 && parsed.version !== 3 && parsed.version !== 2 && parsed.version !== 1)) {
    throw new Error("Invalid backup format.");
  }
  return repairData(parsed);
}

export function mergeData(current, incoming) {
  const byIdDeck = new Map(current.decks.map(d => [d.id, d]));
  for (const d of incoming.decks) byIdDeck.set(d.id, d);

  const byIdCard = new Map(current.cards.map(c => [c.id, c]));
  for (const c of incoming.cards) byIdCard.set(c.id, c);

  const merged = {
    ...current,
    decks: [...byIdDeck.values()],
    cards: [...byIdCard.values()],
    tags: normalizeTags([...(current.tags ?? []), ...(incoming.tags ?? [])]),
    sessions: mergeSessions(current.sessions ?? [], incoming.sessions ?? []),
    settings: {
      ...current.settings,
      ...incoming.settings
    }
  };
  syncRegistry(merged);
  return merged;
}
