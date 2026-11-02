import { useState } from 'react';

/** A value that is shown once (an address, a token, a secret) with a Copy button; the text stays selectable when the clipboard is blocked. */
export function CopyBox({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      } catch {
        // the clipboard may be blocked; the text stays selectable
      }
    })();
  };
  return (
    <div className="wh-copy">
      <code className="wh-copy-value" data-testid={testId} tabIndex={0} aria-label={label}>{value}</code>
      <button type="button" className="btn" onClick={copy} data-testid={`${testId}-copy`}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
