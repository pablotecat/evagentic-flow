import { useEffect, useState } from 'react';
import type { ExecutionDetail } from '../api/types';
import { noticeClass } from '../lib/ui';
import { DISPATCH_LABELS } from '../lib/labels';
import { Markdown } from './Markdown';
import { ConversationInteractions } from './ConversationInteractions';

type Props = {
  detail: ExecutionDetail;
  focusRequest: string | null;
};

function Message({ heading, text, shellClass }: { heading: string; text: string; shellClass: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <article className={shellClass}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">{heading}</h3>
        <button
          type="button"
          aria-pressed={raw}
          onClick={() => setRaw(current => !current)}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          {raw ? 'Markdown' : 'Texto sin formato'}
        </button>
      </div>
      {raw
        ? <p className="whitespace-pre-wrap text-sm leading-relaxed break-words">{text}</p>
        : <Markdown text={text} />}
    </article>
  );
}

export function ConversationTab({ detail, focusRequest }: Props) {
  const execution = detail.execution;
  const conversation = detail.conversation ?? { entries: [], responses: [] };
  useEffect(() => {
    if (!focusRequest) return;
    const [kind, sessionID, requestID] = focusRequest.split(':');
    const selector = `[data-kind="${CSS.escape(kind)}"][data-session="${CSS.escape(sessionID)}"][data-request="${CSS.escape(requestID)}"]`;
    document.querySelector(selector)?.scrollIntoView({ block: 'center' });
  }, [focusRequest]);
  return (
    <div className="space-y-4">
      <p className={noticeClass} data-dispatch={execution.dispatch}>
        {DISPATCH_LABELS[execution.dispatch] ?? DISPATCH_LABELS.unconfirmed}
      </p>
      {conversation.entries.map((entry, index) => (
        <Message
          key={`entry-${index}`}
          heading="Encargo"
          text={entry.text}
          shellClass="rounded-xl bg-slate-100 p-4 dark:bg-slate-800/60"
        />
      ))}
      {conversation.responses.map((response, index) => (
        <Message
          key={`response-${index}`}
          heading="Respuesta"
          text={response.text}
          shellClass="rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
        />
      ))}
      {!conversation.responses.length ? (
        <p className={noticeClass}>
          {execution.status === 'running'
            ? 'Sin respuesta observada todavía; la captura puede ir por detrás del trabajo.'
            : 'Sin respuesta observada en la captura; no se reconstruye texto no capturado.'}
        </p>
      ) : null}
      <ConversationInteractions detail={detail} />
    </div>
  );
}
