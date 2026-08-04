/** Global power display unit (W family vs dBm). Data is ALWAYS carried in
 * watts end-to-end (stream, sweeps, HDF5); conversion happens at display
 * time only. */

export type PowerUnit = 'w' | 'dbm';

export const POWER_UNIT_STORAGE_KEY = 'coredaq.power_unit.v1';

/** Display floor for non-positive powers (below any real detector floor). */
export const DBM_DISPLAY_FLOOR = -120;

export function wattsToDbm(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return DBM_DISPLAY_FLOOR;
  const dbm = 10 * Math.log10(w * 1e3);
  return dbm < DBM_DISPLAY_FLOOR ? DBM_DISPLAY_FLOOR : dbm;
}

/** Convert [x, y_watts] pairs in place to [x, y_dBm]. */
export function pointsToDbm(pts: [number, number][]): [number, number][] {
  for (let i = 0; i < pts.length; i += 1) pts[i][1] = wattsToDbm(pts[i][1]);
  return pts;
}

export function loadPowerUnit(): PowerUnit {
  try {
    const v = window.localStorage.getItem(POWER_UNIT_STORAGE_KEY);
    return v === 'dbm' ? 'dbm' : 'w';
  } catch {
    return 'w';
  }
}

export function savePowerUnit(u: PowerUnit): void {
  try {
    window.localStorage.setItem(POWER_UNIT_STORAGE_KEY, u);
  } catch {
    // storage unavailable — preference just won't persist
  }
}
