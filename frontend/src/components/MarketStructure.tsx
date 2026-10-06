import { Crosshair, Radar } from 'lucide-react'
import type { ChainSnapshot } from '../types'

const price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 })

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="structure-row"><span>{label}</span><b>{value}</b>{note ? <small>{note}</small> : null}</div>
}

export function MarketStructure({ snapshot }: { snapshot: ChainSnapshot | null }) {
  const ceWall = snapshot?.oi_analysis.ce_oi_walls[0]
  const peWall = snapshot?.oi_analysis.pe_oi_walls[0]
  const iv = snapshot?.atm_iv == null ? 'N/A' : `${(snapshot.atm_iv * 100).toFixed(2)}%`
  const expected = snapshot?.expected_move
  return (
    <section className="panel structure-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap"><span className="section-icon section-icon-cyan"><Radar size={16} /></span><div><h2>Market structure</h2><p>Transparent, selected-window observations</p></div></div>
        <span className="subtle-tag">{snapshot ? 'LIVE SNAPSHOT' : 'NO DATA'}</span>
      </div>
      <div className="structure-hero">
        <div className="structure-hero-spot"><span>SPOT</span><strong>{price(snapshot?.spot.spot)}</strong><small>{snapshot?.spot.tradingsymbol || 'N/A'} · {snapshot?.underlying || 'N/A'}</small></div>
        <div className="structure-hero-atm"><span>ATM STRIKE</span><strong>{snapshot ? price(snapshot.atm) : 'N/A'}</strong><small>{snapshot?.expiry || 'Select expiry'}</small></div>
      </div>
      <div className="structure-rows">
        <Row label="Selected-window PCR" value={snapshot?.oi_analysis.pcr == null ? 'N/A' : snapshot.oi_analysis.pcr.toFixed(2)} note="Put OI ÷ call OI" />
        <Row label="ATM IV" value={iv} note="Calculated · Black-Scholes" />
        <Row label="Largest CE OI wall" value={ceWall ? price(ceWall.strike) : 'N/A'} note={ceWall ? `${Math.round(ceWall.oi).toLocaleString('en-IN')} OI · P${snapshot?.oi_analysis.oi_wall_percentile}` : 'No qualifying observation'} />
        <Row label="Largest PE OI wall" value={peWall ? price(peWall.strike) : 'N/A'} note={peWall ? `${Math.round(peWall.oi).toLocaleString('en-IN')} OI · P${snapshot?.oi_analysis.oi_wall_percentile}` : 'No qualifying observation'} />
        <Row label="Expected move (1σ)" value={expected == null ? 'N/A' : `±${price(expected)}`} note={snapshot?.expected_move_formula || 'Formula unavailable until IV is calculable'} />
      </div>
      {expected != null ? <div className="expected-range"><Crosshair size={13} /><span>Indicative range</span><b>{price(snapshot?.expected_lower)}</b><i>to</i><b>{price(snapshot?.expected_upper)}</b></div> : null}
      <div className="structure-caution">OI concentrations are descriptive—not support or resistance. Expected move is a model estimate, not a guaranteed range.</div>
    </section>
  )
}
