import { useMemo, useState } from 'react'
import { Calculator, Info } from 'lucide-react'

const fmt = (value: number | null) => value == null || !Number.isFinite(value) ? 'N/A' : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const parse = (value: string) => value.trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null

export function RiskCalculator() {
  const [capital, setCapital] = useState('')
  const [riskPercent, setRiskPercent] = useState('')
  const [entry, setEntry] = useState('')
  const [stop, setStop] = useState('')
  const [target, setTarget] = useState('')
  const [lotSize, setLotSize] = useState('')
  const [lots, setLots] = useState('')

  const values = useMemo(() => {
    const c = parse(capital)
    const rp = parse(riskPercent)
    const e = parse(entry)
    const s = parse(stop)
    const t = parse(target)
    const size = parse(lotSize)
    const lotCount = parse(lots)
    if ([c, rp, e, s, t, size, lotCount].some((value) => value == null) || (size ?? 0) <= 0 || (lotCount ?? 0) < 0) return null
    const maxRisk = (c as number) * (rp as number) / 100
    const riskPerUnit = Math.abs((e as number) - (s as number))
    const riskPerLot = riskPerUnit * (size as number)
    const quantity = (size as number) * (lotCount as number)
    return {
      maxRisk,
      actualRisk: riskPerUnit * quantity,
      riskPerLot,
      quantity,
      capitalRequired: (e as number) * quantity,
      potential: ((t as number) - (e as number)) * quantity,
      rr: riskPerUnit ? Math.abs((t as number) - (e as number)) / riskPerUnit : null,
      maxLots: riskPerLot ? Math.floor(maxRisk / riskPerLot) : null,
    }
  }, [capital, riskPercent, entry, stop, target, lotSize, lots])

  const overBudget = values?.maxLots != null && parse(lots) != null && (parse(lots) as number) > values.maxLots
  return (
    <section className="panel risk-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap"><span className="section-icon section-icon-amber"><Calculator size={16} /></span><div><h2>Risk calculator</h2><p>User-entered assumptions · no broker margin estimates</p></div></div>
        <span className="subtle-tag">LOCAL CALCULATION</span>
      </div>
      <div className="risk-layout">
        <div className="risk-inputs">
          <Field label="Capital (₹)" value={capital} set={setCapital} placeholder="Enter capital" />
          <Field label="Risk (%)" value={riskPercent} set={setRiskPercent} placeholder="e.g. 1" step="0.1" />
          <Field label="Entry premium" value={entry} set={setEntry} placeholder="₹ / unit" />
          <Field label="Stop premium" value={stop} set={setStop} placeholder="₹ / unit" />
          <Field label="Target premium" value={target} set={setTarget} placeholder="₹ / unit" />
          <Field label="Lot size" value={lotSize} set={setLotSize} placeholder="Kite master / manual" step="1" />
          <Field label="Number of lots" value={lots} set={setLots} placeholder="Enter lots" step="1" />
        </div>
        <div className="risk-results">
          <div className="risk-budget"><span>Risk budget</span><strong>{fmt(values?.maxRisk ?? null)}</strong><small>Capital × risk %</small></div>
          <div className="risk-results-grid">
            <Result label="Position size" value={values ? `${values.quantity.toLocaleString('en-IN')} units` : 'N/A'} />
            <Result label="Max lots within budget" value={values?.maxLots == null ? 'N/A' : String(values.maxLots)} />
            <Result label="Stop-loss risk" value={fmt(values?.actualRisk ?? null)} />
            <Result label="Premium capital required" value={fmt(values?.capitalRequired ?? null)} />
            <Result label="Target outcome" value={fmt(values?.potential ?? null)} tone={values && values.potential >= 0 ? 'positive' : 'negative'} />
            <Result label="Risk / reward" value={values?.rr == null ? 'N/A' : `1 : ${values.rr.toFixed(2)}`} />
          </div>
          {overBudget ? <div className="risk-warning">Entered lots exceed the risk-budget size. Reduce lots or revise the user-entered assumptions.</div> : null}
          <div className="risk-note"><Info size={13} /> Estimate excludes brokerage, taxes, slippage and margin. Potential outcome is arithmetic from your entry and target, not a forecast.</div>
        </div>
      </div>
    </section>
  )
}

function Field({ label, value, set, placeholder, step = 'any' }: { label: string; value: string; set: (value: string) => void; placeholder: string; step?: string }) {
  return <label className="risk-field"><span>{label}</span><input value={value} onChange={(event) => set(event.target.value)} type="number" inputMode="decimal" step={step} min="0" placeholder={placeholder} /></label>
}
function Result({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  return <div className="result-row"><span>{label}</span><b className={tone ? `result-${tone}` : ''}>{value}</b></div>
}
