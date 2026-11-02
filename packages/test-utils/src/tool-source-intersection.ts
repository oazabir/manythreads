import { describe, expect, it } from 'vitest';

// The one test every source of tools must pass (PLAN Phase 8 "0 · Reflect and refactor"): what a tool can do for a run is the bot's capabilities INTERSECTED with
// what the person who asked may see. Neither side widens the other:
//
//   bot granted, asker can see   -> the tool is listed and the call goes through;
//   bot NOT granted, asker sees  -> not listed, and a call is refused as `forbidden`;
//   bot granted, asker cannot see -> a READ is refused (a read runs as the asker, so it reaches nothing they could not open);
//                                    a WRITE still goes through: it is the bot's own act, judged by the bot's grant and the approval rules, not by the asker;
//   neither                       -> not listed, refused.
//
// A source plugs in by describing the world once. The helper only asks three questions of it (what is listed, what happens on a call) and one instruction (put the
// world in this state), so it is the same for connections today and for every source after them (knowledge, drives, code hosts): run it on each source you add.
//
//     describeToolSourceIntersection('connections', () => ({ tool: 'email.read', kind: 'read', arrange, listed, call }));

/** The four states of the matrix. `botGranted`: a grant for the tool exists for the bot (and whatever else the source needs is in order). `askerVisible`: the asker may see what the tool reaches. */
export interface IntersectionState {
  botGranted: boolean;
  askerVisible: boolean;
}

/** What a call answered, in terms every source can give: refused or not, with the refusal's code when it was one, and the text for diagnosing a failure. */
export interface CallOutcome {
  refused: boolean;
  /** `forbidden`, `not_found`, ... when the call was refused; undefined when it was not. */
  code?: string | undefined;
  /** The answer as text; shown only if an expectation fails. */
  text: string;
}

export interface ToolSourceSubject {
  /** The tool under test (a capability name such as `email.read`). */
  tool: string;
  /** `read` runs as the asker, `write` runs as the bot. */
  kind: 'read' | 'write';
  /** Puts the world in `state`, from any earlier state (it is called before every case, in a fixed order, so it must be able to go both ways). */
  arrange(state: IntersectionState): Promise<void>;
  /** The tool names the gateway lists for the bot in the current state (`tools/list` as the MCP endpoint answers it). */
  listed(): Promise<readonly string[]>;
  /** Calls the tool for a run of the bot that was asked by the person (`tools/call`), in the current state. */
  call(): Promise<CallOutcome>;
}

/** Registers the matrix as a `describe` block. `subject` is called once per case, after the suite's own `beforeAll` has run, so it may close over variables it sets. */
export function describeToolSourceIntersection(source: string, subject: () => ToolSourceSubject): void {
  describe(`bot capabilities ∩ asker visibility — ${source}`, () => {
    it('granted and visible: listed, and the call goes through', async () => {
      const s = subject();
      await s.arrange({ botGranted: true, askerVisible: true });
      expect(await s.listed()).toContain(s.tool);
      const outcome = await s.call();
      expect(outcome.refused, outcome.text).toBe(false);
    });

    it('not granted, asker can see: not listed, and the call is refused as forbidden', async () => {
      const s = subject();
      await s.arrange({ botGranted: false, askerVisible: true });
      expect(await s.listed()).not.toContain(s.tool);
      const outcome = await s.call();
      expect(outcome.refused, outcome.text).toBe(true);
      expect(outcome.code, outcome.text).toBe('forbidden');
    });

    it('granted, asker cannot see: a read is refused; a write is the bot’s own act and goes through', async () => {
      const s = subject();
      await s.arrange({ botGranted: true, askerVisible: false });
      // the listing is the bot's own view (no asker is involved in it)
      expect(await s.listed()).toContain(s.tool);
      const outcome = await s.call();
      if (s.kind === 'read') {
        expect(outcome.refused, outcome.text).toBe(true);
        expect(outcome.code, outcome.text).toMatch(/^(forbidden|not_found)$/);
      } else {
        expect(outcome.refused, outcome.text).toBe(false);
      }
    });

    it('neither granted nor visible: not listed, refused', async () => {
      const s = subject();
      await s.arrange({ botGranted: false, askerVisible: false });
      expect(await s.listed()).not.toContain(s.tool);
      const outcome = await s.call();
      expect(outcome.refused, outcome.text).toBe(true);
    });
  });
}
