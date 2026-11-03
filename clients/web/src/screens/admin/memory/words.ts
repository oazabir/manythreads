/** The words of the Workspace → Memory sharing switch, apart from the component so a test can read them. */
export function switchWords(enabled: boolean): { state: string; help: string; done: string } {
  return enabled
    ? {
        state: 'on',
        help: 'Teams can offer part of their memory to other teams. A digest is only sent to a team that accepted it, and only after a lead approves it.',
        done: 'Memory sharing is on. Teams can send and receive digests again.',
      }
    : {
        state: 'off',
        help: 'No team builds, sends or receives a digest. A digest that is already approved waits, and what was received before stays in each team’s memory.',
        done: 'Memory sharing is off. Nothing will be sent or received until it is switched on.',
      };
}
