import { customEmojiNameOf } from '@manythreads/shared';
import { customEmojiImageUrl } from '../api/endpoints';
import { useCustomEmoji } from './customEmoji';

/** The picture of one custom emoji, at the size of the text around it. The text is its alternative, so a reader without pictures still gets `:name:`. */
export function CustomEmojiImg({ id, name }: { id: string; name: string }) {
  return <img className="cemoji" src={customEmojiImageUrl(id)} alt={`:${name}:`} title={`:${name}:`} loading="lazy" decoding="async" draggable={false} />;
}

/** An emoji as a reaction or a "recently used" cell shows it: the character, or the picture of a custom emoji (`:name:`) while the workspace still has it. */
export function EmojiGlyph({ value }: { value: string }) {
  const { byName } = useCustomEmoji();
  const name = customEmojiNameOf(value);
  const hit = name ? byName.get(name) : undefined;
  return hit ? <CustomEmojiImg id={hit.id} name={hit.name} /> : <span>{value}</span>;
}
