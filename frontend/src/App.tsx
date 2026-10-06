import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock3,
  Database,
  LockKeyhole,
  Radio,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { api, ApiError, marketWebSocketUrl } from './api'
import { evaluateSignal } from './analytics'
import { FlowCharts } from './components/FlowCharts'
import { MarketChart } from './components/MarketChart'
import { MarketStructure } from './components/MarketStructure'
import { OiAnalysis } from './components/OiAnalysis'
import { OptionChain } from './components/OptionChain'
import { RiskCalculator } from './components/RiskCalculator'
import { SignalPanel } from './components/SignalPanel'
import { applyMarketTick, refreshFreshness } from './stream'
import type { ChainSnapshot, ExpiryOption, HistoricalCandle, MarketTick, SystemStatus, Underlying } from './types'
import './styles.css'

const PRICE = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? 'N/A' : value.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: digits })
const signed = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? 'N/A' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
const currentTime = () => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())
const currentDate = () => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())

type StreamState = 'connected' | 'connecting' | 'disconnected'

export default function App() {
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY')
  const [expiries, setExpiries] = useState<ExpiryOption[]>([])
  const [expiry, setExpiry] = useState('')
  const [expiryReload, setExpiryReload] = useState(0)
  const [strikeRange, setStrikeRange] = useState(10)
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null)
  const [chainError, setChainError] = useState<string | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [streamState, setStreamState] = useState<StreamState>('disconnected')
  const [historical, setHistorical] = useState<HistoricalCandle[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [time, setTime] = useState(currentTime())
  const [loginLoading, setLoginLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [liveTickCount, setLiveTickCount] = useState(0)
  const phaseRef = useRef(system?.market_phase || 'MARKET_CLOSED')
  const loginBusy = useRef(false)

  useEffect(() => { phaseRef.current = system?.market_phase || 'MARKET_CLOSED' }, [system?.market_phase])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authResult = params.get('kite')
    if (authResult === 'connected') setToast('Kite authenticated. Select an expiry to start the live chain.')
    if (authResult === 'failed') setToast('Kite authentication failed. Check the Kite app callback URL and try again.')
    if (authResult) window.history.replaceState({}, document.title, window.location.pathname)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setTime(currentTime()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const readStatus = async () => {
      try {
        const status = await api.systemStatus(controller.signal)
        if (!active) return
        setSystem(status)
        setBackendError(null)
        setSnapshot((current) => current ? refreshFreshness(current, status.market_phase) : current)
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        setBackendError(error instanceof Error ? error.message : 'Backend is unavailable.')
      }
    }
    void readStatus()
    const timer = window.setInterval(() => { if (!controller.signal.aborted) void readStatus() }, 15000)
    return () => { active = false; controller.abort(); window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!system?.kite_configured || system.kite !== 'authenticated') {
      setExpiries([])
      setExpiry('')
      setSnapshot(null)
      setChainLoading(false)
      setChainError(null)
      return
    }
    const controller = new AbortController()
    setExpiries([])
    setSnapshot(null)
    setExpiry('')
    setChainError(null)
    setChainLoading(true)
    api.expiries(underlying, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return
        setExpiries(list)
        setExpiry((current) => list.some((item) => item.value === current) ? current : (list[0]?.value || ''))
        if (!list.length) setChainError(`No current ${underlying} expiries were returned by Kite.`)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setChainError(error instanceof Error ? error.message : 'Could not load listed expiries.')
      })
      .finally(() => { if (!controller.signal.aborted) setChainLoading(false) })
    return () => controller.abort()
  }, [underlying, system?.kite, system?.kite_configured, expiryReload])

  useEffect(() => {
    if (!system || system.kite !== 'authenticated' || !expiry) {
      setStreamState('disconnected')
      return
    }
    let active = true
    let socket: WebSocket | null = null
    let ping: number | undefined
    setSnapshot(null)
    setHistorical([])
    setHistoryError(null)
    setChainError(null)
    setChainLoading(true)
    setStreamState('connecting')
    setLiveTickCount(0)
    try {
      socket = new WebSocket(marketWebSocketUrl(underlying, expiry, strikeRange))
      socket.onopen = () => {
        if (!active) return
        setStreamState('connected')
        ping = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send('ping'), 20000)
      }
      socket.onmessage = (event) => {
        if (!active) return
        let message: any
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type === 'snapshot' && message.data) {
          setSnapshot(message.data as ChainSnapshot)
          setChainLoading(false)
          setChainError(null)
        } else if (message.type === 'tick' && message.data) {
          const tick = message.data as MarketTick
          setSnapshot((current) => current ? applyMarketTick(current, tick, phaseRef.current) : current)
          setSystem((current) => current ? {
            ...current,
            last_tick_at: tick.timestamp,
            data_age_seconds: 0,
            data_stale: false,
            websocket: 'connected',
          } : current)
          setLiveTickCount((count) => count + 1)
        } else if (message.type === 'heartbeat') {
          setSystem((current) => current ? {
            ...current,
            websocket: message.websocket || current.websocket,
            market_phase: message.market_phase || current.market_phase,
            last_tick_at: message.last_tick_at || current.last_tick_at,
            data_age_seconds: message.data_age_seconds ?? current.data_age_seconds,
            data_stale: message.data_age_seconds != null ? message.data_age_seconds > current.stale_after_seconds : current.data_stale,
          } : current)
          setSnapshot((current) => current ? refreshFreshness(current, message.market_phase || phaseRef.current) : current)
        } else if (message.type === 'error') {
          setChainError(message.error || 'Kite live market data is unavailable.')
          setChainLoading(false)
          setStreamState('disconnected')
        }
      }
      socket.onerror = () => {
        if (active) setStreamState('disconnected')
      }
      socket.onclose = () => {
        if (active) {
          setStreamState('disconnected')
          setChainLoading(false)
        }
      }
    } catch (error) {
      setChainError(error instanceof Error ? error.message : 'Could not open the market WebSocket.')
      setChainLoading(false)
      setStreamState('disconnected')
    }
    return () => {
      active = false
      if (ping) window.clearInterval(ping)
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
    }
  }, [underlying, expiry, strikeRange, system?.kite, system?.kite_configured])

  useEffect(() => {
    if (!snapshot) return
    const timer = window.setInterval(() => {
      setSnapshot((current) => current ? refreshFreshness(current, phaseRef.current) : current)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [Boolean(snapshot)])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const signal = useMemo(() => evaluateSignal(snapshot, system?.market_phase || 'MARKET_CLOSED'), [snapshot, system?.market_phase])
  const authenticated = system?.kite === 'authenticated'
  const dataStale = snapshot?.data_status === 'stale' || Boolean(system?.data_stale)
  const lastObservation = snapshot?.spot.exchange_timestamp || snapshot?.spot.timestamp || system?.last_tick_at
  const clockStatus = system?.market_phase || 'MARKET_CLOSED'

  const handleLogin = useCallback(async () => {
    if (loginBusy.current) return
    loginBusy.current = true
    setLoginLoading(true)
    try {
      const { url } = await api.loginUrl()
      window.location.assign(url)
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : 'Could not start Kite authentication.')
      loginBusy.current = false
      setLoginLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    if (!snapshot || historyLoading) return
    const controller = new AbortController()
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const result = await api.history(snapshot.instrument_token, controller.signal)
      setHistorical(result.candles || [])
      if (!result.candles?.length) setHistoryError('Kite returned no candles for the current date and instrument.')
    } catch (error) {
      setHistorical([])
      setHistoryError(error instanceof Error ? error.message : 'Could not load Kite historical candles.')
    } finally {
      setHistoryLoading(false)
    }
  }, [snapshot, historyLoading])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark"><Activity size={21} strokeWidth={2.2} /></div>
          <div className="brand-copy"><h1>Option <span>Intelligence</span></h1><p>LIVE ANALYTICS · KITE CONNECT</p></div>
        </div>
        <div className="header-middle">
          <div className="header-market-state">
            <span className={`market-dot market-${clockStatus.toLowerCase()}`} />
            <span>{clockStatus.replace('_', ' ')}</span>
          </div>
          <span className="header-separator" />
          <div className="header-clock"><Clock3 size={13} /><b>{time}</b><span>IST</span></div>
        </div>
        <div className="header-right">
          <div className={`connection-pill ${authenticated ? 'connection-good' : 'connection-off'}`}>
            {authenticated ? <CheckCircle2 size={13} /> : <WifiOff size={13} />}
            <span>{authenticated ? 'KITE AUTHENTICATED' : 'KITE DISCONNECTED'}</span>
          </div>
          {authenticated ? (
            <div className={`connection-pill ${system?.websocket === 'connected' ? 'connection-good' : 'connection-warn'}`}>
              <Radio size={13} /><span>{system?.websocket === 'connected' ? 'TICKER LIVE' : system?.websocket === 'reconnecting' ? 'RECONNECTING' : 'TICKER WAITING'}</span>
            </div>
          ) : <button className="button button-primary header-connect" onClick={handleLogin} disabled={!system?.kite_configured || loginLoading}>
            {loginLoading ? <span className="spinner" /> : <LockKeyhole size={14} />}{system?.kite_configured ? 'Connect Kite' : 'Setup required'}
          </button>}
        </div>
      </header>

      <main className="dashboard-main">
        <div className="page-topline">
          <div><div className="eyebrow">MARKET DESK <span>/</span> OPTIONS RESEARCH</div><h2>Live market overview</h2></div>
          <div className="page-topline-right"><span className="ist-date">{currentDate()} · IST</span><span className="data-source-label"><i /> {snapshot ? 'SOURCE · KITE CONNECT' : 'NO LIVE DATA'}</span></div>
        </div>

        {backendError ? (
          <section className="setup-banner banner-danger">
            <div className="banner-icon"><Server size={18} /></div>
            <div className="banner-copy"><strong>Backend API is unavailable</strong><span>{backendError} Start the FastAPI service; market values remain empty until it responds.</span></div>
            <span className="banner-code">API · OFFLINE</span>
          </section>
        ) : null}

        {system && !system.kite_configured ? (
          <section className="setup-banner">
            <div className="banner-icon"><LockKeyhole size={18} /></div>
            <div className="banner-copy"><strong>Configure Kite Connect on the backend</strong><span>Add <code>KITE_API_KEY</code>, <code>KITE_API_SECRET</code> and (after OAuth) <code>KITE_ACCESS_TOKEN</code> to the backend <code>.env</code>. Credentials never reach this browser.</span></div>
            <a className="banner-link" href="https://kite.trade/docs/connect/v3/user/" target="_blank" rel="noreferrer"><BookOpen size={14} /> Kite setup</a>
          </section>
        ) : system && !authenticated ? (
          <section className="setup-banner">
            <div className="banner-icon"><LockKeyhole size={18} /></div>
            <div className="banner-copy"><strong>Kite session required</strong><span>Authorize the configured Kite Connect app. Kite access tokens typically expire daily; reconnect when the session ends.</span></div>
            <button className="button button-primary" onClick={handleLogin} disabled={loginLoading}>{loginLoading ? <span className="spinner" /> : <LockKeyhole size={14} />}{loginLoading ? 'Opening Kite…' : 'Authenticate'}</button>
          </section>
        ) : null}

        <section className="control-bar">
          <div className="underlying-control" aria-label="Select underlying">
            {(['NIFTY', 'BANKNIFTY'] as Underlying[]).map((item) => (
              <button key={item} className={underlying === item ? 'underlying-tab active' : 'underlying-tab'} onClick={() => setUnderlying(item)}>{item}</button>
            ))}
          </div>
          <div className="control-separator" />
          <label className="select-control"><span>EXPIRY</span><select value={expiry} onChange={(event) => setExpiry(event.target.value)} disabled={!authenticated || !expiries.length}>
            {!expiries.length ? <option value="">{authenticated ? 'No listed expiries' : 'Connect Kite first'}</option> : null}
            {expiries.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>
          <label className="select-control range-control"><span>STRIKES</span><select value={strikeRange} onChange={(event) => setStrikeRange(Number(event.target.value))} disabled={!authenticated}>
            {[5, 10, 15, 20].map((value) => <option value={value} key={value}>±{value}</option>)}
          </select></label>
          <div className="control-spacer" />
          <div className={`stream-state ${streamState}`}><span className="stream-state-dot" />{streamState === 'connected' ? 'WEBSOCKET CONNECTED' : streamState === 'connecting' ? 'CONNECTING TO MARKET STREAM' : 'MARKET STREAM OFFLINE'}</div>
        </section>

        <section className="metric-grid" aria-label="Selected market metrics">
          <MetricCard label={`${underlying} SPOT`} value={PRICE(snapshot?.spot.spot)} icon={<Activity size={15} />} accent="teal" detail={snapshot?.spot.tradingsymbol || 'Awaiting Kite quote'} />
          <MetricCard label="DAY CHANGE" value={signed(snapshot?.spot.change_percent)} icon={snapshot?.spot.change_percent != null && snapshot.spot.change_percent < 0 ? <ArrowDownRight size={15} /> : <ArrowUpRight size={15} />} accent={snapshot?.spot.change_percent != null && snapshot.spot.change_percent < 0 ? 'red' : 'green'} detail={snapshot?.spot.change == null ? 'Previous close · N/A' : `₹${PRICE(snapshot.spot.change)} vs previous close`} />
          <MetricCard label="ATM STRIKE" value={snapshot ? PRICE(snapshot.atm, 0) : 'N/A'} icon={<CrosshairIcon />} accent="blue" detail={expiry ? `Expiry · ${expiry}` : 'Expiry · N/A'} />
          <MetricCard label="PCR · SELECTED WINDOW" value={snapshot?.oi_analysis.pcr == null ? 'N/A' : snapshot.oi_analysis.pcr.toFixed(2)} icon={<BarChart3 size={15} />} accent="violet" detail="Put OI ÷ call OI" />
          <MetricCard label="ATM IMPLIED VOL" value={snapshot?.atm_iv == null ? 'N/A' : `${(snapshot.atm_iv * 100).toFixed(2)}%`} icon={<Activity size={15} />} accent="amber" detail={snapshot?.atm_iv_method || 'N/A · requires usable prices'} />
          <MetricCard label="EXPECTED MOVE · 1σ" value={snapshot?.expected_move == null ? 'N/A' : `±${PRICE(snapshot.expected_move)}`} icon={<BarChart3 size={15} />} accent="cyan" detail={snapshot?.expected_move == null ? 'N/A · formula inputs unavailable' : `${PRICE(snapshot.expected_lower)} – ${PRICE(snapshot.expected_upper)}`} title={snapshot?.expected_move_formula || 'N/A'} />
        </section>

        {chainError && authenticated && !snapshot ? <div className="chain-error"><WifiOff size={15} />{chainError}<button className="text-button" onClick={() => setExpiryReload((value) => value + 1)}><RefreshCw size={12} /> Retry listed expiries</button></div> : null}

        <section className="market-strip">
          <div className="market-strip-title"><span>SESSION SNAPSHOT</span><b>{snapshot?.underlying_label || underlying}</b></div>
          <div className="market-strip-items">
            <StripValue label="PREVIOUS CLOSE" value={PRICE(snapshot?.spot.previous_close)} />
            <StripValue label="OPEN" value={PRICE(snapshot?.spot.open)} />
            <StripValue label="DAY HIGH" value={PRICE(snapshot?.spot.day_high)} />
            <StripValue label="DAY LOW" value={PRICE(snapshot?.spot.day_low)} />
            <StripValue label="INDIA VIX" value={snapshot?.vix?.last_price == null ? 'N/A' : PRICE(snapshot.vix.last_price)} />
            <StripValue label="LAST OBSERVATION" value={lastObservation ? new Date(lastObservation).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'N/A'} />
            <StripValue label="DATA AGE" value={snapshot?.spot.data_age_seconds == null ? 'N/A' : `${snapshot.spot.data_age_seconds.toFixed(1)}s`} warning={dataStale} />
          </div>
        </section>

        <OptionChain
          rows={snapshot?.strikes || []}
          atm={snapshot?.atm ?? null}
          range={strikeRange}
          timestamp={snapshot?.timestamp || null}
          connected={streamState === 'connected' && system?.websocket === 'connected'}
          stale={dataStale}
          loading={chainLoading}
          error={chainError}
        />

        <div className="analysis-grid">
          <OiAnalysis snapshot={snapshot} />
          <MarketStructure snapshot={snapshot} />
          <SignalPanel signal={signal} marketPhase={system?.market_phase || 'MARKET_CLOSED'} />
        </div>

        <div className="charts-grid">
          <MarketChart
            candles={historical}
            symbol={snapshot?.spot.tradingsymbol || underlying}
            loading={historyLoading}
            error={historyError}
            onLoad={loadHistory}
          />
          <FlowCharts snapshot={snapshot} />
        </div>

        <div className="risk-section"><div className="section-divider"><span>POSITION PLANNING</span><i /></div><RiskCalculator /></div>

        <section className="safety-footer">
          <div className="safety-footer-icon"><ShieldIcon /></div>
          <div><strong>Analytics and research only</strong><span>Signals are deterministic observations—not financial advice or guaranteed predictions. No orders are placed by this application. Live quotes and historical candles are kept as distinct data sources.</span></div>
          <div className="data-health">
            <HealthItem icon={<Database size={13} />} label="POSTGRES" value={system?.database_reachable ? 'ONLINE' : 'N/A'} good={system?.database_reachable || false} />
            <HealthItem icon={system?.redis === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />} label="REDIS" value={system?.redis?.toUpperCase() || 'N/A'} good={system?.redis === 'connected'} />
            <HealthItem icon={<Activity size={13} />} label="TICKS THIS VIEW" value={liveTickCount ? liveTickCount.toLocaleString('en-IN') : 'N/A'} good={liveTickCount > 0} />
          </div>
        </section>
      </main>
      <footer className="app-footer"><span>OPTION INTELLIGENCE DASHBOARD</span><span>IST · {time}</span><span>V1 · NO ORDER EXECUTION</span></footer>
      {toast ? <div className="toast-message"><CheckCircle2 size={15} />{toast}<button onClick={() => setToast(null)} aria-label="Dismiss">×</button></div> : null}
    </div>
  )
}

function MetricCard({ label, value, detail, icon, accent, title }: { label: string; value: string; detail: string; icon: ReactNode; accent: string; title?: string }) {
  return <div className={`metric-card metric-${accent}`} title={title}>
    <div className="metric-top"><span>{label}</span><i>{icon}</i></div>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>
}
function StripValue({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return <div className="strip-value"><span>{label}</span><b className={warning ? 'text-warning' : ''}>{value}</b></div>
}
function HealthItem({ icon, label, value, good }: { icon: ReactNode; label: string; value: string; good: boolean }) {
  return <div className="health-item"><span>{icon}{label}</span><b className={good ? 'health-good' : ''}>{value}</b></div>
}
function CrosshairIcon() { return <span className="crosshair-icon">⌖</span> }
function ShieldIcon() { return <span className="shield-icon">i</span> }
