export type VirtualMathType = 'db' | 'diff' | 'sum';

export type VirtualChannelDef = {
  id: string;
  name: string;
  color: string;
  mathType: VirtualMathType;
  srcA: string; // physical source id: "<device_id>:ch<1..4>"
  srcB: string; // physical source id: "<device_id>:ch<1..4>"
};

export function physicalSourceId(deviceId: string, channelIndex: number): string {
  const idx = Math.max(0, Math.min(3, Math.round(channelIndex)));
  return `${deviceId}:ch${idx + 1}`;
}

export function parsePhysicalSourceId(src: string): { deviceId: string; channelIndex: number } | null {
  const m = String(src || '').match(/^(.*):ch([1-4])$/i);
  if (!m) return null;
  return { deviceId: m[1], channelIndex: Number(m[2]) - 1 };
}

