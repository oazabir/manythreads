import { useEffect, useId, useState } from 'react';
import { isApiError } from '../api/client';
import { addCustomEmoji, deleteCustomEmoji } from '../api/endpoints';
import { customEmojiChanged, nameFromFile, nameProblem, pictureProblem, toBase64 } from './customEmoji';

/** The words for a refused add, in plain language (the server's own sentence when it has one). */
export function addFailureText(err: unknown): string {
  if (isApiError(err)) {
    if (err.status === 403) return 'Only workspace admins can add emoji.';
    if (err.status === 409) return err.message;
    if (err.status === 413) return 'The picture is too big.';
    if (err.status === 429) return 'That is too many at once. Try again in a minute.';
    return err.message;
  }
  return 'The emoji could not be added. Try again.';
}

/**
 * Adding a custom emoji (admins only): a picture, a name, Add. The name is suggested from the file's name. The picture is sent as it is; the server checks
 * what it really is, how big, and that the name is free. The picker shows the new emoji once it is added.
 */
export function AddCustomEmoji({ onAdded }: { onAdded: (name: string) => void }) {
  const nameId = useId();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (f: File | null): void => {
    setError(null);
    if (!f) return setFile(null);
    const problem = pictureProblem(f);
    if (problem) {
      setFile(null);
      return setError(problem);
    }
    setFile(f);
    setName((n) => (n === '' ? nameFromFile(f.name) : n));
  };

  const add = async (): Promise<void> => {
    if (busy) return;
    if (!file) return setError('Choose a picture first.');
    const wrong = nameProblem(name);
    if (wrong) return setError(wrong);
    setBusy(true);
    setError(null);
    try {
      const data = toBase64(new Uint8Array(await file.arrayBuffer()));
      await addCustomEmoji({ name, contentType: file.type as 'image/png', data });
      customEmojiChanged();
      setFile(null);
      setName('');
      onAdded(name);
    } catch (err) {
      setError(addFailureText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="emp-add"
      aria-label="Add a custom emoji"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label htmlFor={fileId}>Picture (PNG, JPEG, GIF or WebP, up to 256 KB)</label>
      <div className="emp-add-row">
        {preview ? <img className="cemoji big" src={preview} alt="" /> : null}
        <input id={fileId} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      </div>
      <label htmlFor={nameId}>Name</label>
      <div className="emp-add-row">
        <span aria-hidden="true">:</span>
        <input id={nameId} className="emp-add-name" value={name} maxLength={32} autoComplete="off" spellCheck={false} onChange={(e) => { setName(e.target.value.toLowerCase()); setError(null); }} />
        <span aria-hidden="true">:</span>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
      {error ? <p className="emp-add-error" role="alert">{error}</p> : null}
    </form>
  );
}

/** Asks before an emoji is removed: messages that use it keep the text `:name:`. */
export function RemoveCustomEmoji({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await deleteCustomEmoji(id);
      customEmojiChanged();
      onDone();
    } catch (err) {
      setError(isApiError(err) && err.status === 403 ? 'Only workspace admins can remove emoji.' : 'The emoji could not be removed. Try again.');
      setBusy(false);
    }
  };
  return (
    <div className="emp-remove" role="group" aria-label={`Remove :${name}:`}>
      <span>{`Remove :${name}:? Messages that use it will show the text :${name}: instead.`}</span>
      <button type="button" className="btn" onClick={onDone} disabled={busy}>Keep it</button>
      <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>Remove</button>
      {error ? <p className="emp-add-error" role="alert">{error}</p> : null}
    </div>
  );
}
