import type { OptionLeg, OptionRow } from '../types'

const fmt = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : value.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
const fmtInt = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value).toLocaleString('en-IN')
const fmtIv = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? null : `${(value * 100).toFixed(2)}%`

function DataCell({ value, formatter = fmt }: { value: number | null | undefined; formatter?: (value: number | null | undefined) => string | null }) {
  const shown = formatter(value)
  return <td className={shown === null ? 'numeric-cell cell-na' : 'numeric-cell'} title={shown === null ? 'N/A — unavailable from the current Kite observation' : undefined}>{shown ?? 'N/A'}</td>
}

const callColumns = [
  { key: 'oi', label: 'OI', format: fmtInt },
  { key: 'change_oi', label: 'Δ OI', format: fmtInt },
  { key: 'volume', label: 'Volume', format: fmtInt },
  { key: 'last_price', label: 'LTP', format: fmt },
  { key: 'bid', label: 'Bid', format: fmt },
  { key: 'ask', label: 'Ask', format: fmt },
  { key: 'iv', label: 'IV', format: fmtIv },
  { key: 'delta', label: 'Delta', format: (v: number | null | undefined) => fmt(v, 3) },
  { key: 'gamma', label: 'Gamma', format: (v: number | null | undefined) => fmt(v, 5) },
  { key: 'theta', label: 'Theta', format: (v: number | null | undefined) => fmt(v, 3) },
  { key: 'vega', label: 'Vega', format: (v: number | null | undefined) => fmt(v, 3) },
] as const
const putColumns = [
  { key: 'last_price', label: 'LTP', format: fmt },
  { key: 'bid', label: 'Bid', format: fmt },
  { key: 'ask', label: 'Ask', format: fmt },
  { key: 'iv', label: 'IV', format: fmtIv },
  { key: 'delta', label: 'Delta', format: (v: number | null | undefined) => fmt(v, 3) },
  { key: 'gamma', label: 'Gamma', format: (v: number | null | undefined) => fmt(v, 5) },
  { key: 'theta', label: 'Theta', format: (v: number | null | undefined) => fmt(v, 3) },
  { key: 'vega', label: 'Vega', format: (v: number | null | undefined) => fmt(v, 3) },
  { key: 'volume', label: 'Volume', format: fmtInt },
  { key: 'change_oi', label: 'Δ OI', format: fmtInt },
  { key: 'oi', label: 'OI', format: fmtInt },
] as const

function Activity({ value }: { value: string }) {
  const className = value === 'LONG_BUILDUP' ? 'activity activity-long' : value === 'SHORT_BUILDUP' ? 'activity activity-short' : value === 'SHORT_COVERING' ? 'activity activity-cover' : value === 'LONG_UNWINDING' ? 'activity activity-unwind' : 'activity activity-neutral'
  const label = value === 'LONG_BUILDUP' ? 'LONG BUILD' : value === 'SHORT_BUILDUP' ? 'SHORT BUILD' : value === 'SHORT_COVERING' ? 'COVERING' : value === 'LONG_UNWINDING' ? 'UNWINDING' : 'NEUTRAL'
  return <span className={className}>{label}</span>
}

function LegCells({ leg, columns }: { leg: OptionLeg | null; columns: typeof callColumns | typeof putColumns }) {
  return <>{columns.map((column) => <DataCell key={column.key} value={leg?.[column.key as keyof OptionLeg] as number | null | undefined} formatter={column.format} />)}
    {leg ? <td className="activity-cell"><Activity value={leg.activity} /></td> : <td className="activity-cell"><span className="cell-na">—</span></td>}
  </>
}

interface Props {
  rows: OptionRow[]
  atm: number | null
  range: number
  timestamp: string | null
  connected: boolean
  stale: boolean
  loading: boolean
  error: string | null
}

export function OptionChain({ rows, atm, range, timestamp, connected, stale, loading, error }: Props) {
  const columnCount = callColumns.length + putColumns.length + 3
  return (
    <section className="panel chain-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap">
          <span className="section-icon section-icon-teal">⌘</span>
          <div><h2>Option chain</h2><p>Live option quotes · full depth mode · listed contracts only</p></div>
        </div>
        <div className="chain-meta">
          {rows.length > 0 ? <span className="subtle-tag">±{range} strikes · {rows.length} rows</span> : null}
          <span className={connected ? 'stream-tag stream-on' : 'stream-tag'}><i />{connected ? 'STREAM LINKED' : 'STREAM OFFLINE'}</span>
        </div>
      </div>
      {stale && <div className="inline-warning"><span>!</span> Data is stale. Values retain their Kite observation timestamps; do not treat them as current quotes.</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="chain-scroll">
        <table className="option-table">
          <thead>
            <tr className="group-head">
              <th colSpan={callColumns.length + 1} className="call-group">CALLS <span>CE</span></th>
              <th rowSpan={2} className="strike-group">STRIKE</th>
              <th colSpan={putColumns.length + 1} className="put-group">PUTS <span>PE</span></th>
            </tr>
            <tr className="column-head">
              {callColumns.map((column) => <th key={`ce-${column.key}`} className={column.key === 'oi' || column.key === 'change_oi' ? 'oi-column' : ''}>{column.label}</th>)}
              <th className="activity-head">PRICE / OI</th>
              {putColumns.map((column) => <th key={`pe-${column.key}`} className={column.key === 'oi' || column.key === 'change_oi' ? 'oi-column' : ''}>{column.label}</th>)}
              <th className="activity-head">PRICE / OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.strike} className={row.is_atm ? 'atm-row' : ''}>
                <LegCells leg={row.ce} columns={callColumns} />
                <td className={`strike-cell ${row.is_atm ? 'strike-atm' : ''}`}>
                  {row.is_atm ? <span className="atm-label">ATM</span> : null}
                  <strong>{fmtInt(row.strike)}</strong>
                </td>
                <LegCells leg={row.pe} columns={putColumns} />
              </tr>
            )) : (
              <tr><td className="empty-chain" colSpan={columnCount}>
                <div className="empty-chain-content">
                  <div className="empty-chain-icon">⌁</div>
                  <strong>{loading ? 'Connecting to Kite market data' : connected ? 'Choose a listed expiry' : 'Connect your Kite account to begin'}</strong>
                  <span>{error || (loading ? 'Fetching the live instrument master and selected contracts.' : 'No option quotes are shown until Kite Connect authenticates and returns genuine market data.')}</span>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="chain-footer">
        <div className="activity-legend"><span><i className="dot dot-green" /> Long buildup</span><span><i className="dot dot-red" /> Short buildup</span><span><i className="dot dot-amber" /> Covering / unwinding</span></div>
        <span>Observed: {timestamp ? new Date(timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'N/A'}</span>
      </div>
      <div className="panel-footnote">
        <span>Change OI = current OI − first observed OI for this contract today.</span>
        <span>IV / Greeks: calculated Black-Scholes, not broker-provided.</span>
      </div>
    </section>
  )
}
