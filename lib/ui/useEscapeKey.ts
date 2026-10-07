import { useEffect } from 'react';

/**
 * Calls `onEscape` when the Escape key is pressed, so a dialog closes the way people expect. Pass undefined to switch it off (a dialog that
 * must not be dismissed while it is working, for example while a deletion is in progress). Call it before any early return in the component.
 */
export function useEscapeKey(onEscape: (() => void) | undefined | null): void {
  useEffect(() => {
    if (!onEscape) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}
