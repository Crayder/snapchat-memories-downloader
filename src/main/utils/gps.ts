const GPS_RE = /Latitude,\s*Longitude:\s*([+-]?\d+(?:\.\d+)?),\s*([+-]?\d+(?:\.\d+)?)/i;

export const parseGps = (value?: string): { hasGps: boolean; latitude?: number; longitude?: number } => {
  if (!value) {
    return { hasGps: false };
  }
  const match = value.match(GPS_RE);
  if (!match) {
    return { hasGps: false };
  }
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return { hasGps: false };
  }
  if (latitude === 0 && longitude === 0) {
    return { hasGps: false };
  }
  return { hasGps: true, latitude, longitude };
};
