import { useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { BACKEND_API, CREDENTIALS_CHANGED, announceCredentialChange } from '../../config/api';

const DISMISS_KEY = 'fedda_hf_reminder_dismissed';

/**
 * Home-screen reminder to add a Hugging Face token. Shows only when no token is
 * configured and the user hasn't dismissed it. Lets them paste the token inline
 * (same endpoint as the top-strip badge). The top-strip "HF Token Missing" chip
 * stays as the always-on indicator; this is the one-time nudge new users need.
 */
export const HFTokenReminder = () => {
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return;
    const check = () => {
      fetch(`${BACKEND_API.BASE_URL}${BACKEND_API.ENDPOINTS.SETTINGS_HF_TOKEN_STATUS}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => setShow(!d?.configured))
        .catch(() => {});
    };
    check();
    // Also on focus: the token can change outside the app entirely, and coming
    // back to the window is the moment to notice.
    window.addEventListener(CREDENTIALS_CHANGED, check);
    window.addEventListener('focus', check);
    return () => {
      window.removeEventListener(CREDENTIALS_CHANGED, check);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!show) return null;

  const addToken = async () => {
    const token = window.prompt(
      'Paste your Hugging Face token (starts with hf_).\n\nGet one free at huggingface.co/settings/tokens — FEDDA uses it to download models.'
    );
    if (token === null) return;
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const r = await fetch(`${BACKEND_API.BASE_URL}${BACKEND_API.ENDPOINTS.SETTINGS_HF_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: trimmed }),
      });
      if (!r.ok) throw new Error('save failed');
      setShow(false);
      announceCredentialChange();
    } catch {
      window.alert('Could not save the Hugging Face token.');
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setShow(false);
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2.5">
      <KeyRound className="h-4 w-4 flex-shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1 text-[12px] leading-snug text-amber-100/90">
        <span className="font-semibold">Add your Hugging Face token to finish setup</span> — FEDDA downloads models
        from Hugging Face, and some gated ones won&apos;t download without it. It&apos;s free.
      </div>
      <button
        onClick={addToken}
        disabled={saving}
        className="flex-shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Add token'}
      </button>
      <button onClick={dismiss} title="Dismiss" className="flex-shrink-0 text-amber-400/60 transition hover:text-amber-300">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};
