export const linkClass = (active: boolean) => `flex-1 rounded-lg px-3 py-1.5 text-center text-xs font-medium transition-colors ${active
  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'}`;

export const chipClass = 'inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300';

export const noticeClass = 'text-xs leading-relaxed text-slate-500 dark:text-slate-400';

export const alertClass = 'rounded-xl border border-red-300 bg-red-50 p-3 text-sm leading-relaxed text-red-800 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200';
