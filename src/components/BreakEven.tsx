import { Card, Label } from '@/components/ui';

const pctDk = (n: number) => n.toLocaleString('da-DK', { maximumFractionDigits: 2 });

/**
 * Signaturen: hvor meget aktien skal stige, før handlen går i nul efter omkostninger.
 * Tallet er round-trip-omkostningen fra roundTripCost (costs.json) – ingen ny beregning her, kun visning.
 * `basis` siger, hvilken handelsstørrelse tallet gælder for.
 */
export function BreakEven({
  cost,
  basis,
  compact = false,
}: {
  cost: { pct: number; dkk: number; liquidityKnown: boolean } | undefined;
  basis: string;
  /** Kun linjen, uden skala (bruges i handelsplanen, når skalaen står øverst i sagen). */
  compact?: boolean;
}) {
  if (!cost) {
    return (
      <Card className="p-4">
        <Label>Break-even</Label>
        <p className="mt-1 text-sm text-graphite">Mangler data: ukendt marked eller valuta i costs.json.</p>
      </Card>
    );
  }
  if (compact) {
    return (
      <p className="text-sm">
        Skal stige <span className="font-mono font-medium">{pctDk(cost.pct)} %</span> for at gå i nul{' '}
        <span className="text-graphite">
          · omkostning ≈ <span className="font-mono">{cost.dkk.toLocaleString('da-DK', { maximumFractionDigits: 0 })} kr.</span> {basis}
          {!cost.liquidityKnown && ' · likviditet ukendt (værste spread-skøn brugt)'}
        </span>
      </p>
    );
  }
  const max = Math.max(2, Math.ceil(cost.pct * 2));
  const step = max <= 3 ? 0.5 : 1;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const at = (v: number) => `${(v / max) * 100}%`;

  return (
    <Card className="p-4">
      <p className="text-base text-ink">
        Skal stige <span className="font-mono font-medium">{pctDk(cost.pct)} %</span> for at gå i nul
      </p>
      <Label className="mt-0.5">
        Omkostning ≈ <span className="font-mono">{cost.dkk.toLocaleString('da-DK', { maximumFractionDigits: 0 })} kr.</span> {basis}
        {!cost.liquidityKnown && ' · likviditet ukendt (værste spread-skøn brugt)'}
      </Label>

      <div className="relative mt-4 h-14" role="img" aria-label={`Skala fra 0 til ${max} %. Nulpunktet ligger ved ${pctDk(cost.pct)} %.`}>
        <div className="absolute inset-x-0 top-2 h-2 rounded-sm bg-line" />
        <div className="absolute left-0 top-2 h-2 rounded-l-sm bg-loss/35" style={{ width: at(cost.pct) }} />
        <div className="absolute top-0 h-6 w-0.5 -translate-x-1/2 bg-ink" style={{ left: at(cost.pct) }} />
        {ticks.map((t) => (
          <div key={t} className="absolute top-5 -translate-x-1/2 font-mono text-xs text-graphite" style={{ left: at(t) }}>
            <div className="mx-auto h-1.5 w-px bg-graphite/60" />
            {pctDk(t)}
          </div>
        ))}
        <div className="absolute top-11 flex w-full text-xs">
          <span className="text-loss" style={{ width: at(cost.pct) }}>
            {cost.pct / max > 0.18 ? 'omkostning' : ''}
          </span>
          <span className="pl-2 text-graphite">gevinst herfra</span>
        </div>
      </div>
    </Card>
  );
}
