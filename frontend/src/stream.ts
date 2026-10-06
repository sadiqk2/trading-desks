import type { ChainSnapshot, MarketTick, OptionLeg, OptionRow, OIAnalysis, OIWall } from './types'

function observedAge(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 1000) : null
}

function percentile(values: number[], pct: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const rank = Math.max(0, Math.min(100, pct)) / 100 * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.min(low + 1, sorted.length - 1)
  const weight = rank - low
  return sorted[low] * (1 - weight) + sorted[high] * weight
}

function topStrike(rows: OptionRow[], side: 'ce' | 'pe', key: 'oi' | 'change_oi'): number | null {
  const values = rows.map((row) => ({ strike: row.strike, value: row[side]?.[key] ?? null })).filter((row): row is { strike: number; value: number } => row.value != null)
  return values.length ? values.reduce((best, item) => item.value > best.value ? item : best).strike : null
}

function buildOI(rows: OptionRow[], wallPercentile: number): OIAnalysis {
  const sum = (side: 'ce' | 'pe', field: 'oi' | 'change_oi') => {
    const legs = rows.map((row) => row[side]).filter((leg): leg is NonNullable<typeof leg> => leg != null)
    if (!legs.length || legs.some((leg) => leg[field] == null)) return null
    return legs.reduce((total, leg) => total + (leg[field] as number), 0)
  }
  const ceLegs = rows.map((row) => row.ce).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const peLegs = rows.map((row) => row.pe).filter((leg): leg is NonNullable<typeof leg> => leg != null)
  const ceOiObserved = ceLegs.filter((leg) => leg.oi != null).length
  const peOiObserved = peLegs.filter((leg) => leg.oi != null).length
  const ceChangeObserved = ceLegs.filter((leg) => leg.change_oi != null).length
  const peChangeObserved = peLegs.filter((leg) => leg.change_oi != null).length
  const ceOi = rows.map((row) => ({ strike: row.strike, oi: row.ce?.oi ?? null })).filter((item): item is {strike: number; oi: number} => item.oi != null)
  const peOi = rows.map((row) => ({ strike: row.strike, oi: row.pe?.oi ?? null })).filter((item): item is {strike: number; oi: number} => item.oi != null)
  const makeWalls = (values: Array<{ strike: number; oi: number }>): OIWall[] => {
    const threshold = percentile(values.map((item) => item.oi), wallPercentile)
    return threshold == null ? [] : values.filter((item) => item.oi >= threshold).sort((a, b) => b.oi - a.oi).slice(0, 5)
  }
  const ceTotal = sum('ce', 'oi')
  const peTotal = sum('pe', 'oi')
  const ceTop = [...ceOi].sort((a, b) => b.oi - a.oi).slice(0, 3).reduce((total, item) => total + item.oi, 0)
  const peTop = [...peOi].sort((a, b) => b.oi - a.oi).slice(0, 3).reduce((total, item) => total + item.oi, 0)
  return {
    total_ce_oi: ceTotal,
    total_pe_oi: peTotal,
    total_ce_change_oi: sum('ce', 'change_oi'),
    total_pe_change_oi: sum('pe', 'change_oi'),
    ce_oi_coverage: { observed: ceOiObserved, contracts: ceLegs.length },
    pe_oi_coverage: { observed: peOiObserved, contracts: peLegs.length },
    ce_change_oi_coverage: { observed: ceChangeObserved, contracts: ceLegs.length },
    pe_change_oi_coverage: { observed: peChangeObserved, contracts: peLegs.length },
    pcr: ceTotal != null && ceTotal !== 0 && peTotal != null ? peTotal / ceTotal : null,
    highest_ce_oi_strike: topStrike(rows, 'ce', 'oi'),
    highest_pe_oi_strike: topStrike(rows, 'pe', 'oi'),
    highest_ce_change_oi_strike: topStrike(rows, 'ce', 'change_oi'),
    highest_pe_change_oi_strike: topStrike(rows, 'pe', 'change_oi'),
    ce_concentration_top_3: ceTotal ? ceTop / ceTotal : null,
    pe_concentration_top_3: peTotal ? peTop / peTotal : null,
    oi_wall_percentile: wallPercentile,
    ce_oi_walls: makeWalls(ceOi),
    pe_oi_walls: makeWalls(peOi),
    scope: 'selected strikes only',
  }
}

