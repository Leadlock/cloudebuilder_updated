/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { useEscapeKey } from '@/lib/ui/useEscapeKey';

const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));

describe('useEscapeKey', () => {
  test('calls the handler when Escape is pressed, and only for Escape', () => {
    const onEscape = jest.fn();
    renderHook(() => useEscapeKey(onEscape));
    press('Enter');
    press('a');
    expect(onEscape).not.toHaveBeenCalled();
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test('does nothing when switched off with undefined (a dialog that must not close while it is working)', () => {
    const onEscape = jest.fn();
    const { rerender } = renderHook(({ h }: { h: (() => void) | undefined }) => useEscapeKey(h), { initialProps: { h: undefined as (() => void) | undefined } });
    press('Escape');
    expect(onEscape).not.toHaveBeenCalled();
    rerender({ h: onEscape });
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    rerender({ h: undefined });
    press('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test('stops listening when the dialog goes away', () => {
    const onEscape = jest.fn();
    const { unmount } = renderHook(() => useEscapeKey(onEscape));
    unmount();
    press('Escape');
    expect(onEscape).not.toHaveBeenCalled();
  });

  test('leaves an Escape that something else already handled alone', () => {
    const onEscape = jest.fn();
    renderHook(() => useEscapeKey(onEscape));
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(onEscape).not.toHaveBeenCalled();
  });
});
