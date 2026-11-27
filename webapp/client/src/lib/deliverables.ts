import type { DeliverableEvidenceRef, DeliverableSnapshot, DeliverableValue } from '../api/types';

export const DELIVERABLE_ROLE_LABELS: Record<string, string> = {
  input: 'entrada en la frontera pública',
  intermediate: 'intermedio en la frontera pública',
  output: 'salida en la frontera de la herramienta',
};

export const DELIVERABLE_ROLE_BADGE_LABELS: Record<string, string> = {
  input: 'entrada',
  intermediate: 'intermedio',
  output: 'salida',
};

export const DELIVERABLE_ACQUISITION_LABELS: Record<string, string> = {
  'runtime-content': 'contenido del evento',
  'post-event-file-read': 'lectura posterior',
  'not-acquired': 'no adquirido',
};

export const deliverableEvidenceRef = (evidence: DeliverableEvidenceRef): string =>
  `${evidence.captureID}#${evidence.arrival}`;

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
