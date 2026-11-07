import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskState } from '@manythreads/shared';
import { BoardTemplates } from '../src/screens/boards/BoardTemplates';
import { JobTiles } from '../src/screens/boards/JobTiles';
import { JOB_TILES, scheduledJobRequest, tileDraft } from '../src/screens/boards/scheduled-job';
import { BOARD_TEMPLATES, coversEveryState, templateRequest } from '../src/screens/boards/templates';

/*
 * The empty Boards page and the empty Jobs page (PLAN P21-15): the three templates are real create-board requests that leave no task state
 * without a column, the three job tiles open a form that already passes the same check Save does, and a person who may not create either
 * sees the pictures and the words but no button.
 */

describe('board templates', () => {
  it('offers three boards with distinct names', () => {
    expect(BOARD_TEMPLATES.map((t) => t.name)).toEqual(['Delivery', 'Support queue', 'Content calendar']);
    expect(new Set(BOARD_TEMPLATES.map((t) => t.id)).size).toBe(3);
  });

  it('gives every task state a column, so a card is never hidden by its template', () => {
    for (const t of BOARD_TEMPLATES) {
      expect(coversEveryState(t.columns), t.name).toBe(true);
      for (const state of TaskState.options) expect(t.columns.some((c) => c.state === state), `${t.name} has a ${state} column`).toBe(true);
    }
  });

  it('turns into the request the create-board route takes: the name and its columns in order', () => {
    for (const t of BOARD_TEMPLATES) {
      const body = templateRequest(t);
      expect(body.name).toBe(t.name);
      expect(body.columns?.map((c) => c.name)).toEqual(t.columns.map((c) => c.name));
    }
    expect(coversEveryState([{ name: 'Only one', state: 'open' }])).toBe(false);
  });

  it('draws three cards with a start button for a lead, and none for someone who cannot create a board', () => {
    const lead = renderToStaticMarkup(createElement(BoardTemplates, { canManage: true, busy: null, onStart: () => undefined }));
    expect(lead.match(/data-testid="board-template"/g)).toHaveLength(3);
    expect(lead.match(/data-testid="board-template-start"/g)).toHaveLength(3);
    expect(lead).toContain('Start from this template');
    const member = renderToStaticMarkup(createElement(BoardTemplates, { canManage: false, busy: null, onStart: () => undefined }));
    expect(member).not.toContain('board-template-start');
    expect(member).toContain('A team lead or a workspace admin creates the first one');
  });

  it('shows which template is being created and holds the others', () => {
    const html = renderToStaticMarkup(createElement(BoardTemplates, { canManage: true, busy: 'support', onStart: () => undefined }));
    expect(html).toContain('Creating…');
    expect(html.match(/ disabled=""/g)).toHaveLength(3);
  });
});

describe('job tiles', () => {
  it('has one tile for each kind of job, each with an example sentence', () => {
    expect(JOB_TILES.map((t) => t.kind)).toEqual(['heartbeat', 'routine', 'task']);
    for (const t of JOB_TILES) expect(t.example.length).toBeGreaterThan(20);
  });

  it('opens a form that already saves: the preset passes the same request check as the Save button', () => {
    for (const tile of JOB_TILES) {
      const draft = tileDraft(tile, 'brain');
      expect(draft.kind).toBe(tile.kind);
      expect(draft.botSlug).toBe('brain');
      const built = scheduledJobRequest(draft);
      expect(built.ok, `${tile.kind}: ${built.ok ? '' : built.message}`).toBe(true);
    }
    expect(tileDraft(JOB_TILES[1]!, 'brain')).toMatchObject({ contractPath: 'routines/weekly.yaml', outputPath: 'pages/reports/weekly.md' });
  });

  it('keeps file names out of the words on the page', () => {
    const html = renderToStaticMarkup(createElement(JobTiles, { canManage: true, onCreate: () => undefined }));
    expect(html.match(/data-testid="job-tile"/g)).toHaveLength(3);
    expect(html.match(/data-testid="job-tile-create"/g)).toHaveLength(3);
    expect(html).not.toContain('routines/');
    expect(html).not.toContain('.yaml');
  });

  it('draws the tiles without a Create button for someone who may only propose a job', () => {
    const html = renderToStaticMarkup(createElement(JobTiles, { canManage: false, onCreate: () => undefined }));
    expect(html.match(/data-testid="job-tile"/g)).toHaveLength(3);
    expect(html).not.toContain('job-tile-create');
  });
});
