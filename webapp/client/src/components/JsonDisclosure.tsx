import { CopyButton } from './CopyButton';

type Props = {
  summary: string;
  text: string;
  marker: string;
};

export const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

export function JsonDisclosure({ summary, text, marker }: Props) {
  return (
    <details data-disclosure={marker} className="rounded-lg border border-slate-200 dark:border-slate-800">
      <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">
        {summary}
      </summary>
      <div className="relative m-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900">
        <div className="absolute right-1.5 top-1.5 z-10">
          <CopyButton label="Copiar JSON" value={text} />
        </div>
        <pre className="overflow-x-auto p-3 pr-24 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{text}</pre>
      </div>
    </details>
  );
}
