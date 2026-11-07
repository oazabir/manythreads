import type { ReactNode } from 'react';

/** The part of the day, in the reader's own clock: the greeting on a new chat. */
export function greetingFor(name: string, hour: number): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  const part = hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return first === '' ? part : `${part}, ${first}`;
}

/**
 * A chat that has no messages yet: a greeting, up to four things to ask (the bot's own example questions, or the platform's defaults) and the message
 * box. Pressing one sends it at once; there is no "new conversation" step beyond sending.
 */
export function EmptyChat({ name, botName, prompts, disabled, onPick, children, blocked }: {
  name: string;
  botName: string;
  prompts: readonly string[];
  disabled: boolean;
  onPick: (prompt: string) => void;
  children: ReactNode;
  /** Why nobody can ask right now (a bot that is turned off): said in place of the chips. */
  blocked: string | null;
}) {
  return (
    <div className="ch-empty" data-testid="chat-empty">
      <h2 className="ch-greeting" data-testid="chat-greeting">{greetingFor(name, new Date().getHours())}</h2>
      <p className="ch-greeting-sub">What can {botName} help with?</p>
      {blocked !== null ? (
        <p className="ch-blocked" role="status" data-testid="chat-blocked">{blocked}</p>
      ) : (
        <div className="ch-chips" data-testid="chat-prompts">
          {prompts.slice(0, 4).map((p) => (
            <button key={p} type="button" className="ch-chip" disabled={disabled} data-testid="chat-prompt" onClick={() => onPick(p)}>{p}</button>
          ))}
        </div>
      )}
      <div className="ch-empty-box">{children}</div>
    </div>
  );
}
