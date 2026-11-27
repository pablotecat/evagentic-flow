import type { DeliverableSnapshot, DeliverableValue } from '../api/types';

export const DELIVERABLE_ROLE_LABELS: Record<string, string> = {
  input: 'entrada en la frontera pública',
  intermediate: 'intermedio en la frontera pública',
  output: 'salida en la frontera de la herramienta',
};

export const DELIVERABLE_ROLE_BADGES: Record<string, { label: string; className: string }> = {
  input: {
    label: 'entrada',
    className: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  },
  intermediate: {
    label: 'intermedio',
    className: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  },
  output: {
    label: 'salida',
    className: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  },
};

export const DELIVERABLE_ACQUISITION_LABELS: Record<string, string> = {
  'runtime-content': 'contenido del evento',
  'post-event-file-read': 'lectura posterior',
  'not-acquired': 'no adquirido',
};

export const finalityText = (value: DeliverableValue | null): string =>
  value?.finality != null
    ? `Finalidad declarada: ${value.finality}`
    : 'Finalidad desconocida (sin acreditar finalidad global)';

export const snapshotKeyParts = (snapshot: DeliverableSnapshot): string => [
  snapshot.sessionID,
  snapshot.evidence?.captureID ?? 'sin-captura',
  snapshot.evidence?.arrival ?? 'sin-fila',
  snapshot.sha256 ?? 'sin-hash',
  snapshot.messageID ?? 'sin-mensaje',
  snapshot.value?.callID ?? 'sin-llamada',
  snapshot.source ?? 'sin-fuente',
  snapshot.observationTime,
].join('|');
