import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EMOJI_GROUPS, SKIN_TONES, loadRecent, loadTone, pushRecent, saveRecent, saveTone, searchEmoji, takesTone, withTone } from './emoji';

/** Cells in a row of the grid: the Up and Down arrows move by this many. */
const COLUMNS = 8;

/**
 * The emoji picker (PLAN P14-02): a search box, a skin tone, the ones used last, and the built-in groups. Arrow keys move over the grid, Enter or a
 * click picks, Esc closes. It is drawn inside the thing that opens it (the composer) so that focus stays within it.
 */
export function EmojiPicker({ onPick, onClose, label = 'Emoji' }: { onPick: (char: string) => void; onClose: () => void; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(loadTone);
  const [recent, setRecent] = useState(loadRecent);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const found = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim() !== '';

  const pick = (char: string): void => {
    const next = pushRecent(recent, char);
    setRecent(next);
    saveRecent(next);
    onPick(char);
  };
  const chooseTone = (id: number): void => {
    setTone(id);
    saveTone(id);
  };

  const cells = (): HTMLButtonElement[] => [...(root.current?.querySelectorAll<HTMLButtonElement>('.emp-cell') ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const list = cells();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? COLUMNS : e.key === 'ArrowUp' ? -COLUMNS : 0;
    if (step === 0 || list.length === 0) return;
    // from the search box, Down goes into the grid; from a cell the arrows move on it, and Up from the first row goes back to the search box
    if (at < 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[0]?.focus();
      }
      return;
    }
    e.preventDefault();
    const to = at + step;
    if (to < 0) search.current?.focus();
    else list[Math.min(to, list.length - 1)]?.focus();
  };

  const cell = (char: string, name: string, key: string) => {
    const shown = withTone(char, tone);
    return (
      <button key={key} type="button" className="emp-cell" aria-label={name} title={name} onClick={() => pick(shown)}>
        <span aria-hidden="true">{shown}</span>
      </button>
    );
  };

  const jump = (id: string): void => {
    body.current?.querySelector<HTMLElement>(`[data-group="${id}"]`)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div ref={root} className="emp" role="dialog" aria-label={label} data-testid="emoji-picker" onKeyDown={onKeyDown}>
      <div className="emp-head">
        <input
          ref={search}
          className="emp-search"
          type="search"
          aria-label="Search emoji"
          placeholder="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="emp-tones" role="radiogroup" aria-label="Skin tone">
          {SKIN_TONES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={tone === t.id}
              aria-label={t.label}
              title={t.label}
              className={`emp-tone ${tone === t.id ? 'on' : ''}`}
              onClick={() => chooseTone(t.id)}
            >
              <span aria-hidden="true">{withTone('✋', t.id)}</span>
            </button>
          ))}
        </div>
      </div>
      <div ref={body} className="emp-body">
        {searching ? (
          found.length > 0 ? (
            <div className="emp-grid" role="group" aria-label="Results" data-testid="emoji-results">
              {found.map((e) => cell(e.char, e.name, `s-${e.char}`))}
            </div>
          ) : (
            <p className="emp-empty">No emoji has that name.</p>
          )
        ) : (
          <>
            {recent.length > 0 ? (
              <section data-group="recent" aria-label="Recently used">
                <h3>Recently used</h3>
                <div className="emp-grid" role="group" aria-label="Recently used" data-testid="emoji-recent">
                  {recent.map((c) => (
                    <button key={`r-${c}`} type="button" className="emp-cell" aria-label={`${c} (recent)`} onClick={() => pick(c)}>
                      <span aria-hidden="true">{c}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {EMOJI_GROUPS.map((g) => (
              <section key={g.id} data-group={g.id} aria-label={g.label}>
                <h3>{g.label}</h3>
                <div className="emp-grid" role="group" aria-label={g.label}>
                  {g.items.map((e) => cell(e.char, takesTone(e.char) && tone > 0 ? `${e.name} (${SKIN_TONES[tone]?.label ?? ''})` : e.name, `${g.id}-${e.char}`))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
      {searching ? null : (
        <div className="emp-tabs" role="toolbar" aria-label="Emoji groups">
          {EMOJI_GROUPS.map((g) => (
            <button key={g.id} type="button" className="emp-tab" aria-label={g.label} title={g.label} onClick={() => jump(g.id)}>
              <span aria-hidden="true">{g.icon}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
