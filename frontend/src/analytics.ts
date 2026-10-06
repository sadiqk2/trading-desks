import type { ChainSnapshot, Signal, SignalReason } from './types'

/** Mirrors the backend's explicit, data-only signal rules for stream updates. */
export function evaluateSignal(snapshot: ChainSnapshot | null, marketPhase: string): Signal {
  if (!snapshot || marketPhase !== 'LIVE' || snapshot.data_status !== 'live') {
    return { direction: null, score: null, max_score: null, confidence: null, reasons: [], status: marketPhase === 'LIVE' ? 'insufficient_data' : 'market_closed' }
  }
  const factors: Array<{ score: number; text: string }> = []
  const spotChange = snapshot.spot?.change_percent
  if (spotChange != null && spotChange !== 0) factors.push({ score: spotChange > 0 ? 1 : -1, text: 'Spot above / below previous close' })

  const pcr = snapshot.oi_analysis?.pcr
  if (pcr != null) {
    if (pcr >= 1.05) factors.push({ score: 1, text: 'Selected-window PCR ≥ 1.05' })
    else if (pcr <= 0.95) factors.push({ score: -1, text: 'Selected-window PCR ≤ 0.95' })
  }

  const near = snapshot.strikes.filter((row) => row.near_atm)
  const ceLegs = near.map((row) => row.ce).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const peLegs = near.map((row) => row.pe).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const ceDelta = ceLegs.map((leg) => leg.change_oi)
  const peDelta = peLegs.map((leg) => leg.change_oi)
  if (ceDelta.length && peDelta.length && [...ceDelta, ...peDelta].every((value) => value != null)) {
    const putAdded = peDelta.reduce<number>((sum, value) => sum + Math.max(0, value as number), 0)
    const callAdded = ceDelta.reduce<number>((sum, value) => sum + Math.max(0, value as number), 0)
    if (putAdded !== callAdded) factors.push({ score: putAdded > callAdded ? 1 : -1, text: 'Near-ATM put / call OI additions' })
  }

  let putShort = 0
  let callUnwind = 0
  let callShort = 0
  let putUnwind = 0
  const nearLegs = [...ceLegs, ...peLegs]
  const activityComplete = ceLegs.length > 0 && peLegs.length > 0 && nearLegs.every((leg) => leg.price_change != null && leg.change_oi != null)
  if (activityComplete) {
    for (const row of near) {
      if (row.pe?.activity === 'SHORT_BUILDUP') putShort++
      if (row.ce?.activity === 'LONG_UNWINDING') callUnwind++
      if (row.ce?.activity === 'SHORT_BUILDUP') callShort++
      if (row.pe?.activity === 'LONG_UNWINDING') putUnwind++
    }
    if (putShort + callUnwind !== callShort + putUnwind) {
      factors.push({ score: putShort + callUnwind > callShort + putUnwind ? 1 : -1, text: 'Near-ATM price/OI classifications' })
    }
  }

  const allCe = snapshot.strikes.map((row) => row.ce).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const allPe = snapshot.strikes.map((row) => row.pe).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const volumeComplete = allCe.length > 0 && allPe.length > 0 && [...allCe, ...allPe].every((leg) => leg.volume != null)
  const callVolumes = allCe.map((leg) => leg.volume).filter((value): value is number => value != null)
  const putVolumes = allPe.map((leg) => leg.volume).filter((value): value is number => value != null)
  if (volumeComplete) {
    const calls = callVolumes.reduce((sum, value) => sum + value, 0)
    const puts = putVolumes.reduce((sum, value) => sum + value, 0)
    if (calls !== puts) factors.push({ score: puts > calls ? 1 : -1, text: 'Selected-window put / call traded volume' })
  }

  if (!factors.length) return { direction: null, score: 0, max_score: 0, confidence: null, reasons: [], status: 'insufficient_data' }
  const score = factors.reduce((sum, factor) => sum + factor.score, 0)
  const direction = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL'
  const reasons: SignalReason[] = factors.map(({ score: point, text }) => ({ effect: point > 0 ? 'positive' : 'negative', text }))
  return {
    direction,
    score,
    max_score: factors.length,
    confidence: Math.round((Math.abs(score) / factors.length) * 100),
    reasons,
    status: 'observational_rule_score',
    disclaimer: 'Rule-score alignment, not probability, forecast or financial advice.',
  }
}
