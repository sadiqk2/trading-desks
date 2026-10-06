import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ChainSnapshot } from '../types'

const short = (value: number) => value >= 1e7 ? `${(value / 1e7).toFixed(1)}Cr` : value >= 1e5 ? `${(value / 1e5).toFixed(1)}L` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(Math.round(value))

export function FlowCharts({ snapshot }: { snapshot: ChainSnapshot | null }) {
  const volume = (snapshot?.strikes || []).map((row) => ({
    strike: String(Math.round(row.strike)),
    CE: row.ce?.volume ?? null,
    PE: row.pe?.volume ?? null,
  })).filter((row) => row.CE !== null || row.PE !== null)
  const iv = (snapshot?.strikes || []).map((row) => ({
    strike: String(Math.round(row.strike)),
    CE: row.ce?.iv == null ? null : row.ce.iv * 100,
    PE: row.pe?.iv == null ? null : row.pe.iv * 100,
  })).filter((row) => row.CE !== null || row.PE !== null)
  const tooltipStyle = { background: '#111a25', border: '1px solid rgba(148,163,184,.18)', borderRadius: 10, color: '#e7edf4', fontSize: 11 }

  return (
    <section className="panel flow-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap"><span className="section-icon section-icon-blue">⌁</span><div><h2>IV & volume profile</h2><p>Current selected chain · no history inferred</p></div></div>
        <span className="subtle-tag">{snapshot?.expiry || 'N/A'}</span>
      </div>
      <div className="dual-charts">
        <div className="mini-chart-block">
          <div className="mini-chart-title"><span>Traded volume by strike</span><div><i className="legend-call" /> CE <i className="legend-put" /> PE</div></div>
          {volume.length ? <ResponsiveContainer width="100%" height={180}>
            <BarChart data={volume} margin={{ top: 4, right: 0, left: -25, bottom: 0 }} barGap={2}>
              <CartesianGrid stroke="rgba(148,163,184,.075)" vertical={false} />
              <XAxis dataKey="strike" tick={{ fill: '#748396', fontSize: 8 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={short} tick={{ fill: '#748396', fontSize: 8 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value: unknown, name: unknown) => [value == null ? 'N/A' : typeof value === 'number' ? value.toLocaleString('en-IN') : String(value), `${String(name)} volume`]} labelFormatter={(label) => `Strike ${label}`} />
              <Bar dataKey="CE" fill="#42c9a0" radius={[2, 2, 0, 0]} maxBarSize={16} />
              <Bar dataKey="PE" fill="#b47de8" radius={[2, 2, 0, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer> : <div className="mini-chart-empty">N/A · Kite has not returned option volume.</div>}
        </div>
        <div className="mini-chart-block">
          <div className="mini-chart-title"><span>Calculated IV by strike</span><div><i className="legend-call" /> CE <i className="legend-put" /> PE</div></div>
          {iv.length ? <ResponsiveContainer width="100%" height={180}>
            <LineChart data={iv} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="rgba(148,163,184,.075)" vertical={false} />
              <XAxis dataKey="strike" tick={{ fill: '#748396', fontSize: 8 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tickFormatter={(value) => `${value}%`} tick={{ fill: '#748396', fontSize: 8 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value: unknown, name: unknown) => [value == null ? 'N/A' : typeof value === 'number' ? `${value.toFixed(2)}%` : String(value), `${String(name)} IV`]} labelFormatter={(label) => `Strike ${label}`} />
              <Line type="monotone" dataKey="CE" stroke="#42c9a0" strokeWidth={1.8} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="PE" stroke="#b47de8" strokeWidth={1.8} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer> : <div className="mini-chart-empty">N/A · IV requires a usable Kite price, live spot and time to expiry.</div>}
        </div>
      </div>
      <div className="panel-footnote"><span>IV is derived with Black-Scholes from genuine Kite quotes.</span><span>No IV percentile without stored history.</span></div>
    </section>
  )
}
