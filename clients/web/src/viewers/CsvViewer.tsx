import { useMemo, useState } from 'react';
import type { ViewerProps } from '../kernel/viewers';
import { SaveFooter, ViewerBar, useSave } from './common';
import { applyGrid, columnLetter, delimiterFor, parseCsv, toGrid } from './csv';

/** Rows drawn at once; the rest are in the file and in a save, just not on screen (a 10,000-row export must not freeze the page). */
const ROW_LIMIT = 500;

/**
 * CSV as an editable table (PLAN wireframe "CSV viewer"): column letters, row numbers, `+ Add row`, Raw. Saving patches the
 * original text, so editing one cell changes that cell and nothing else in the commit.
 */
export default function CsvViewer({ path, text = '', readOnly, onSave, context }: ViewerProps) {
  const delimiter = delimiterFor(path);
  const [savedText, setSavedText] = useState(text);
  const [base, setBase] = useState(() => parseCsv(text, delimiter));
  const [grid, setGrid] = useState<string[][]>(() => toGrid(parseCsv(text, delimiter)));
  const [rawText, setRawText] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const saver = useSave(onSave);

  const current = useMemo(() => rawText ?? applyGrid(base, grid), [rawText, base, grid]);
  const dirty = current !== savedText;
  const width = Math.max(1, ...grid.map((r) => r.length));

  const rebase = (next: string) => {
    const doc = parseCsv(next, delimiter);
    setBase(doc);
    setGrid(toGrid(doc));
    setRawText(null);
  };

  const setCell = (r: number, c: number, value: string) => {
    saver.reset();
    setGrid((g) => g.map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? value : v)) : row)));
  };
  const addRow = () => {
    saver.reset();
    setGrid((g) => [...g, Array.from({ length: width }, () => '')]);
  };
  const toggleRaw = () => {
    if (raw && rawText !== null) rebase(rawText);
    setRaw(!raw);
  };
  const doSave = async () => {
    if (await saver.save(current)) {
      setSavedText(current);
      rebase(current);
    }
  };

  const shown = grid.slice(0, ROW_LIMIT);
  return (
    <div className="vw csv" data-testid="viewer-csv" data-dirty={dirty}>
      <ViewerBar path={path}>
        {!readOnly ? (
          <button type="button" className="btn primary sm" disabled={!dirty || saver.status === 'saving'} onClick={() => void doSave()}>
            {saver.status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <button type="button" className="btn sm" aria-pressed={raw} onClick={toggleRaw}>Raw</button>
      </ViewerBar>

      {raw ? (
        <textarea
          className="md-raw"
          aria-label="Raw CSV"
          spellCheck={false}
          value={current}
          readOnly={readOnly}
          onChange={(e) => {
            setRawText(e.target.value);
            saver.reset();
          }}
        />
      ) : (
        <div className="csv-scroll">
          <table className="csv-table">
            <thead>
              <tr>
                <th className="csv-corner" aria-label="Row" />
                {Array.from({ length: width }, (_, c) => (
                  <th key={c} scope="col">{columnLetter(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, r) => (
                <tr key={r} className={r === 0 ? 'csv-head-row' : undefined}>
                  <th scope="row" className="csv-rownum">{r + 1}</th>
                  {Array.from({ length: width }, (_, c) => (
                    <td key={c} className={(row[c] ?? '') !== (base.rows[r]?.[c]?.value ?? '') ? 'csv-changed' : undefined}>
                      <input
                        data-testid="csv-cell"
                        data-row={r}
                        data-col={c}
                        aria-label={`Row ${r + 1}, column ${columnLetter(c)}`}
                        value={row[c] ?? ''}
                        readOnly={readOnly}
                        onChange={(e) => setCell(r, c, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {grid.length > ROW_LIMIT ? <p className="vw-note">Showing the first {ROW_LIMIT} of {grid.length} rows.</p> : null}
          {!readOnly ? <button type="button" className="csv-add" onClick={addRow}>+ Add row</button> : null}
        </div>
      )}
      <SaveFooter authorName={context.authorName} status={saver.status} message={saver.message} readOnly={readOnly} />
    </div>
  );
}
