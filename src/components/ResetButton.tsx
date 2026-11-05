'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { btn } from '@/components/ui';

/** Lille "Nulstil data" med bekræftelse i to trin. Selve sletningen og genindlæsningen sker i onReset (page.tsx). */
export function ResetButton({ onReset }: { onReset: () => Promise<void> }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setStep('busy');
    try {
      await onReset();
    } catch (err) {
      setError(`Nulstillingen fejlede: ${err instanceof Error ? err.message : String(err)}`);
      setStep('idle');
    }
  };

  if (step === 'idle') {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setStep('confirm');
          }}
          className={`${btn.quiet} -ml-2 text-xs`}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Nulstil data
        </button>
        {error && (
          <p role="alert" className="text-xs text-loss">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Bekræft nulstilling" className="space-y-2 rounded-md border border-loss/50 bg-surface p-2 text-xs text-ink">
      <p>Slet alle domme og paper-trades? Scans, Nordnet-handler og Måling bevares. Der gemmes en backup først.</p>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={confirm}
          disabled={step === 'busy'}
          className="rounded-md border border-loss/70 px-2 py-1 font-medium text-loss hover:bg-loss/10 disabled:opacity-40"
        >
          {step === 'busy' ? 'Nulstiller …' : 'Nulstil'}
        </button>
        <button type="button" onClick={() => setStep('idle')} disabled={step === 'busy'} className={`${btn.quiet} text-xs`} autoFocus>
          Annullér
        </button>
      </div>
    </div>
  );
}
