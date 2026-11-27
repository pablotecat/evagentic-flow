import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemePreference, useThemePreference } from '../state/theme';
import type { ThemePreference } from '../state/theme';

const CHOICES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'claro', label: 'Claro', Icon: Sun },
  { value: 'oscuro', label: 'Oscuro', Icon: Moon },
  { value: 'sistema', label: 'Sistema', Icon: Monitor },
];

export function ThemeSwitcher() {
  const preference = useThemePreference();
  return (
    <div role="radiogroup" aria-label="Tema" className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      {CHOICES.map(({ value, label, Icon }) => {
        const checked = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            title={label}
            onClick={() => setThemePreference(value)}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${checked
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-slate-50'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
