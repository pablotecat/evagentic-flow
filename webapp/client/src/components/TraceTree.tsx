import type { TraceNode, TraceTree as TraceTreeData } from '../api/types';
import { evidenceText } from '../lib/trace';
import { chipClass, noticeClass } from '../lib/ui';

type Props = {
  tree: TraceTreeData;
  rootSessionID: string | null;
  selectedSession: string | null;
  onSelectSession: (session: string) => void;
};

const RELATION_LABELS: Record<string, string> = {
  'delegation-call-observed': 'delegación observada',
  'parent-observed-call-unknown': 'padre observado, llamada desconocida',
  unknown: 'relación desconocida',
};

const relationLines = (node: TraceNode): string[] => {
  if (node.relation === 'delegation-call-observed') {
    return node.delegations.map(delegation => `Padre ${delegation.parentSessionID} · llamada ${delegation.callID ?? 'sin id de llamada'} · evidencia: ${evidenceText([delegation.evidence])}`);
  }
  if (node.relation === 'parent-observed-call-unknown') {
    return [`Padre observado ${node.observedParents.join(', ')}; llamada creadora no observada.`];
  }
  if (node.relation === 'unknown') {
    return ['Relación no observada o excluida; no se deduce ninguna asociación.'];
  }
  return [];
};

export function TraceTree({ tree, rootSessionID, selectedSession, onSelectSession }: Props) {
  const nodes = tree.nodes;
  const byID = new Map(nodes.map(node => [node.sessionID, node]));
  const childrenOf = new Map<string, TraceNode[]>();
  const roots: TraceNode[] = [];
  for (const node of nodes) {
    const parentID = node.delegations[0]?.parentSessionID
      ?? node.observedParents.find(candidate => candidate !== node.sessionID)
      ?? null;
    if (parentID && parentID !== node.sessionID && byID.has(parentID)) {
      const siblings = childrenOf.get(parentID) ?? [];
      siblings.push(node);
      childrenOf.set(parentID, siblings);
    } else roots.push(node);
  }
  const renderNode = (node: TraceNode) => {
    const isRoot = rootSessionID !== null && node.sessionID === rootSessionID;
    const selected = selectedSession !== null && selectedSession === node.sessionID;
    const lines = relationLines(node);
    return (
      <li
        key={node.sessionID}
        role="treeitem"
        data-tree-node={node.sessionID}
        aria-selected={selected}
        className="space-y-1"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-select-session={node.sessionID}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelectSession(node.sessionID)}
            className={`rounded-lg px-2 py-1 text-xs font-medium transition-colors ${selected
              ? 'bg-sky-100 text-sky-800 ring-1 ring-sky-500 dark:bg-sky-950/60 dark:text-sky-200 dark:ring-sky-400'
              : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'}`}
          >
            {isRoot ? 'Sesión raíz' : 'Subejecución'} <span className="font-mono break-all">{node.sessionID}</span>
          </button>
          {isRoot && <span className={chipClass} data-relation="view-root">sesión raíz</span>}
          {node.relation !== 'view-root' && (
            <span className={chipClass} data-relation={node.relation}>
              {RELATION_LABELS[node.relation] ?? node.relation}
            </span>
          )}
          <span className={noticeClass}>
            {node.agentIDs.length ? `agente: ${node.agentIDs.join(', ')}` : 'agente no observado'}
          </span>
        </div>
        {lines.length > 0 && (
          <details className="ml-1">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
              Relación y evidencia
            </summary>
            <ul className="space-y-1 py-1">
              {lines.map((line, index) => (
                <li key={index} className="font-mono text-[11px] leading-relaxed break-words text-slate-600 dark:text-slate-300">
                  {line}
                </li>
              ))}
            </ul>
          </details>
        )}
        {childrenOf.has(node.sessionID) && (
          <ul role="group" className="ml-4 space-y-2 border-l border-slate-200 pl-3 dark:border-slate-700">
            {(childrenOf.get(node.sessionID) ?? []).map(renderNode)}
          </ul>
        )}
      </li>
    );
  };
  return (
    <section aria-label="Árbol de subejecuciones" className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Árbol de subejecuciones</h4>
      <p className={noticeClass}>
        Sólo aparecen sesiones relacionadas por evidencia acreditada: una llamada de delegación observada o un
        padre observado. «Relación desconocida» significa relación no observada o excluida, no una asociación
        deducida.
      </p>
      <ul role="tree" aria-label="Árbol de subejecuciones de la ejecución" className="space-y-2">
        {roots.map(renderNode)}
      </ul>
    </section>
  );
}
