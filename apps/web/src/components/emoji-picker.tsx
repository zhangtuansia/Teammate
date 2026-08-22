'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from 'lucide-react';
import type { TranslationKey } from '@/hooks/use-app-settings';
import { EMOJI, type EmojiEntry } from '@/lib/emoji-data';
import { readRecentEmoji, rememberRecentEmoji } from '@/lib/emoji';

const COLUMNS = 9;

/** The tab strip, in Unicode's own order, each shown by a representative. */
const TABS: Array<{ group: number; key: string; icon: string; label: TranslationKey }> = [
  { group: 0, icon: '😀', key: 'smileys', label: 'emoji.group.smileys' },
  { group: 1, icon: '👋', key: 'people', label: 'emoji.group.people' },
  { group: 3, icon: '🐶', key: 'nature', label: 'emoji.group.nature' },
  { group: 4, icon: '🍎', key: 'food', label: 'emoji.group.food' },
  { group: 5, icon: '✈️', key: 'travel', label: 'emoji.group.travel' },
  { group: 6, icon: '⚽', key: 'activities', label: 'emoji.group.activities' },
  { group: 7, icon: '💡', key: 'objects', label: 'emoji.group.objects' },
  { group: 8, icon: '❤️', key: 'symbols', label: 'emoji.group.symbols' },
  { group: 9, icon: '🏳️', key: 'flags', label: 'emoji.group.flags' },
];

const BY_GROUP = new Map<number, EmojiEntry[]>();
for (const entry of EMOJI) {
  const list = BY_GROUP.get(entry[1]);
  if (list) list.push(entry);
  else BY_GROUP.set(entry[1], [entry]);
}

const BY_CHARACTER = new Map(EMOJI.map((entry) => [entry[0], entry]));

/**
 * Search prefers a match at the start of a word: typing "car" should offer 🚗
 * before 🃏 for "playing card", and matching anywhere would bury the obvious
 * answer under every "scarf" and "carpentry".
 */
function search(query: string): EmojiEntry[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return [];
  const leading: EmojiEntry[] = [];
  const inner: EmojiEntry[] = [];
  // Chinese is written without spaces, so there are no word starts to prefer.
  const wordless = needle.charCodeAt(0) > 0x2e80;
  for (const entry of EMOJI) {
    const terms = entry[3];
    const at = terms.indexOf(needle);
    if (at === -1) continue;
    if (wordless || at === 0 || terms[at - 1] === ' ') leading.push(entry);
    else inner.push(entry);
  }
  return [...leading, ...inner].slice(0, 108);
}

interface Section {
  key: string;
  label: string;
  entries: EmojiEntry[];
}

/**
 * The whole set, which is the point of a picker. No network and no images: the
 * emoji are text drawn by the system font, so they match the ones in the
 * messages above and work with no connection at all.
 */
export function EmojiPicker({
  onPick,
  t,
}: {
  onPick: (emoji: string) => void;
  t: (key: TranslationKey) => string;
}) {
  const [query, setQuery] = useState('');
  // Read once on mount. The picker is only ever built by opening it, so there
  // is no server render for this to disagree with.
  const [recent, setRecent] = useState<string[]>(readRecentEmoji);
  const [activeTab, setActiveTab] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const searching = query.trim().length > 0;

  const sections = useMemo<Section[]>(() => {
    if (searching) {
      const found = search(query);
      return found.length ? [{ entries: found, key: 'results', label: t('emoji.results') }] : [];
    }
    const all: Section[] = [];
    if (recent.length) {
      all.push({
        // A character saved before this build, or from another device, may not
        // be in our table; it can still be shown and picked.
        entries: recent.map((char) => BY_CHARACTER.get(char) ?? ([char, -1, char, ''] as EmojiEntry)),
        key: 'recent',
        label: t('emoji.recent'),
      });
    }
    for (const tab of TABS) {
      const entries = BY_GROUP.get(tab.group);
      if (entries?.length) all.push({ entries, key: tab.key, label: t(tab.label) });
    }
    return all;
  }, [query, recent, searching, t]);

  const choose = (emoji: string) => {
    setRecent(rememberRecentEmoji(emoji));
    onPick(emoji);
  };

  const jumpTo = (key: string, index: number) => {
    setActiveTab(index);
    setQuery('');
    // The full list only replaces the search results on the next paint, so the
    // heading to scroll to does not exist yet.
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-section="${key}"]`)?.scrollIntoView({ block: 'start' });
    });
  };

  // Scrolling through the list moves the tab strip with it, so the highlight
  // always says where you are rather than where you last clicked.
  const syncTab = useCallback(() => {
    const container = scrollRef.current;
    if (!container || searching) return;
    let current = 0;
    for (const [index, tab] of TABS.entries()) {
      const section = container.querySelector(`[data-section="${tab.key}"]`);
      if (!(section instanceof HTMLElement)) continue;
      if (section.offsetTop - container.scrollTop <= 8) current = index;
    }
    setActiveTab(current);
  }, [searching]);

  return (
    <div className="flex h-80 w-[332px] flex-col overflow-hidden">
      <div className="p-2 pb-1">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-lg bg-accent/60 pl-7 pr-2 text-[13px] outline-none placeholder:text-muted-foreground focus:bg-background focus:shadow-[0_0_0_1px_var(--border)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('emoji.search')}
            ref={inputRef}
            type="text"
            value={query}
          />
        </div>
      </div>

      <div className="flex items-center gap-0.5 border-b px-2 pb-1">
        {TABS.map((tab, index) => (
          <button
            aria-label={t(tab.label)}
            aria-pressed={activeTab === index && !searching}
            className={`flex size-7 items-center justify-center rounded text-[15px] leading-none transition-colors ${
              activeTab === index && !searching
                ? 'bg-accent'
                : 'opacity-60 hover:bg-accent/60 hover:opacity-100'
            }`}
            key={tab.key}
            onClick={() => jumpTo(tab.key, index)}
            title={t(tab.label)}
            type="button"
          >
            {tab.icon}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1" onScroll={syncTab} ref={scrollRef}>
        {sections.length === 0 && (
          <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">{t('emoji.empty')}</p>
        )}
        {sections.map((section) => (
          <section data-section={section.key} key={section.key}>
            <h3 className="sticky top-0 z-10 bg-popover px-1 py-1 text-[11px] font-medium text-muted-foreground">
              {section.label}
            </h3>
            <div
              className="grid gap-0.5"
              style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
            >
              {section.entries.map((entry, index) => (
                <button
                  aria-label={entry[2]}
                  className="flex aspect-square items-center justify-center rounded text-[19px] leading-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  key={`${section.key}-${entry[0]}-${index}`}
                  onClick={() => choose(entry[0])}
                  title={entry[2]}
                  type="button"
                >
                  {entry[0]}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
