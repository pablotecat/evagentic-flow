import { useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

const safeUrl = (url: string): string => {
  const trimmed = url.replace(/[\u0000-\u0020]/g, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed, 'https://flujo-en-proyecto.local');
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? trimmed : '';
  } catch {
    return '';
  }
};

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="relative my-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900">
      <div className="absolute right-1.5 top-1.5 z-10">
        <CopyButton label="Copiar código" value={() => ref.current?.innerText ?? ''} />
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 pr-24 font-mono text-xs leading-relaxed">{children}</pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-600 underline underline-offset-2 dark:text-sky-300">
      {children}
    </a>
  ) : <span>{children}</span>),
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-semibold text-slate-900 first:mt-0 dark:text-slate-50">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold text-slate-900 first:mt-0 dark:text-slate-50">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-2 text-sm font-semibold text-slate-900 first:mt-0 dark:text-slate-50">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-slate-800 first:mt-0 dark:text-slate-100">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-300">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-slate-300 px-2 py-1 font-semibold dark:border-slate-600">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-slate-300 px-2 py-1 dark:border-slate-600">{children}</td>
  ),
  code: ({ className, children }) => (
    <code className={`font-mono text-[13px] ${className ?? ''}`}>{children}</code>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-sm leading-relaxed break-words" data-markdown="true">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
