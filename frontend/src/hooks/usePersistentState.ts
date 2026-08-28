import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

const resolveInitialValue = <T>(value: T | (() => T)): T => {
    return typeof value === 'function' ? (value as () => T)() : value;
};

export const usePersistentState = <T>(
    storageKey: string,
    initialValue: T | (() => T)
): [T, Dispatch<SetStateAction<T>>] => {
    const [state, setState] = useState<T>(() => {
        if (typeof window === 'undefined') {
            return resolveInitialValue(initialValue);
        }

        try {
            const stored = window.localStorage.getItem(storageKey);
            if (stored !== null) {
                return JSON.parse(stored) as T;
            }
        } catch {
            // Ignore malformed or inaccessible localStorage values.
        }

        return resolveInitialValue(initialValue);
    });

    useEffect(() => {
        if (typeof window === 'undefined') return;

        try {
            window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch {
            // Ignore quota and storage access errors.
        }
    }, [storageKey, state]);

    return [state, setState];
};
