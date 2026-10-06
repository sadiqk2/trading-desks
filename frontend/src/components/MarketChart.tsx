import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { HistoricalCandle } from '../types'

interface Props {
  candles: HistoricalCandle[]
  symbol: string
  loading: boolean
  error: string | null
  onLoad: () => void
}

export function MarketChart({ candles, symbol, loading, error, onLoad }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ReturnType<IChartApi['addSeries']> | null>(null)
  const volumeSeriesRef = useRef<ReturnType<IChartApi['addSeries']> | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const chart = createChart(hostRef.current, {
      width: hostRef.current.clientWidth,
      height: 284,
      layout: {
        background: { type: ColorType.Solid, color: '#0c131d' },
        textColor: '#8290a2',
        fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.055)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.075)' },
      },
      rightPriceScale: { borderColor: 'rgba(148, 163, 184, 0.12)' },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.12)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      crosshair: { vertLine: { color: 'rgba(89, 210, 179, 0.25)' }, horzLine: { color: 'rgba(89, 210, 179, 0.25)' } },
    })
    const candlesSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#40c9a1',
      downColor: '#ef7180',
      borderUpColor: '#40c9a1',
      borderDownColor: '#ef7180',
      wickUpColor: '#40c9a1',
      wickDownColor: '#ef7180',
      priceLineVisible: false,
    })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    chartRef.current = chart
    candleSeriesRef.current = candlesSeries
    volumeSeriesRef.current = volumeSeries

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) chart.applyOptions({ width })
    })
    observer.observe(hostRef.current)
    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const candleSeries = candleSeriesRef.current as any
    const volumeSeries = volumeSeriesRef.current as any
    if (!candleSeries || !volumeSeries) return
    const candleRows = candles
      .filter((candle) => candle.timestamp && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
      .map((candle) => ({
        time: Math.floor(new Date(candle.timestamp).getTime() / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((a, b) => Number(a.time) - Number(b.time))
    candleSeries.setData(candleRows)
    volumeSeries.setData(candles
      .filter((candle) => candle.timestamp && Number.isFinite(candle.volume))
      .map((candle) => ({
        time: Math.floor(new Date(candle.timestamp).getTime() / 1000) as UTCTimestamp,
        value: candle.volume as number,
        color: candle.close >= candle.open ? 'rgba(64, 201, 161, 0.34)' : 'rgba(239, 113, 128, 0.34)',
      }))
      .sort((a, b) => Number(a.time) - Number(b.time)))
    if (candleRows.length) chartRef.current?.timeScale().fitContent()
  }, [candles])

  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div className="panel-title-wrap">
          <span className="section-icon"><i className="icon-square" /></span>
          <div><h2>Underlying history</h2><p>Genuine Kite candles · separate from live ticks</p></div>
        </div>
        <div className="chart-actions">
          <span className="subtle-tag">{symbol || '—'} · 1m</span>
          <button className="button button-quiet button-small" onClick={onLoad} disabled={loading}>
            {loading ? <span className="spinner" /> : null}{loading ? 'Loading' : 'Load today'}
          </button>
        </div>
      </div>
      <div className="chart-surface">
        <div className="chart-legend"><span><i className="legend-candle" /> OHLC</span><span><i className="legend-volume" /> Volume where returned</span></div>
        <div ref={hostRef} className="market-chart-canvas" />
        {!candles.length && (
          <div className="chart-empty">
            <div className="chart-empty-mark">⌁</div>
            <strong>{error ? 'Historical feed unavailable' : loading ? 'Requesting Kite history' : 'No historical candles loaded'}</strong>
            <span>{error || (loading ? 'Waiting for Kite Connect to return real candles.' : 'Load one-minute candles from Kite. No history is synthesized.')}</span>
          </div>
        )}
      </div>
      <div className="panel-footnote"><span>Source: Kite historical API</span><span>Candles and volume remain N/A when not returned.</span></div>
    </section>
  )
}
