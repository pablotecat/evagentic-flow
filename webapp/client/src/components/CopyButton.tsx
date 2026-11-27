import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

type Props = {
  value: string | (() => string);
  label: string;
  className?: string;
};

export function CopyButton({ value, label, className }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        const text = typeof value === 'function' ? value() : value;
        void copyToClipboard(text).then(ok => {
          if (ok) setCopied(true);
        });
      }}
      aria-label={copied ? `${label}: copiado` : label}
      data-copied={copied ? 'true' : 'false'}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 ${className ?? ''}`}
    >
      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      <span aria-hidden="true">{copied ? 'Copiado' : 'Copiar'}</span>
    </button>
  );
}