function applyLeg(leg: OptionLeg | null, tick: MarketTick): OptionLeg | null {
  if (!leg) return null
  const close = tick.ohlc?.close ?? leg.previous_close
  const last = tick.last_price ?? leg.last_price
  const priceChange = last != null && close != null && close !== 0 ? last - close : null
  return {
    ...leg,
    timestamp: tick.timestamp,
    exchange_timestamp: tick.exchange_timestamp,
    last_price: tick.last_price,
    previous_close: close,
    price_change: priceChange,
    price_change_percent: priceChange != null && close ? priceChange / close * 100 : null,
    volume: tick.volume,
    oi: tick.oi,
    previous_oi: tick.previous_oi,
    change_oi: tick.change_oi,
    change_oi_percent: tick.change_oi_percent,
    bid: tick.bid,
    ask: tick.ask,
    bid_quantity: tick.bid_quantity,
    ask_quantity: tick.ask_quantity,
    buy_quantity: tick.buy_quantity,
    sell_quantity: tick.sell_quantity,
    ohlc: tick.ohlc,
    iv: tick.iv ?? null,
    iv_method: tick.iv_method ?? null,
    delta: tick.delta ?? null,
    gamma: tick.gamma ?? null,
    theta: tick.theta ?? null,
    vega: tick.vega ?? null,
    greeks_method: tick.greeks_method ?? null,
    activity: classifyActivity(priceChange, tick.change_oi),
    source: tick.source,
    data_age_seconds: observedAge(tick.exchange_timestamp || tick.timestamp),
  }
}

function classifyActivity(priceChange: number | null, oiChange: number | null): string {
  if (priceChange == null || oiChange == null || priceChange === 0 || oiChange === 0) return 'NEUTRAL'
  if (priceChange > 0 && oiChange > 0) return 'LONG_BUILDUP'
  if (priceChange < 0 && oiChange > 0) return 'SHORT_BUILDUP'
  if (priceChange > 0 && oiChange < 0) return 'SHORT_COVERING'
  return 'LONG_UNWINDING'
}

export function refreshFreshness(snapshot: ChainSnapshot, marketPhase: string): ChainSnapshot {
  const spotAge = observedAge(snapshot.spot.exchange_timestamp || snapshot.spot.timestamp)
  const spot = { ...snapshot.spot, data_age_seconds: spotAge, stale: spotAge != null && spotAge > snapshot.stale_after_seconds }
  const vix = snapshot.vix ? { ...snapshot.vix, data_age_seconds: observedAge(snapshot.vix.exchange_timestamp || snapshot.vix.timestamp) } : null
  const rows = snapshot.strikes.map((row) => ({
    ...row,
    ce: row.ce ? { ...row.ce, data_age_seconds: observedAge(row.ce.exchange_timestamp || row.ce.timestamp) } : null,
    pe: row.pe ? { ...row.pe, data_age_seconds: observedAge(row.pe.exchange_timestamp || row.pe.timestamp) } : null,
  }))
  const ages = [spotAge, ...rows.flatMap((row) => [row.ce?.data_age_seconds, row.pe?.data_age_seconds])].filter((age): age is number => age != null)
  const stale = ages.some((age) => age > snapshot.stale_after_seconds)
  return {
    ...snapshot,
    spot,
    vix,
    strikes: rows,
    data_status: stale ? 'stale' : marketPhase === 'LIVE' ? 'live' : 'market_closed',
  }
}

