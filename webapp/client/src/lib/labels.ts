import type { Execution } from '../api/types';

export const TERMINAL_STATUSES: Execution['status'][] = ['succeeded', 'failed', 'interrupted'];

export const isTerminal = (status: Execution['status']): boolean => TERMINAL_STATUSES.includes(status);

export const DISPATCH_LABELS: Record<string, string> = {
  admitted: 'Despacho: encargo admitido.',
  'session-confirmed': 'Despacho: sesión raíz confirmada; admisión del encargo sin confirmar.',
  'possibly-sent': 'Despacho: envío posible; admisión sin confirmar. El encargo no se reenviará automáticamente.',
  unconfirmed: 'Despacho: sin confirmar; el encargo no se reenviará automáticamente.',
  'selection-unavailable': 'Despacho: opción elegida no disponible; no se envió el encargo ni se sustituyó por otra.',
};

export const INTERACTION_ERRORS: Record<string, string> = {
  'invalid-json': 'La respuesta enviada no tenía un formato válido.',
  'invalid-request': 'La respuesta no era válida para la solicitud pendiente; no se ha enviado nada.',
  'invalid-answer': 'El tipo de una respuesta no coincide con el campo público admitido.',
  'answer-fields-not-authorized': 'La respuesta incluía campos no autorizados por la solicitud observada.',
  'missing-required-field': 'Falta una respuesta obligatoria de la solicitud.',
  'request-not-observable': 'La captura no permite comprobar los campos admisibles; no se ha respondido nada.',
  'unknown-interaction': 'No existe esa solicitud pendiente para esta ejecución.',
  'interaction-resolved': 'La solicitud ya estaba resuelta o desaparecida; no se ha vuelto a responder.',
  'session-not-in-execution': 'La solicitud pertenece a otra sesión o ejecución; no se ha respondido nada ajeno.',
  'execution-terminal': 'La ejecución ya está cerrada; ya no se admite responder aquí.',
  'evidence-unavailable': 'La evidencia no está consultable; no se ha respondido nada.',
  'engine-unreachable': 'No se pudo consultar la solicitud en el motor; esta petición no llegó a intentar la respuesta.',
  'reply-unconfirmed': 'Respuesta posiblemente enviada: no se pudo confirmar el resultado. El permiso pudo aplicarse; pendiente de reconciliar con la evidencia y el motor. No se repetirá automáticamente.',
};

export const STOP_ERRORS: Record<string, string> = {
  'execution-terminal': 'La ejecución ya está cerrada; la detención ya no aplica.',
  'unknown-execution': 'La ejecución no existe; no se ha interrumpido nada.',
  'session-not-confirmed': 'Todavía no hay sesión confirmada para detener; no se ha interrumpido nada.',
  unknown: 'No se pudo procesar la detención; el desenlace queda sin confirmar y el encargo no se reenvía.',
};

export const STOP_REQUEST_LABELS: Record<string, string> = {
  accepted: 'aceptada',
  'not-running': 'sesión no activa',
  error: 'fallo de la solicitud',
  'already-interrupted': 'interrumpida antes de esta solicitud',
};

export const DECISION_LABELS: Record<string, string> = {
  once: 'Permitir una vez',
  always: 'Permitir siempre',
  reject: 'Rechazar',
};

export const sessionLabel = (execution: Pick<Execution, 'sessionID'>, sessionID: string): string =>
  sessionID === execution.sessionID ? 'Sesión raíz' : `Subejecución ${sessionID}`;

export const readErrorMessage = (error: { sessionID?: string | null }): string =>
  `No se pudieron leer las solicitudes pendientes${error.sessionID ? ` de ${error.sessionID}` : ''}. Las solicitudes capturadas se conservan, pero su vigencia no está comprobada. La consulta no envía respuestas.`;
