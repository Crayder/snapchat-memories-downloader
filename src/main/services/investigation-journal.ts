import path from 'node:path';
import fs from 'fs-extra';

export interface DownloadObservation {
  index: number;
  method: 'GET' | 'POST';
  url: string;
  status: number;
  contentType: string | null;
  disposition: string | null;
  inferredExt: string;
}

export interface ZipObservation {
  index: number;
  fileCount: number;
  overlayCount: number;
  extensions: Record<string, number>;
}

interface InvestigationReport {
  totals: {
    downloads: number;
    getRequests: number;
    postRequests: number;
    uniqueHosts: number;
  };
  contentTypes: Record<string, number>;
  queryParameters: Record<string, number>;
  downloadStatuses: Array<Omit<DownloadObservation, 'url'>>;
  hosts: Record<string, number>;
  zipPayloads: ZipObservation[];
}

export class InvestigationJournal {
  private downloads: DownloadObservation[] = [];
  private zipPayloads: ZipObservation[] = [];
  private parameterCounts = new Map<string, number>();
  private hostCounts = new Map<string, number>();
  private contentTypes = new Map<string, number>();

  recordDownload(observation: DownloadObservation): void {
    this.downloads.push(observation);
    try {
      const url = new URL(observation.url);
      this.hostCounts.set(url.host, (this.hostCounts.get(url.host) ?? 0) + 1);
      url.searchParams.forEach((_value, key) => {
        this.parameterCounts.set(key, (this.parameterCounts.get(key) ?? 0) + 1);
      });
    } catch {
      // ignore parsing failures for malformed URLs
    }
    if (observation.contentType) {
      const normalized = observation.contentType.toLowerCase();
      this.contentTypes.set(normalized, (this.contentTypes.get(normalized) ?? 0) + 1);
    }
  }

  recordZipPayload(observation: ZipObservation): void {
    this.zipPayloads.push(observation);
  }

  async writeReport(reportDir: string): Promise<string> {
    await fs.ensureDir(reportDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportDir, `investigation-${timestamp}.json`);
    const getRequests = this.downloads.filter((d) => d.method === 'GET').length;
    const postRequests = this.downloads.length - getRequests;
    const data: InvestigationReport = {
      totals: {
        downloads: this.downloads.length,
        getRequests,
        postRequests,
        uniqueHosts: this.hostCounts.size
      },
      contentTypes: Object.fromEntries(this.contentTypes.entries()),
      queryParameters: Object.fromEntries(this.parameterCounts.entries()),
      hosts: Object.fromEntries(this.hostCounts.entries()),
      downloadStatuses: this.downloads.map((observation) => {
        const { url, ...rest } = observation;
        void url;
        return rest;
      }),
      zipPayloads: this.zipPayloads
    };
    await fs.writeJson(reportPath, data, { spaces: 2 });
    return reportPath;
  }
}
