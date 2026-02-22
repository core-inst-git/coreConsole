import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

type Point = [number, number];

type Props = {
  points: Point[];
  color: string;
  unit: string;
};

function computeAxisRange(vals: number[]): { min: number | null; max: number | null } {
  if (!vals || vals.length === 0) return { min: null, max: null };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: null, max: null };
  if (min === max) {
    const pad = Math.abs(min) * 0.02 + 1e-12;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.02;
  return { min: min - pad, max: max + pad };
}

function formatY(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e3) return v.toFixed(0);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 1e-3) return v.toExponential(2);
  return v.toExponential(1);
}

export default function CaptureMiniChart({ points, color, unit }: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.EChartsType | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    const inst = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    instRef.current = inst;
    inst.setOption({
      animation: false,
      grid: { left: 56, right: 16, top: 14, bottom: 50, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(10,14,18,0.9)',
        borderColor: '#2a3540',
        textStyle: { color: '#e7eef6', fontFamily: 'JetBrains Mono' },
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
          borderColor: '#2a3540',
          backgroundColor: 'rgba(12,18,27,0.55)',
          fillerColor: 'rgba(77,208,225,0.18)',
          handleSize: 10,
          textStyle: { color: '#8fa0b2', fontSize: 10 },
        },
      ],
      xAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: '#2a3540' } },
        axisTick: { show: false },
        axisLabel: { color: '#9fb0c2', formatter: (v: number) => `${v.toFixed(1)}nm`, fontSize: 10, margin: 8 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { lineStyle: { color: '#2a3540' } },
        axisTick: { show: false },
        axisLabel: { color: '#9fb0c2', formatter: (v: number) => `${formatY(v)} ${unit}`, fontSize: 10, margin: 8 },
        splitLine: { lineStyle: { color: '#1b232c' } },
      },
      series: [],
    });

    const onResize = () => inst.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      inst.dispose();
    };
  }, []);

  useEffect(() => {
    if (!instRef.current) return;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const xr = computeAxisRange(xs);
    const yr = computeAxisRange(ys);

    instRef.current.setOption({
      xAxis: { min: xr.min ?? undefined, max: xr.max ?? undefined },
      yAxis: { min: yr.min ?? undefined, max: yr.max ?? undefined },
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