export function applyMarketTick(snapshot: ChainSnapshot, tick: MarketTick, marketPhase: string): ChainSnapshot {
  let next = snapshot
  if (snapshot.vix?.instrument_token === tick.instrument_token) {
    const close = tick.ohlc?.close ?? snapshot.vix.previous_close
    const last = tick.last_price ?? snapshot.vix.last_price
    const change = last != null && close != null ? last - close : null
    next = {
      ...next,
      vix: {
        ...snapshot.vix,
        last_price: tick.last_price,
        previous_close: close,
        change,
        change_percent: change != null && close ? change / close * 100 : null,
        timestamp: tick.timestamp,
        exchange_timestamp: tick.exchange_timestamp,
        data_age_seconds: observedAge(tick.exchange_timestamp || tick.timestamp),
      },
    }
  }
  if (tick.instrument_token === snapshot.spot.instrument_token) {
    const close = tick.ohlc?.close ?? snapshot.spot.previous_close
    const spot = tick.last_price ?? snapshot.spot.spot
    const change = spot != null && close != null ? spot - close : null
    const age = observedAge(tick.exchange_timestamp || tick.timestamp)
    next = {
      ...next,
      spot: {
        ...snapshot.spot,
        spot,
        previous_close: close,
        open: tick.ohlc?.open ?? snapshot.spot.open,
        day_high: tick.ohlc?.high ?? snapshot.spot.day_high,
        day_low: tick.ohlc?.low ?? snapshot.spot.day_low,
        change,
        change_percent: change != null && close ? change / close * 100 : null,
        timestamp: tick.timestamp,
        exchange_timestamp: tick.exchange_timestamp,
        data_age_seconds: age,
        stale: age != null && age > snapshot.stale_after_seconds,
      },
    }
  }
  const updatedRows = snapshot.strikes.map((row) => {
    const ce = row.ce?.instrument_token === tick.instrument_token ? applyLeg(row.ce, tick) : row.ce
    const pe = row.pe?.instrument_token === tick.instrument_token ? applyLeg(row.pe, tick) : row.pe
    return ce === row.ce && pe === row.pe ? row : { ...row, ce, pe }
  })
  if (updatedRows.some((row, index) => row !== snapshot.strikes[index])) next = { ...next, strikes: updatedRows }

  const atmRow = next.strikes.find((row) => row.is_atm)
  const atmIvs = [atmRow?.ce?.iv, atmRow?.pe?.iv].filter((value): value is number => value != null && Number.isFinite(value))
  const atmIv = atmIvs.length ? atmIvs.reduce((sum, value) => sum + value, 0) / atmIvs.length : null
  const expectedMove = next.spot.spot != null && atmIv != null && next.time_to_expiry_years != null
    ? next.spot.spot * atmIv * Math.sqrt(next.time_to_expiry_years)
    : null
  const spotAge = next.spot.data_age_seconds ?? observedAge(next.spot.exchange_timestamp || next.spot.timestamp)
  const legAges = updatedRows.flatMap((row) => [row.ce?.data_age_seconds, row.pe?.data_age_seconds]).filter((age): age is number => age != null)
  const allAges = [spotAge, ...legAges].filter((age): age is number => age != null)
  const stale = allAges.some((age) => age > next.stale_after_seconds)
  const dataStatus = stale ? 'stale' : marketPhase === 'LIVE' ? 'live' : 'market_closed'
  const oiAnalysis = buildOI(updatedRows, next.oi_analysis.oi_wall_percentile)
  return {
    ...next,
    strikes: updatedRows,
    oi_analysis: oiAnalysis,
    atm_iv: atmIv,
    atm_iv_method: atmIv == null ? null : 'mean of available ATM CE / PE Black-Scholes IV',
    expected_move: expectedMove,
    expected_upper: expectedMove != null && next.spot.spot != null ? next.spot.spot + expectedMove : null,
    expected_lower: expectedMove != null && next.spot.spot != null ? next.spot.spot - expectedMove : null,
    data_status: dataStatus,
    timestamp: tick.timestamp,
  }
}
