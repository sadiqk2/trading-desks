export type Underlying = 'NIFTY' | 'BANKNIFTY'
export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null

export interface SystemStatus {
  application: string
  kite: 'authenticated' | 'disconnected'
  kite_configured: boolean
  websocket: 'connected' | 'reconnecting' | 'disconnected'
  database: 'configured' | 'not_configured'
  database_reachable: boolean
  redis: 'connected' | 'unavailable'
  market_phase: 'PRE_MARKET' | 'LIVE' | 'MARKET_CLOSED'
  market_phase_note: string
  last_tick_at: string | null
  data_age_seconds: number | null
  data_stale: boolean
  stale_after_seconds: number
  last_error: string | null
  server_time: string
}

export interface ExpiryOption {
  value: string
  label: string
}

export interface Ohlc {
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

export interface MarketQuote {
  spot: number | null
  previous_close: number | null
  open: number | null
  day_high: number | null
  day_low: number | null
  change: number | null
  change_percent: number | null
  timestamp: string | null
  exchange_timestamp?: string | null
  instrument_token: number
  tradingsymbol: string
  source: string
  data_age_seconds?: number | null
  stale?: boolean
}

export interface OptionLeg {
  instrument_token: number
  tradingsymbol: string
  lot_size: number | null
  timestamp: string | null
  exchange_timestamp?: string | null
  last_price: number | null
  previous_close: number | null
  price_change: number | null
  price_change_percent: number | null
  volume: number | null
  oi: number | null
  previous_oi: number | null
  change_oi: number | null
  change_oi_percent: number | null
  bid: number | null
  ask: number | null
  bid_quantity: number | null
  ask_quantity: number | null
  buy_quantity: number | null
  sell_quantity: number | null
  ohlc: Ohlc | null
  iv: number | null
  iv_method: string | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
  greeks_method: string | null
  activity: string
  source: string | null
  data_age_seconds: number | null
}

export interface OptionRow {
  strike: number
  is_atm: boolean
  near_atm: boolean
  ce: OptionLeg | null
  pe: OptionLeg | null
}

export interface OIWall {
  strike: number
  oi: number
}

export interface OIAnalysis {
  total_ce_oi: number | null
  total_pe_oi: number | null
  total_ce_change_oi: number | null
  total_pe_change_oi: number | null
  ce_oi_coverage: { observed: number; contracts: number }
  pe_oi_coverage: { observed: number; contracts: number }
  ce_change_oi_coverage: { observed: number; contracts: number }
  pe_change_oi_coverage: { observed: number; contracts: number }
  pcr: number | null
  highest_ce_oi_strike: number | null
  highest_pe_oi_strike: number | null
  highest_ce_change_oi_strike: number | null
  highest_pe_change_oi_strike: number | null
  ce_concentration_top_3: number | null
  pe_concentration_top_3: number | null
  oi_wall_percentile: number
  ce_oi_walls: OIWall[]
  pe_oi_walls: OIWall[]
  scope: string
}

export interface SignalReason {
  effect: 'positive' | 'negative'
  text: string
}

export interface Signal {
  direction: Direction
  score: number | null
  max_score: number | null
  confidence: number | null
  reasons: SignalReason[]
  status: string
  disclaimer?: string
}

export interface VixQuote {
  instrument_token: number
  last_price: number | null
  previous_close: number | null
  change: number | null
  change_percent: number | null
  timestamp: string | null
  exchange_timestamp: string | null
  data_age_seconds: number | null
  source: string
}

export interface ChainSnapshot {
  underlying: Underlying
  underlying_label: string
  expiry: string
  strike_range: number
  spot: MarketQuote
  vix: VixQuote | null
  atm: number
  atm_iv: number | null
  atm_iv_method: string | null
  expected_move: number | null
  expected_move_formula: string | null
  expected_upper: number | null
  expected_lower: number | null
  time_to_expiry_years: number | null
  risk_free_rate: number
  oi_analysis: OIAnalysis
  strikes: OptionRow[]
  instrument_token: number
  timestamp: string
  source: string
  data_status: 'live' | 'stale' | 'market_closed'
  stale_after_seconds: number
  oi_baseline_note: string
  greeks_note: string
  signal?: Signal
}

export interface MarketTick {
  timestamp: string
  exchange_timestamp: string | null
  source: string
  instrument_token: number
  tradingsymbol: string | null
  exchange: string | null
  last_price: number | null
  volume: number | null
  oi: number | null
  previous_oi: number | null
  change_oi: number | null
  change_oi_percent: number | null
  buy_quantity: number | null
  sell_quantity: number | null
  bid: number | null
  ask: number | null
  bid_quantity: number | null
  ask_quantity: number | null
  ohlc: Ohlc
  depth?: { buy?: Array<{price: number | null; quantity: number | null}>; sell?: Array<{price: number | null; quantity: number | null}> } | null
  average_price?: number | null
  last_trade_time?: string | null
  iv?: number | null
  iv_method?: string | null
  delta?: number | null
  gamma?: number | null
  theta?: number | null
  vega?: number | null
  greeks_method?: string | null
}

export interface HistoricalCandle {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  oi: number | null
}

export interface RiskResult {
  max_risk: number | null
  risk_per_lot: number | null
  position_size: number | null
  required_capital: number | null
  potential_profit: number | null
  actual_stop_risk?: number | null
  risk_reward: number | null
  max_lots_by_risk: number | null
}
