import { DateTime } from 'luxon';

export const toIsoUtc = (raw: string): string => {
  if (!raw) {
    return DateTime.utc().toISO();
  }
  const normalized = raw.replace(' UTC', 'Z').replace(' ', 'T');
  const parsed = DateTime.fromISO(normalized, { zone: 'utc' });
  return parsed.isValid ? parsed.toUTC().toISO()! : DateTime.utc().toISO();
};

export const toExifTimestamp = (iso: string): string => {
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  if (!dt.isValid) {
    return DateTime.utc().toFormat('yyyy:MM:dd HH:mm:ss');
  }
  return dt.toUTC().toFormat('yyyy:MM:dd HH:mm:ss');
};

export const toFilenameStamp = (iso: string): string => {
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  return dt.isValid ? dt.toUTC().toFormat('yyyy-LL-dd_HH-mm-ssZ') : DateTime.utc().toFormat('yyyy-LL-dd_HH-mm-ssZ');
};
