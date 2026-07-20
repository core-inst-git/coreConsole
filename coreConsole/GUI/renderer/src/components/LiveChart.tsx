import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export type LiveSeries = {
  name: string;
  color: string;
  points: [number, number][];
};

type Props = {
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

export default function LiveChart({ series, unit = 'W', compact = false }: Props) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.EChartsType | null>(null);
  const unitRef = useRef(unit);
  unitRef.current = unit;

  useEffect(() => {
    if (!chartRef.current) return;
    const inst = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    instRef.current = inst;
    // Stable handle for E2E tests (drive zoom/read state via CDP).
    (chartRef.current as any).__echarts = inst;

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
        backgroundColor: 'rgba(11,14,19,0.92)',
        borderColor: '#1C2230',
        textStyle: { color: '#E8ECF2', fontFamily: 'ui-monospace, SF Mono, Menlo, monospace' },
        formatter: (params: any) => {
          const rows = Array.isArray(params) ? params : [params];
          if (rows.length === 0) return '';
          const first = Array.isArray(rows[0]?.value) ? rows[0].value[0] : rows[0]?.axisValue;
          const header = formatTimeSeconds(first);
          const body = rows.map((row: any) => {
            const raw = Array.isArray(row?.value) ? row.value[1] : row?.value;
            const y = formatMeasurement(raw);
            return `${row?.marker ?? ''} ${row?.seriesName ?? ''} ${y} ${unitRef.current}`;
          });
          return [header, ...body].join('<br/>');
        }
      },
      xAxis: {
        // Value axis: points carry their own x. (A category axis forced one
        // string label per sample — thousands of categories per repaint.)
        type: 'value',
        min: 'dataMin',
        max: 'dataMax',
        axisLine: { lineStyle: { color: '#1C2230' } },
        axisTick: { show: false },
        axisLabel: compact
          ? { color: '#8B94A3', formatter: (v: number) => `${v.toFixed(1)}s`, fontSize: 10, margin: 8 }
          : { color: '#8B94A3', formatter: (v: number) => `${v.toFixed(1)}s`, margin: 8 },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { lineStyle: { color: '#1C2230' } },
        axisTick: { show: false },
        axisLabel: compact
          ? { color: '#8B94A3', formatter: (v: number) => `${formatAxisValue(v)} ${unitRef.current}`, fontSize: 10, margin: 8 }
          : { color: '#8B94A3', formatter: (v: number) => `${formatAxisValue(v)} ${unitRef.current}`, margin: 8 },
        splitLine: { lineStyle: { color: '#1A202C' } }
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        data: s.points,
        showSymbol: false,
        smooth: false,
        animation: false,
        lineStyle: { width: 2, color: s.color },
        emphasis: { focus: 'series' }
      }))
    };

    inst.setOption(option);

    const handleResize = () => inst.resize();
    window.addEventListener('resize', handleResize);
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartRef.current);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', handleResize);
      inst.dispose();
      instRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!instRef.current) return;
    instRef.current.setOption(
      {
        series: series.map((s) => ({
          name: s.name,
          data: s.points,
          lineStyle: { width: 2, color: s.color }
        }))
      },
      { lazyUpdate: true }
    );
  }, [series]);

  return <div className="chart" ref={chartRef} />;
}
