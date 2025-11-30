import { app } from 'electron';
import path from 'node:path';
import fs from 'fs-extra';

const APP_DIR = path.join(app.getPath('appData'), 'SnapMemoriesBackup');
const WORK_DIR = path.join(APP_DIR, 'work');
const LOG_DIR = path.join(APP_DIR, 'logs');
const REPORT_DIR = path.join(APP_DIR, 'reports');

export const ensureAppDirectories = async (): Promise<void> => {
  await fs.ensureDir(APP_DIR);
  await fs.ensureDir(WORK_DIR);
  await fs.ensureDir(LOG_DIR);
  await fs.ensureDir(REPORT_DIR);
};

export const getAppPaths = () => ({
  appDir: APP_DIR,
  workDir: WORK_DIR,
  logDir: LOG_DIR,
  reportDir: REPORT_DIR
});

export const resolveWorkPath = (...segments: string[]): string => path.join(WORK_DIR, ...segments);
export const resolveReportPath = (...segments: string[]): string => path.join(REPORT_DIR, ...segments);
