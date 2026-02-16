import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

type Point = [number, number];

type Props = {
  points: Point[];
  color: string;
  unit: string;
};

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
