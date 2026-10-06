import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ChainSnapshot, OIWall } from '../types'

const count = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : Math.round(value).toLocaleString('en-IN')
const ratio = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : value.toFixed(2)
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : `${(value * 100).toFixed(1)}%`
const short = (value: number) => value >= 1e7 ? `${(value / 1e7).toFixed(1)}Cr` : value >= 1e5 ? `${(value / 1e5).toFixed(1)}L` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(Math.round(value))

function WallList({ title, walls, tone }: { title: string; walls: OIWall[]; tone: 'call' | 'put' }) {
  const max = Math.max(0, ...walls.map((wall) => wall.oi))
  return (
    <div className={`wall-list ${tone}`}>
      <div className="wall-list-head"><span>{title}</span><span>Top concentration</span></div>
      {walls.length ? walls.map((wall) => (
        <div className="wall-row" key={wall.strike}>
          <span className="wall-strike">{wall.strike.toLocaleString('en-IN')}</span>
          <div className="wall-track"><i style={{ width: `${max ? (wall.oi / max) * 100 : 0}%` }} /></div>
          <span className="wall-value">{short(wall.oi)}</span>
        </div>
      )) : <div className="wall-na">N/A · insufficient OI observations</div>}
    </div>
  )
}

export function OiAnalysis({ snapshot }: { snapshot: ChainSnapshot | null }) {
  const analysis = snapshot?.oi_analysis
  const rows = snapshot?.strikes || []
  const chartRows = rows.map((row) => ({
    strike: String(Math.round(row.strike)),
    CE: row.ce?.oi ?? null,
    PE: row.pe?.oi ?? null,
  })).filter((row) => row.CE !== null || row.PE !== null)

  return (
    <section className="panel oi-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap"><span className="section-icon section-icon-violet">⌗</span><div><h2>Open interest</h2><p>Selected strike window · Kite-reported OI</p></div></div>
        <span className="subtle-tag">{analysis ? `OI walls · P${analysis.oi_wall_percentile}` : 'No chain'}</span>
      </div>
      <div className="oi-summary-grid">
        <div className="oi-summary-item"><span>Total CE OI</span><strong>{count(analysis?.total_ce_oi)}</strong><small>Δ {count(analysis?.total_ce_change_oi)} · {analysis ? `${analysis.ce_oi_coverage.observed}/${analysis.ce_oi_coverage.contracts} OI` : 'N/A coverage'}</small></div>
        <div className="oi-summary-item"><span>Total PE OI</span><strong>{count(analysis?.total_pe_oi)}</strong><small>Δ {count(analysis?.total_pe_change_oi)} · {analysis ? `${analysis.pe_oi_coverage.observed}/${analysis.pe_oi_coverage.contracts} OI` : 'N/A coverage'}</small></div>
        <div className="oi-summary-item oi-pcr"><span>Put / call PCR</span><strong>{ratio(analysis?.pcr)}</strong><small>Selected strikes only</small></div>
      </div>
      <div className="oi-chart-wrap">
        {chartRows.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartRows} margin={{ top: 8, right: 6, left: -18, bottom: 2 }} barGap={2}>
              <CartesianGrid stroke="rgba(148,163,184,.075)" vertical={false} />
              <XAxis dataKey="strike" tick={{ fill: '#748396', fontSize: 9 }} axisLine={{ stroke: 'rgba(148,163,184,.12)' }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={short} tick={{ fill: '#748396', fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: 'rgba(148,163,184,.06)' }}
                contentStyle={{ background: '#111a25', border: '1px solid rgba(148,163,184,.18)', borderRadius: 10, color: '#e7edf4', fontSize: 11 }}
                formatter={(value: unknown, name: unknown) => [value == null ? 'N/A' : typeof value === 'number' ? value.toLocaleString('en-IN') : String(value), `${String(name)} OI`]}
                labelFormatter={(label) => `Strike ${label}`}
              />
              <Bar dataKey="CE" fill="#35cba0" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="PE" fill="#b27bea" radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        ) : <div className="chart-empty-inline">OI chart appears when Kite provides current contract OI.</div>}
      </div>
      <div className="walls-grid">
        <WallList title="Call OI walls" walls={analysis?.ce_oi_walls || []} tone="call" />
        <WallList title="Put OI walls" walls={analysis?.pe_oi_walls || []} tone="put" />
      </div>
      <div className="oi-levels">
        <div><span>Highest CE OI</span><b>{analysis?.highest_ce_oi_strike?.toLocaleString('en-IN') ?? 'N/A'}</b></div>
        <div><span>Highest PE OI</span><b>{analysis?.highest_pe_oi_strike?.toLocaleString('en-IN') ?? 'N/A'}</b></div>
        <div><span>CE top-3 concentration</span><b>{percent(analysis?.ce_concentration_top_3)}</b></div>
        <div><span>PE top-3 concentration</span><b>{percent(analysis?.pe_concentration_top_3)}</b></div>
      </div>
      <div className="panel-footnote"><span>OI walls are thresholded at the configured percentile, not support / resistance claims.</span><span>{analysis?.scope || 'N/A'}</span></div>
    </section>
  )
}
