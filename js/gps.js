// Vehicle speed from the phone's location (optional): the speed the phone reports, or else the
// distance between fixes over the time between them. Pure functions; run under Node.

const EARTH_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance in metres.
export function haversine(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const POOR_FIX_M = 50; // fixes less accurate than this are skipped
const MAX_SPAN_SEC = 5; // without movement for this long, the speed is 0
export const STALE_SEC = 10; // no usable fix for this long: speed unknown

// One fix { lat, lon, accuracy (m), speed (m/s or null), t (ms) } -> { state, kmh }.
// state is null to begin with; kmh is null while unknown. Standing still with a wandering position
// reads 0: the distance has to beat the fixes' accuracy before it counts as movement.
export function trackSpeed(state, fix) {
  const s = state || { anchor: null, kmh: null };
  if (!(fix.accuracy <= POOR_FIX_M)) return { state: s, kmh: s.kmh };
  if (Number.isFinite(fix.speed) && fix.speed >= 0) {
    const next = { anchor: fix, kmh: fix.speed * 3.6 };
    return { state: next, kmh: next.kmh };
  }
  const a = s.anchor;
  if (!a) return { state: { anchor: fix, kmh: s.kmh }, kmh: s.kmh };
  const dt = (fix.t - a.t) / 1000;
  if (dt > STALE_SEC) return { state: { anchor: fix, kmh: null }, kmh: null };
  if (dt < 1) return { state: s, kmh: s.kmh };
  const d = haversine(a.lat, a.lon, fix.lat, fix.lon);
  const noise = Math.max(5, (a.accuracy + fix.accuracy) / 2);
  if (d >= noise) {
    const kmh = (d / dt) * 3.6;
    return { state: { anchor: fix, kmh }, kmh };
  }
  if (dt >= MAX_SPAN_SEC) return { state: { anchor: fix, kmh: 0 }, kmh: 0 };
  return { state: s, kmh: s.kmh };
}
