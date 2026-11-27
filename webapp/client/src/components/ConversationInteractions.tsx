import type { Execution, ExecutionDetail, FormField, FormFieldOption, PendingInteraction, ResolvedInteraction } from '../api/types';
import { alertClass, noticeClass } from '../lib/ui';
import { DECISION_LABELS, sessionLabel } from '../lib/labels';
import { fieldVisible, interactionKey, useInteractionState } from '../hooks/useInteractionState';

const interactionShell = 'rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900';
const interactionHeading = 'mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100';
const fieldInputClass = 'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100';
const fieldLabelClass = 'block space-y-1';
const fieldLegendClass = 'text-xs font-medium text-slate-700 dark:text-slate-300';

const optionValue = (option: FormFieldOption): string =>
  typeof option?.value === 'string' ? option.value : typeof option?.label === 'string' ? option.label : '';

const formatResolvedValue = (kind: ResolvedInteraction['kind'], key: string, value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (Array.isArray(value)) return value.map(item => String(item)).join(' · ');
  if (kind === 'permission' && key === 'decision' && typeof value === 'string' && value in DECISION_LABELS) {
    return DECISION_LABELS[value];
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
};

function FieldInput({ field, itemKey }: { field: FormField; itemKey: string }) {
  const state = useInteractionState();
  const stored = state.drafts[itemKey]?.[field.key];
  const label = `${field.title ?? field.key}${field.required ? ' *' : ''}`;
  const options = Array.isArray(field.options) ? field.options : [];
  const update = (value: string | boolean) => state.setField(itemKey, field.key, value);
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
        <input
          type="checkbox"
          data-field={field.key}
          checked={stored === true}
          onChange={event => update(event.target.checked)}
          className="size-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:bg-slate-800"
        />
        <span>{label}</span>
      </label>
    );
  }
  if (field.type === 'multiselect') {
    return (
      <fieldset className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
        <legend className={fieldLegendClass}>{label}</legend>
        <div className="space-y-1">
          {options.map(option => {
            const value = optionValue(option);
            if (!value) return null;
            return (
              <label key={value} className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
                <input
                  type="checkbox"
                  data-field={field.key}
                  data-group="multiselect"
                  value={value}
                  checked={Array.isArray(stored) && stored.includes(value)}
                  onChange={event => state.toggleMultiselect(itemKey, field.key, value, event.target.checked)}
                  className="size-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:bg-slate-800"
                />
                <span>{option.label ?? value}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
  if (options.length > 0) {
    return (
      <div className="space-y-2">
        <label className={fieldLabelClass}>
          <span className={fieldLegendClass}>{label}</span>
          <select
            data-field={field.key}
            value={typeof stored === 'string' && options.some(option => optionValue(option) === stored) ? stored : ''}
            onChange={event => update(event.target.value)}
            className={fieldInputClass}
          >
            <option value="">— elegir respuesta —</option>
            {options.map(option => {
              const value = optionValue(option);
              return <option key={value} value={value}>{option.label ?? value}</option>;
            })}
          </select>
        </label>
        {field.custom ? (
          <label className={fieldLabelClass}>
            <span className={fieldLegendClass}>Respuesta propia para {field.title ?? field.key}</span>
            <input
              type="text"
              data-field={field.key}
              data-custom="true"
              placeholder="Respuesta propia"
              value={typeof stored === 'string' ? stored : ''}
              onChange={event => update(event.target.value)}
              className={fieldInputClass}
            />
          </label>
        ) : null}
      </div>
    );
  }
  return (
    <label className={fieldLabelClass}>
      <span className={fieldLegendClass}>{label}</span>
      <input
        type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
        step={field.type === 'number' || field.type === 'integer' ? 'any' : undefined}
        data-field={field.key}
        value={typeof stored === 'string' ? stored : ''}
        onChange={event => update(event.target.value)}
        className={fieldInputClass}
      />
    </label>
  );
}

function QuestionForm({ item, execution }: { item: PendingInteraction; execution: Execution }) {
  const state = useInteractionState();
  const key = interactionKey(item);
  const draft = state.drafts[key];
  const fields = Array.isArray(item.request?.fields) ? item.request.fields : [];
  if (!fields.length) {
    return (
      <section tabIndex={-1} data-kind="form" data-session={item.sessionID} data-request={item.requestID} className={interactionShell}>
        <h4 className={interactionHeading}>Pregunta nativa · {sessionLabel(execution, item.sessionID)}</h4>
        <p className="text-sm">{item.request?.title ?? 'Sin título observable'}</p>
        <p className={`${noticeClass} mt-2`}>La captura no expone los campos admitidos de esta pregunta; no se puede responder desde la app.</p>
      </section>
    );
  }
  return (
    <form
      tabIndex={-1}
      data-kind="form"
      data-session={item.sessionID}
      data-request={item.requestID}
      onSubmit={event => {
        event.preventDefault();
        state.submitForm(item);
      }}
      className={`${interactionShell} space-y-3`}
    >
      <h4 className={interactionHeading}>Pregunta nativa · {sessionLabel(execution, item.sessionID)}</h4>
      <p className="text-sm">{item.request?.title ?? 'Sin título observable'}</p>
      {fields.filter(field => fieldVisible(field, draft, fields)).map(field => (
        <FieldInput key={field.key} field={field} itemKey={key} />
      ))}
      <button
        type="submit"
        disabled={state.replying}
        className="rounded-xl bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400"
      >
        Responder pregunta
      </button>
    </form>
  );
}

function PermissionCard({ item, execution }: { item: PendingInteraction; execution: Execution }) {
  const state = useInteractionState();
  const request = item.request ?? {};
  return (
    <section tabIndex={-1} data-kind="permission" data-session={item.sessionID} data-request={item.requestID} className={`${interactionShell} space-y-2`}>
      <h4 className={interactionHeading}>Permiso nativo · {sessionLabel(execution, item.sessionID)}</h4>
      <p className="text-sm">Acción: {typeof request.action === 'string' ? request.action : 'desconocida'}</p>
      <p className="text-sm">Alcance: {Array.isArray(request.resources) && request.resources.length
        ? request.resources.join(' · ') : 'desconocido'}</p>
      {typeof request.message === 'string' ? <p className="text-sm">Mensaje: {request.message}</p> : null}
      <p className={noticeClass}>
        La decisión se envía como decisión nativa de OpenCode; «Permitir siempre» sólo persiste el permiso si el runtime lo admite para esa acción.
      </p>
      <div className="flex flex-wrap gap-2">
        {(['once', 'always', 'reject'] as const).map(decision => (
          <button
            key={decision}
            type="button"
            data-decision={decision}
            disabled={state.replying}
            onClick={() => state.submitDecision(item, decision)}
            className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${decision === 'reject'
              ? 'border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
              : 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-sky-500 dark:hover:bg-sky-400'}`}
          >
            {DECISION_LABELS[decision]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ConversationInteractions({ detail }: { detail: ExecutionDetail }) {
  const state = useInteractionState();
  const execution = detail.execution;
  const interactions = detail.interactions ?? { pending: [], resolved: [], readErrors: [] };
  return (
    <>
      {interactions.pending.length ? (
        <section aria-label="Intervención" className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Esperando intervención</h3>
          <p className={noticeClass}>
            La ejecución espera intervención: conserva su identidad, no se cierra ni falla por esperar, y responder no lanza otro encargo.
          </p>
          {interactions.pending.map(item => item.kind === 'form'
            ? <QuestionForm key={`form:${item.sessionID}:${item.requestID}`} item={item} execution={execution} />
            : <PermissionCard key={`permission:${item.sessionID}:${item.requestID}`} item={item} execution={execution} />)}
          {state.error ? <p role="alert" className={alertClass}>{state.error}</p> : null}
        </section>
      ) : state.error ? <p role="alert" className={alertClass}>{state.error}</p> : null}
      {interactions.resolved.length ? (
        <details aria-label="Respuestas registradas" className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <summary className="cursor-pointer select-none text-sm font-medium text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
            Respuestas registradas en la captura
          </summary>
          <ul className="mt-3 space-y-2">
            {interactions.resolved.map(item => (
              <li
                key={`${item.sessionID}:${item.kind}:${item.requestID}`}
                data-resolved={`${item.sessionID}:${item.kind}:${item.requestID}`}
                className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"
              >
                <p className="text-sm">
                  {item.kind === 'permission' ? 'Permiso' : 'Pregunta'} · {sessionLabel(execution, item.sessionID)} ·{' '}
                  {item.phase === 'cancelled' ? 'cancelada' : 'respondida'}
                </p>
                {item.response && Object.keys(item.response).length ? (
                  <dl className="mt-1 space-y-0.5">
                    {Object.entries(item.response).map(([key, value]) => (
                      <div key={key} className="flex flex-wrap gap-x-2">
                        <dt className="font-mono text-xs text-slate-500 dark:text-slate-400">{key}</dt>
                        <dd className="text-xs text-slate-800 dark:text-slate-200">{formatResolvedValue(item.kind, key, value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
          <p className={`${noticeClass} mt-2`}>
            La captura no atribuye las respuestas a una persona autenticada: su procedencia es cliente externo no identificado.
          </p>
        </details>
      ) : null}
    </>
  );
}
