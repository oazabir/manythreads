/*
 * What a message row draws over its top right corner (P34-05, correction 4 of docs/plans/everyday-screens.md). With a mouse: the hover bar (quick reactions,
 * Reply, React, More) while the row is under the pointer, has the focus or was tapped, and the menu it opened. With a finger (`pointer: coarse`) there is no
 * hover bar at all: a tap left it standing over the row's time. A held finger opens the reactions (with Reply and More actions under them) or, for a reader who
 * cannot react, the actions; only that menu is drawn.
 */
export type RowBar = 'none' | 'bar' | 'menu';

export function rowBar(s: { coarse: boolean; hot: boolean; tapped: boolean; menuOpen: boolean; deleted: boolean }): RowBar {
  if (s.deleted) return 'none';
  if (s.coarse) return s.menuOpen ? 'menu' : 'none';
  return s.hot || s.tapped || s.menuOpen ? 'bar' : 'none';
}
