import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isApiFailure } from '../api/client';
import type { FormField, PendingInteraction } from '../api/types';
import { INTERACTION_ERRORS } from '../lib/labels';

export type DraftValue = string | boolean | string[];
export type DraftValues = Record<string, DraftValue>;
export type Drafts = Record<string, DraftValues>;

type InteractionStateValue = {
  drafts: Drafts;
  replying: boolean;
  error: string | null;
  setField: (key: string, fieldKey: string, value: DraftValue) => void;
  toggleMultiselect: (key: string, fieldKey: string, option: string, include: boolean) => void;
  submitForm: (item: PendingInteraction) => void;
  submitDecision: (item: PendingInteraction, decision: 'once' | 'always' | 'reject') => void;
};

export const interactionKey = (item: { kind: string; sessionID: string; requestID: string }): string =>
  JSON.stringify([item.kind, item.sessionID, item.requestID]);

export const fieldVisible = (field: FormField, draft: DraftValues | undefined): boolean => {
  const when = field.when;
  if (when === null || when === undefined || typeof when !== 'object' || typeof (when as { field?: unknown }).field !== 'string') {
    return true;
  }
  const condition = when as { field: string; equals?: unknown };
  return draft?.[condition.field] === condition.equals;
};

const InteractionStateContext = createContext<InteractionStateValue | null>(null);

export function useInteractionState(): InteractionStateValue {
  const value = useContext(InteractionStateContext);
  if (value === null) throw new Error('useInteractionState requires InteractionStateProvider');
  return value;
}

type ProviderProps = {
  id: string;
  reload: () => Promise<void>;
  children: ReactNode;
};

export function InteractionStateProvider({ id, reload, children }: ProviderProps) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const replyingRef = useRef(replying);
  replyingRef.current = replying;

  const setField = useCallback((key: string, fieldKey: string, value: DraftValue) => {
    setDrafts(current => ({ ...current, [key]: { ...(current[key] ?? {}), [fieldKey]: value } }));
  }, []);

  const toggleMultiselect = useCallback((key: string, fieldKey: string, option: string, include: boolean) => {
    setDrafts(current => {
      const existing = current[key] ?? {};
      const values = new Set(Array.isArray(existing[fieldKey]) ? existing[fieldKey] : []);
      if (include) values.add(option);
      else values.delete(option);
      return { ...current, [key]: { ...existing, [fieldKey]: [...values] } };
    });
  }, []);

  const reply = useCallback(async (key: string, payload: Record<string, unknown>) => {
    if (replyingRef.current) return;
    setReplying(true);
    setError(null);
    try {
      await api(`/api/executions/${encodeURIComponent(id)}/interactions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setDrafts(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await reload();
    } catch (failure) {
      const code = isApiFailure(failure) ? failure.body?.error : null;
      setError(INTERACTION_ERRORS[typeof code === 'string' ? code : ''] ?? INTERACTION_ERRORS['reply-unconfirmed']);
    } finally {
      setReplying(false);
    }
  }, [id, reload]);

  const submitForm = useCallback((item: PendingInteraction) => {
    const key = interactionKey(item);
    const answers = draftsRef.current[key] ?? {};
    const fields = Array.isArray(item.request?.fields) ? item.request.fields : [];
    const answer: Record<string, unknown> = {};
    for (const field of fields) {
      if (!fieldVisible(field, answers)) continue;
      const raw = answers[field.key] ?? (field.type === 'boolean' ? false : undefined);
      if (raw === undefined || raw === '') continue;
      answer[field.key] = field.type === 'number' || field.type === 'integer' ? Number(raw) : raw;
    }
    void reply(key, { kind: 'form', sessionID: item.sessionID, requestID: item.requestID, answer });
  }, [reply]);

  const submitDecision = useCallback((item: PendingInteraction, decision: 'once' | 'always' | 'reject') => {
    void reply(interactionKey(item), {
      kind: 'permission',
      sessionID: item.sessionID,
      requestID: item.requestID,
      decision,
    });
  }, [reply]);

  const value = useMemo(() => ({ drafts, replying, error, setField, toggleMultiselect, submitForm, submitDecision }),
    [drafts, replying, error, setField, toggleMultiselect, submitForm, submitDecision]);
  return <InteractionStateContext.Provider value={value}>{children}</InteractionStateContext.Provider>;
}
