export const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const messageWire = {
  id: uuid(1),
  workspaceId: uuid(2),
  channelId: uuid(3),
  authorId: uuid(4),
  body: 'hello **world**',
  bodyPlain: 'hello world',
  threadRootId: null,
  editedAt: null,
  deletedAt: null,
  meta: { answerRef: 'a1' },
  createdAt: '2026-10-01T12:00:00.000Z',
};
