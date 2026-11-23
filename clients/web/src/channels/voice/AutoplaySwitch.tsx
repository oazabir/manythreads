import { useAutoplay } from './autoplay';

/** The box that turns autoplay of incoming voice messages on and off (owner 2026-11-23), in the header of a thread and of a direct-message conversation. */
export function AutoplaySwitch() {
  const [on, set] = useAutoplay();
  return (
    <label className="vp-auto" title="Play incoming voice messages here by themselves" data-testid="voice-autoplay-switch">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} data-testid="voice-autoplay-box" />
      <span>Autoplay voice</span>
    </label>
  );
}
