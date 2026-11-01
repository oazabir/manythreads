import { addChannelMember, createReminder, leaveChannel, saveChannelLevel, saveChannelTopic } from '../api/endpoints';
import { manualAway, setManualAway } from '../presence/manualAway';
import { presenceStore } from '../presence/store';
import type { SlashDeps } from './slashRun';

/** The routes the slash commands call: the presence store (so the page's own status and Do not disturb change at once), and the channel and reminder routes. */
export const slashDeps: SlashDeps = {
  createReminder,
  saveStatus: (body) => presenceStore.saveProfile(body),
  saveDnd: (body) => presenceStore.saveDnd(body),
  isAway: manualAway,
  setAway: setManualAway,
  beat: (state) => presenceStore.tick(state),
  addMember: addChannelMember,
  leave: leaveChannel,
  saveLevel: saveChannelLevel,
  saveTopic: saveChannelTopic,
};

/** Fired after a command changed a channel (its topic, or the person's place in it), so the screens that show it read it again. */
export const CHANNEL_CHANGED_EVENT = 'mt:channel-changed';
export const announceChannelChanged = (channelId: string): void => {
  window.dispatchEvent(new CustomEvent<string>(CHANNEL_CHANGED_EVENT, { detail: channelId }));
};
