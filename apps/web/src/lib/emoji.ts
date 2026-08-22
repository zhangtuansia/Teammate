/**
 * U+FE0F asks for the colourful emoji rendering of a character that also has a
 * plain-text form. It is invisible, so `❤️` and `❤` look alike in a chip while
 * being different strings — reacting with one to a message that already has the
 * other would stack two identical-looking chips side by side.
 *
 * Reactions are therefore grouped by the string without it. The selector is not
 * removed from what gets stored: for `❤`, `✔` and friends it is the difference
 * between a red heart and a small black one.
 */
export function reactionKey(emoji: string) {
  return emoji.replace(/\uFE0F/g, "");
}

/**
 * Which of two spellings of the same reaction to show. The longer one is the
 * one carrying the variation selector, and so the one that renders in colour.
 */
export function preferredEmojiForm(a: string, b: string) {
  return b.length > a.length ? b : a;
}

const RECENT_KEY = "teammate.recent-emoji";
const RECENT_LIMIT = 24;

/** What you reached for last, which is what you will reach for next. */
export function readRecentEmoji(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...readRecentEmoji().filter((entry) => reactionKey(entry) !== reactionKey(emoji))].slice(
    0,
    RECENT_LIMIT,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A workspace with no storage available still gets a working picker.
  }
  return next;
}
