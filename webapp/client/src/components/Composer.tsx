import { useState, type KeyboardEvent } from 'react';
import { RotateCw, Send } from 'lucide-react';
import { api, isApiFailure } from '../api/client';
import type { Execution } from '../api/types';
import { navigate } from '../router/hash';
import { useOptions } from '../hooks/useOptions';
import { alertClass, noticeClass } from '../lib/ui';

type ComposerAlert =
  | { kind: 'engine-unreachable' }
  | { kind: 'selection-unavailable'; optionKind: string; option: string }
  | { kind: 'index-review-required' }
  | { kind: 'project-busy'; activeId: string | null }
  | { kind: 'transient' };

type ComposerProps = {
  indexStatus?: 'available' | 'review-required' | null;
};

type SubmitPayload = {
  requestKey: string;
  text?: string;
  command?: { name: string; arguments: string };
  agent?: string;
  model?: string;
};

export function Composer({ indexStatus = null }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [command, setCommand] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [alert, setAlert] = useState<ComposerAlert | null>(null);
  const { options, reload } = useOptions();

  const submit = async () => {
    if (sending || !draft.trim()) return;
    setSending(true);
    setAlert(null);
    const payload: SubmitPayload = { requestKey };
    if (command) payload.command = { name: command, arguments: draft.trim() };
    else payload.text = draft.trim();
    if (agent) payload.agent = agent;
    if (model) payload.model = model;
    try {
      const result = await api<{ execution: Execution }>('/api/executions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setRequestKey(crypto.randomUUID());
      setDraft('');
      setAgent('');
      setModel('');
      setCommand('');
      navigate({ view: 'execution', id: result.execution.id, tab: 'conversation', session: null });
    } catch (error) {
      if (isApiFailure(error)) {
        if (error.status === 422 && error.body?.error === 'selection-unavailable') {
          setAlert({
            kind: 'selection-unavailable',
            optionKind: typeof error.body.kind === 'string' ? error.body.kind : '',
            option: typeof error.body.option === 'string' ? error.body.option : '',
          });
          reload();
          return;
        }
        if (error.status === 503 && error.body?.error === 'index-review-required') {
          setAlert({ kind: 'index-review-required' });
          return;
        }
        if (error.status === 409 && error.body?.error === 'project-busy') {
          const busy = error.body.execution as Execution | null | undefined;
          setAlert({ kind: 'project-busy', activeId: busy && typeof busy.id === 'string' ? busy.id : null });
          return;
        }
      }
      setAlert({ kind: 'transient' });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  const loaded = options.kind === 'loaded' ? options.data : null;
  const engineAlert = loaded?.state === 'engine-unreachable';
  const indexReviewRequired = indexStatus === 'review-required' || alert?.kind === 'index-review-required';

  return (
    <section aria-label="Nuevo encargo" className="mx-auto max-w-2xl pt-10 lg:pt-20">
      <h2 className="mb-6 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
        Nuevo encargo
      </h2>
      <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Selector
            label="Agente"
            state={options.kind}
            entries={loaded?.agents?.map(entry => ({ value: entry.id, label: entry.name ?? entry.id })) ?? null}
            value={agent}
            onChange={setAgent}
            placeholder="Sin selección: agente por defecto"
            empty="Sin agentes expuestos"
          />
          <Selector
            label="Modelo"
            state={options.kind}
            entries={loaded?.models?.map(entry => ({ value: entry.value, label: entry.name })) ?? null}
            value={model}
            onChange={setModel}
            placeholder="Sin selección: modelo por defecto"
            empty="Sin modelos expuestos"
          />
          <Selector
            label="Comando"
            state={options.kind}
            entries={loaded?.commands?.map(entry => ({
              value: entry.name,
              label: entry.description ? `${entry.name} — ${entry.description}` : entry.name,
            })) ?? null}
            value={command}
            onChange={setCommand}
            placeholder="Sin comando: enviar encargo"
            empty="La instancia no expone comandos"
          />
          <button
            type="button"
            aria-label="Recargar opciones"
            title="Recargar opciones"
            onClick={() => void reload()}
            className="rounded-lg border border-slate-300 p-2 text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <RotateCw className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div>
          <label htmlFor="encargo" className="mb-1.5 block text-sm font-medium text-slate-800 dark:text-slate-200">
            Encargo
          </label>
          <textarea
            id="encargo"
            aria-label="Encargo"
            rows={6}
            maxLength={20000}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe el encargo para el proyecto de ejecución…"
            className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        {command && (
          <p className={noticeClass} data-command-notice={command}>
            El comando «{command}» se ejecuta por la interfaz pública de OpenCode; el texto del encargo son sus argumentos.
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className={noticeClass}>Ctrl+Enter o ⌘+Enter para enviar.</p>
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400"
          >
            <Send className="size-4" aria-hidden="true" />
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
        {engineAlert && (
          <p role="alert" className={alertClass}>
            Motor no disponible: no se pudieron consultar las opciones del proyecto. El envío quedará sin confirmar; el mismo encargo reutiliza la clave de solicitud y no duplica el trabajo al reintentar.
          </p>
        )}
        {alert?.kind === 'selection-unavailable' && (
          <p role="alert" className={alertClass}>
            La opción elegida ({alert.optionKind}: {alert.option}) ya no está disponible para este proyecto. No se ha lanzado nada; las opciones se han vuelto a consultar.
          </p>
        )}
        {indexReviewRequired && (
          <p role="alert" className={alertClass}>
            El índice persistente requiere revisión: no se aceptan nuevos lanzamientos hasta revisar índice y marcador con la app detenida. La ejecución no se ha creado.
          </p>
        )}
        {alert?.kind === 'project-busy' && (
          <div role="alert" className={alertClass}>
            <p>El proyecto de ejecución está ocupado por otra ejecución en marcha; no se ha creado ninguna ejecución nueva.</p>
            {alert.activeId && (
              <a
                href={`#/executions/${encodeURIComponent(alert.activeId)}/conversation`}
                className="mt-1 inline-block font-medium underline underline-offset-2"
              >
                Ver la ejecución activa
              </a>
            )}
          </div>
        )}
        {alert?.kind === 'transient' && (
          <p role="alert" className={alertClass}>
            No se pudo lanzar la ejecución. Reintenta el mismo encargo: la clave de solicitud se conserva y un envío repetido no duplica el trabajo.
          </p>
        )}
        <p className={noticeClass}>
          La conversación admite un único envío inicial en este incremento; el candado por proyecto decide si puede lanzarse.
        </p>
      </form>
    </section>
  );
}

type SelectorProps = {
  label: string;
  state: 'loading' | 'error' | 'loaded';
  entries: { value: string; label: string }[] | null;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  empty: string;
};

function Selector({ label, state, entries, value, onChange, placeholder, empty }: SelectorProps) {
  const disabled = state !== 'loaded' || entries === null || entries.length === 0;
  let firstOption: string;
  if (state === 'loading') firstOption = 'Cargando opciones…';
  else if (state === 'error') firstOption = 'Error al consultar opciones';
  else if (entries === null) firstOption = 'Opciones no consultables';
  else if (!entries.length) firstOption = empty;
  else firstOption = placeholder;
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        className="min-w-40 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-normal text-slate-900 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:disabled:text-slate-500"
      >
        <option value="">{firstOption}</option>
        {(entries ?? []).map(entry => (
          <option key={entry.value} value={entry.value}>{entry.label}</option>
        ))}
      </select>
    </label>
  );
}
