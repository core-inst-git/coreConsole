import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export type LiveSeries = {
  name: string;
  color: string;
  data: number[];
};

type Props = {
  x: number[];
  series: LiveSeries[];
  unit?: string;
  compact?: boolean;
};

function formatAxisValue(val: number): string {
  const a = Math.abs(val);
  if (a >= 1000) return val.toFixed(0);
  if (a >= 100) return val.toFixed(0);
  if (a >= 10) return val.toFixed(1);
  return val.toFixed(2);
}

function formatTimeSeconds(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-- s';
  return `${n.toFixed(1)} s`;
}

function formatMeasurement(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(0);
  if (a >= 100) return n.toFixed(1);
  if (a >= 10) return n.toFixed(2);
  if (a >= 1) return n.toFixed(2);
  if (a >= 0.1) return n.toFixed(3);
  return n.toFixed(3);
}

export default function LiveChart({ x, series, unit = 'W', compact = false }: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.EChartsType | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    const inst = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    instRef.current = inst;

    const option: echarts.EChartsOption = {
      backgroundColor: 'transparent',
      animation: false,
      grid: {
        left: compact ? 54 : 60,
        right: 18,
        top: 18,
        bottom: 30,
        containLabel: true
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(10,14,18,0.9)',
        borderColor: '#2a3540',
        textStyle: { color: '#e7eef6', fontFamily: 'JetBrains Mono' },
        formatter: (params: any) => {
          const rows = Array.isArray(params) ? params : [params];
          if (rows.length === 0) return '';
          const header = formatTimeSeconds(rows[0]?.axisValue ?? rows[0]?.axisValueLabel);
          const body = rows.map((row: any) => {
            const raw = Array.isArray(row?.value) ? row.value[row.value.length - 1] : row?.value;
            const y = formatMeasurement(raw);
            return `${row?.marker ?? ''} ${row?.seriesName ?? ''} ${y} ${unit}`;
          });
          return [header, ...body].join('<br/>');
        }
      },
      xAxis: {
        type: 'category',
        data: x,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#2a3540' } },
        axisTick: { show: false },
        axisLabel: compact
          ? { color: '#9fb0c2', formatter: (v: string) => `${Number(v).toFixed(1)}s`, fontSize: 10, margin: 8 }
          : { color: '#9fb0c2', formatter: (v: string) => `${Number(v).toFixed(1)}s`, margin: 8 },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { lineStyle: { color: '#2a3540' } },
        axisTick: { show: false },
        axisLabel: compact
          ? { color: '#9fb0c2', formatter: (v: number) => `${formatAxisValue(v)} ${unit}`, fontSize: 10, margin: 8 }
          : { color: '#9fb0c2', formatter: (v: number) => `${formatAxisValue(v)} ${unit}`, margin: 8 },
        splitLine: { lineStyle: { color: '#1b232c' } }
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color: s.color },
        emphasis: { focus: 'series' }
      }))
    };

    inst.setOption(option);

    const handleResize = () => inst.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      inst.dispose();
    };
  }, []);

  useEffect(() => {
    if (!instRef.current) return;
    instRef.current.setOption({
      tooltip: {
        formatter: (params: any) => {
          const rows = Array.isArray(params) ? params : [params];
          if (rows.length === 0) return '';
          const header = formatTimeSeconds(rows[0]?.axisValue ?? rows[0]?.axisValueLabel);
          const body = rows.map((row: any) => {
            const raw = Array.isArray(row?.value) ? row.value[row.value.length - 1] : row?.value;
            const y = formatMeasurement(raw);
            return `${row?.marker ?? ''} ${row?.seriesName ?? ''} ${y} ${unit}`;
          });
          return [header, ...body].join('<br/>');
        }
      },
      yAxis: {
        axisLabel: {
          formatter: (v: number) => `${formatAxisValue(v)} ${unit}`
        }
      },
      xAxis: { data: x },
      series: series.map((s) => ({ data: s.data }))
    });
  }, [x, series, unit]);

  return <div className="chart" ref={chartRef} />;
}
