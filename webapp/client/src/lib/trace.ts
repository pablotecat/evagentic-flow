import type { EvidenceRef } from '../api/types';

export const INTERVAL_STATE_LABELS: Record<string, string> = {
  concluded: 'concluida',
  failed: 'fallida',
  interrupted: 'interrumpida',
  unknown: 'desconocida',
};

export const WAIT_STATE_LABELS: Record<string, string> = {
  'waiting-external-decision': 'esperando decisión externa',
  'not-waiting-or-unknown': 'no esperando o desconocido',
};

export const WAIT_KIND_LABELS: Record<string, string> = {
  permission: 'permiso',
  form: 'pregunta',
};

export const waitKindOrUnknown = (kind: string): string => WAIT_KIND_LABELS[kind] ?? kind;

export const intervalStateLabel = (state: string | null): string =>
  INTERVAL_STATE_LABELS[state ?? ''] ?? state ?? 'desconocida';

export const waitStateLabel = (state: string | null): string =>
  WAIT_STATE_LABELS[state ?? ''] ?? state ?? 'desconocido';

export const isoOrUnobserved = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'no observado' : new Date(value).toISOString();

export const evidenceText = (refs: EvidenceRef[]): string =>
  refs.map(ref => `${ref.captureID} · fila ${ref.arrival}${ref.eventID ? ` · evento ${ref.eventID}` : ''}${ref.type ? ` (${ref.type})` : ''}`).join(' | ');

export const durationOrOpen = (elapsedMs: number | null | undefined, open: boolean): string => {
  if (open) return 'abierto / sin cierre observado';
  return elapsedMs === null || elapsedMs === undefined ? 'desconocido' : `${elapsedMs} ms`;
};

export const uniqueKeys = <T,>(items: T[], baseKey: (item: T) => string): string[] => {
  const counts = new Map<string, number>();
  return items.map(item => {
    const base = baseKey(item);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  });
};
