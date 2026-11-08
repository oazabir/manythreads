import type { ConnectorEntry, ConnectorService, ConnectorTool, ConnectorTrigger } from './catalog.ts';

// Builders shared by the catalog files (catalog.ts, catalog-files.ts, catalog-chat.ts): plain functions that return plain data. Types only come from catalog.ts, so
// there is no import cycle at run time.

export const svc = (id: string, label: string, description: string, scopes: string[], available = true): ConnectorService => ({ id, label, description, scopes, available });
export const tool = (name: string, label: string, access: 'read' | 'write', service: string | null, available = true): ConnectorTool => ({
  name,
  label,
  access,
  destructive: false,
  service,
  available,
});
export const trig = (id: string, label: string, available = false): ConnectorTrigger => ({ id, label, available });
export const soon = (phase: string, reason: string): Pick<ConnectorEntry, 'status' | 'reason' | 'phase'> => ({ status: 'planned', reason, phase });

export const planned = (e: Omit<ConnectorEntry, 'kind' | 'syncTargets' | 'triggers' | 'services'> & Partial<Pick<ConnectorEntry, 'syncTargets' | 'triggers' | 'services'>>): ConnectorEntry => ({
  kind: null,
  syncTargets: [],
  triggers: [],
  services: [],
  ...e,
});
