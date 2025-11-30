import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import path from 'node:path';
import { MemoryEntry, MemoryMediaType } from '../../shared/types/memory-entry.js';
import { toIsoUtc } from '../utils/date.js';
import { parseGps } from '../utils/gps.js';

const DOWNLOAD_RE = /downloadMemories\('([^']+)'\s*,\s*this\s*,\s*(true|false)\)/i;
type RawMemory = Record<string, unknown>;

export class IndexParser {
  async parse(filePath: string): Promise<MemoryEntry[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      return this.parseJson(filePath);
    }
    return this.parseHtml(filePath);
  }

  private async parseJson(filePath: string): Promise<MemoryEntry[]> {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const entries = this.normalizeJsonList(data);
    return entries.map((entry, index) => this.normalizeEntry(entry, index));
  }

  private normalizeJsonList(data: unknown): RawMemory[] {
    if (Array.isArray(data)) {
      return data;
    }
    if (typeof data === 'object' && data) {
      const candidate = (data as Record<string, unknown>).Memories ?? (data as Record<string, unknown>).memories;
      if (Array.isArray(candidate)) {
        return candidate as RawMemory[];
      }
    }
    throw new Error('Unable to identify memories list inside JSON export.');
  }

  private normalizeEntry(raw: RawMemory, index: number): MemoryEntry {
    const dateValue = String(raw.Date ?? raw.date ?? raw['Capture Date'] ?? '');
    const mediaTypeValue = String(raw['Media Type'] ?? raw.type ?? 'unknown').toLowerCase();
    const locationValue = String(raw.Location ?? raw.location ?? '');
    const downloadValue = String(raw['Download Link'] ?? raw.url ?? raw.downloadUrl ?? '');

    const normalizedType: MemoryMediaType = mediaTypeValue.includes('video')
      ? 'video'
      : mediaTypeValue.includes('image')
        ? 'image'
        : 'unknown';

    if (!downloadValue) {
      throw new Error(`Memory entry ${index} is missing a download URL.`);
    }

    const gps = parseGps(locationValue);
    const iso = toIsoUtc(dateValue);

    return {
      index,
      capturedAtUtc: iso,
      capturedAtRaw: dateValue,
      mediaType: normalizedType,
      hasGps: gps.hasGps,
      latitude: gps.latitude,
      longitude: gps.longitude,
      locationRaw: locationValue,
      downloadUrl: downloadValue,
      downloadMethodHint: undefined,
      downloadStatus: 'pending'
    };
  }

  private async parseHtml(filePath: string): Promise<MemoryEntry[]> {
    const html = await fs.readFile(filePath, 'utf8');
    const $ = cheerio.load(html);
    const tables = $('table');
    if (!tables.length) {
      throw new Error('No table found in memories_history.html');
    }

    let targetTable: cheerio.Cheerio<Element> | undefined;
    tables.each((_idx: number, table: Element) => {
      const headers = $(table).find('th');
      const hasDate = headers.toArray().some((th) => $(th).text().toLowerCase().includes('date'));
      const hasMedia = headers.toArray().some((th) => $(th).text().toLowerCase().includes('media'));
      if (hasDate && hasMedia) {
        targetTable = $(table);
        return false;
      }
      return undefined;
    });

    if (!targetTable) {
      throw new Error('Unable to find memories table in HTML export.');
    }

    const rows = targetTable.find('tr');
    const entries: MemoryEntry[] = [];
    rows.each((_rowIdx: number, row: Element) => {
      const cells = $(row).find('td');
      if (cells.length < 3) {
        return;
      }
      const dateValue = $(cells[0]).text().trim();
      const mediaTypeValue = $(cells[1]).text().trim().toLowerCase();
      const locationValue = $(cells[2]).text().trim();
      const linkCell = cells[3];
      const anchor = $(linkCell).find('a');
      if (!anchor.length) {
        return;
      }
      const onclick = anchor.attr('onclick') ?? '';
      const match = onclick.match(DOWNLOAD_RE);
      if (!match) {
        return;
      }
      const url = match[1];
      const booleanValue = match[2] === 'true';
      const gps = parseGps(locationValue);
      const iso = toIsoUtc(dateValue);
      const normalizedType: MemoryMediaType = mediaTypeValue.includes('video')
        ? 'video'
        : mediaTypeValue.includes('image')
          ? 'image'
          : 'unknown';

      entries.push({
        index: entries.length,
        capturedAtUtc: iso,
        capturedAtRaw: dateValue,
        mediaType: normalizedType,
        hasGps: gps.hasGps,
        latitude: gps.latitude,
        longitude: gps.longitude,
        locationRaw: locationValue,
        downloadUrl: url,
        downloadMethodHint: booleanValue ? 'GET' : 'POST',
        downloadStatus: 'pending'
      });
    });

    if (!entries.length) {
      throw new Error('No memory rows were parsed from HTML.');
    }

    return entries;
  }
}
