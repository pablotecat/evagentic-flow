import { noticeClass } from '../lib/ui';

export function RubricsView() {
  return (
    <section aria-label="Rúbricas" className="pt-10 lg:pt-20">
      <h2 className="text-2xl font-semibold tracking-tight">Rúbricas</h2>
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          Vista de sólo lectura de las rúbricas versionadas del piloto. El detalle por rúbrica y versión se mostrará aquí.
        </p>
        <p className={`${noticeClass} mt-3`}>
          En este corte no hay ninguna rúbrica versionada que presentar: la ausencia de rúbricas no evalúa ninguna ejecución y el desenlace técnico no equivale a una aceptación.
        </p>
      </div>
    </section>
  );
}
