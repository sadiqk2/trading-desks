import { ArrowDownRight, ArrowUpRight, Minus, ShieldAlert, Signal as SignalIcon } from 'lucide-react'
import type { Signal } from '../types'

export function SignalPanel({ signal, marketPhase }: { signal: Signal; marketPhase: string }) {
  const direction = signal.direction
  const tone = direction === 'BULLISH' ? 'bull' : direction === 'BEARISH' ? 'bear' : 'neutral'
  const Icon = direction === 'BULLISH' ? ArrowUpRight : direction === 'BEARISH' ? ArrowDownRight : direction === 'NEUTRAL' ? Minus : SignalIcon
  const emptyLabel = marketPhase !== 'LIVE' ? 'MARKET CLOSED' : 'INSUFFICIENT DATA'
  return (
    <section className="panel signal-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap"><span className="section-icon section-icon-green"><SignalIcon size={16} /></span><div><h2>Rule signal</h2><p>Deterministic observation · no order execution</p></div></div>
        <span className="subtle-tag">{signal.max_score ? `${signal.max_score} inputs` : '—'}</span>
      </div>
      <div className={`signal-main ${tone}`}>
        <div className="signal-ring"><div className="signal-ring-inner"><Icon size={22} /><span>{signal.confidence == null ? '—' : `${signal.confidence}%`}</span></div></div>
        <div className="signal-verdict">
          <span className="signal-overline">CURRENT OBSERVATION</span>
          <strong>{direction || emptyLabel}</strong>
          <span className="signal-score">Rule score <b>{signal.score == null ? 'N/A' : `${signal.score > 0 ? '+' : ''}${signal.score} / ${signal.max_score}`}</b></span>
        </div>
      </div>
      <div className="signal-confidence-copy"><ShieldAlert size={13} /> Score alignment is not a probability of success.</div>
      <div className="signal-reasons-title">Evidence from current selected window</div>
      {signal.reasons.length ? (
        <div className="signal-reasons">
          {signal.reasons.map((reason, index) => (
            <div className="signal-reason" key={`${reason.text}-${index}`}>
              <span className={reason.effect === 'positive' ? 'reason-mark positive' : 'reason-mark negative'}>{reason.effect === 'positive' ? '+' : '−'}</span>
              <span>{reason.text}</span>
            </div>
          ))}
        </div>
      ) : <div className="signal-no-reasons">N/A · signal waits for fresh spot and option-chain observations.</div>}
      <div className="signal-safety"><span className="safety-dot" /> Analytic context only <span className="safety-divider">·</span> not a recommendation</div>
    </section>
  )
}
