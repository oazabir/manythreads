import { CaretIcon } from './icons';

/** The chevron at the start of a sidebar section heading: folds or opens the section. */
export function FoldButton({ folded, label, onToggle }: { folded: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" className="sec-fold" aria-expanded={!folded} aria-label={`${label}, ${folded ? 'folded' : 'open'}`} onClick={onToggle}>
      <CaretIcon open={!folded} />
    </button>
  );
}
