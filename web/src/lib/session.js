import { now } from "./storage.js";

/**
 * Session scheduling rules (no due dates):
 * - Again: show again after a few other cards (default +4 positions)
 * - Hard: push to end
 * - Easy: mark done for this session (remove from queue)
 */

export const RATINGS = {
  AGAIN: "again",
  HARD: "hard",
  EASY: "easy"
};

export function shuffle(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function applySessionRating(queue, idx, rating, opts = {}) {
  const againGap = Number(opts.againGap ?? 4);

  const id = queue[idx];
  if (!id) return { queue, idx, doneId: null };

  // Remove current card from the queue; next card becomes the same idx.
  const nextQueue = queue.slice(0, idx).concat(queue.slice(idx + 1));

  if (rating === RATINGS.EASY) {
    return { queue: nextQueue, idx, doneId: id };
  }

  if (rating === RATINGS.HARD) {
    nextQueue.push(id);
    return { queue: nextQueue, idx, doneId: null };
  }

  // AGAIN
  const insertAt = Math.min(nextQueue.length, idx + againGap);
  nextQueue.splice(insertAt, 0, id);
  return { queue: nextQueue, idx, doneId: null };
}

export function touchProgress(progress) {
  return {
    lastReviewed: now(),
    reviews: (progress?.reviews ?? 0) + 1
  };
}
