import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

type Point = [number, number];

export type ZoomWindow = { x0: number; x1: number } | null;

type Props = {
  points: Point[];
  color: string;
  unit: string;
  /** Bump to reset the zoom to full extent (e.g. when a new sweep loads). */
  resetKey?: number;
  /** echarts connect-group id: all charts in the group zoom/pan together. */
  group?: string;
  /**
   * Fired (debounced) when the visible x-window changes. `null` means the
   * view is back at (or nearly at) the full extent.
   */
  onZoomWindow?: (win: ZoomWindow) => void;
};

function formatY(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e3) return v.toFixed(0);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 1e-3) return v.toExponential(2);
  return v.toExponential(1);
}

const ZOOM_DEBOUNCE_MS = 180;

export default function CaptureMiniChart({ points, color, unit, group, onZoomWindow, resetKey }: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.EChartsType | null>(null);
  const pointsRef = useRef<Point[]>(points);
  const zoomCbRef = useRef<Props['onZoomWindow']>(onZoomWindow);
  const debounceRef = useRef<number | null>(null);
  const unitRef = useRef(unit);
  pointsRef.current = points;
  zoomCbRef.current = onZoomWindow;
  unitRef.current = unit;

  useEffect(() => {
    if (!chartRef.current) return;
    const inst = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    instRef.current = inst;
    // Stable handle for E2E tests (drive zoom/read state via CDP).
    (chartRef.current as any).__echarts = inst;
    if (group) {
      inst.group = group;
      echarts.connect(group);
    }
    inst.setOption({
      animation: false,
      grid: { left: 56, right: 16, top: 14, bottom: 50, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(11,14,19,0.92)',
        borderColor: '#1C2230',
        textStyle: { color: '#E8ECF2', fontFamily: 'ui-monospace, SF Mono, Menlo, monospace' },
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseWheel: true,
          moveOnMouseMove: true,
          throttle: 50,
        },
        {
          type: 'slider',
          xAxisIndex: 0,
          bottom: 6,
          height: 14,
          brushSelect: false,
          showDataShadow: false,
          borderColor: '#1C2230',
          backgroundColor: 'rgba(16,20,28,0.55)',
          fillerColor: 'rgba(95,224,238,0.16)',
          handleSize: 10,
          textStyle: { color: '#8B94A3', fontSize: 10 },
        },
      ],
      xAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: '#1C2230' } },
        axisTick: { show: false },
        axisLabel: { color: '#8B94A3', formatter: (v: number) => `${v.toFixed(1)}nm`, fontSize: 10, margin: 8 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { lineStyle: { color: '#1C2230' } },
        axisTick: { show: false },
        axisLabel: { color: '#8B94A3', formatter: (v: number) => `${formatY(v)} ${unitRef.current}`, fontSize: 10, margin: 8 },
        splitLine: { lineStyle: { color: '#1A202C' } },
      },
      series: [],
    });

    // Report the visible x-window after zoom/pan settles. Percentages are
    // resolved against the CURRENT data extent so this stays correct when the
    // series data is swapped for a higher-resolution window.
    const onDataZoom = () => {
      if (!zoomCbRef.current) return;
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        const cb = zoomCbRef.current;
        const chart = instRef.current;
        if (!cb || !chart) return;
        const pts = pointsRef.current;
        if (!pts || pts.length < 2) return;
        const opt = chart.getOption() as any;
        const dz = Array.isArray(opt?.dataZoom) ? opt.dataZoom[0] : null;
        if (!dz) return;
        const xMin = pts[0][0];
        const xMax = pts[pts.length - 1][0];
        const span = xMax - xMin;
        let x0 = typeof dz.startValue === 'number' ? dz.startValue : xMin + (Number(dz.start) / 100) * span;
        let x1 = typeof dz.endValue === 'number' ? dz.endValue : xMin + (Number(dz.end) / 100) * span;
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return;
        if (x1 < x0) [x0, x1] = [x1, x0];
        const nearFull = x0 <= xMin + span * 0.002 && x1 >= xMax - span * 0.002;
        cb(nearFull ? null : { x0, x1 });
      }, ZOOM_DEBOUNCE_MS);
    };
    inst.on('dataZoom', onDataZoom);

    const onResize = () => inst.resize();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      inst.off('dataZoom', onDataZoom);
      inst.dispose();
      instRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!instRef.current || resetKey === undefined) return;
    instRef.current.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (!instRef.current) return;
    instRef.current.setOption({
      series: [
        {
          type: 'line',
          data: points,
          showSymbol: false,
          smooth: false,
          sampling: 'lttb',
          large: true,
          largeThreshold: 20_000,
          progressive: 10_000,
          progressiveThreshold: 30_000,
          animation: false,
          lineStyle: { width: 2, color },
          emphasis: { focus: 'series' },
        },
      ],
    });
  }, [points, color]);

  return <div className="chart" ref={chartRef} />;
}
