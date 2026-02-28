import { uid, now } from "./storage.js";

export function makeSample() {
  const deck1 = {
    id: uid("deck"),
    name: "Starter pack",
    tags: ["Basics"],
    createdAt: now(),
    updatedAt: now()
  };

  const deck2 = {
    id: uid("deck"),
    name: "Mini phrases",
    tags: ["Phrases"],
    createdAt: now(),
    updatedAt: now()
  };

  const cards1 = [
    ["Guten Morgen", "Good morning", ["Greeting"]],
    ["Wie geht's?", "How are you?", ["Greeting"]],
    ["Danke", "Thank you", ["Basics"]],
    ["Bitte", "You're welcome / please", ["Basics"]],
    ["Ich verstehe nicht", "I don't understand", ["Phrases"]],
    ["Vielleicht", "Maybe", ["Basics"]],
    ["Wichtig", "Important", ["Basics"]],
    ["Entscheidung", "Decision", ["Basics"]]
  ].map(([front, back, tags]) => ({
    id: uid("card"),
    deckId: deck1.id,
    front,
    back,
    notes: "",
    tags,
    tagExcludes: [],
    createdAt: now(),
    updatedAt: now(),
    progress: { lastReviewed: null, reviews: 0 }
  }));

  const cards2 = [
    ["Ich hätte gern …", "I would like …", ["Phrases"]],
    ["Können Sie mir helfen?", "Can you help me?", ["Phrases"]],
    ["Wie viel kostet das?", "How much does it cost?", ["Phrases"]],
    ["Wo ist der Bahnhof?", "Where is the train station?", ["Travel", "Phrases"]]
  ].map(([front, back, tags]) => ({
    id: uid("card"),
    deckId: deck2.id,
    front,
    back,
    notes: "",
    tags,
    tagExcludes: [],
    createdAt: now(),
    updatedAt: now(),
    progress: { lastReviewed: null, reviews: 0 }
  }));

  return {
    decks: [deck1, deck2],
    cards: [...cards1, ...cards2],
    tags: ["Basics", "Greeting", "Phrases", "Travel"]
  };
}
