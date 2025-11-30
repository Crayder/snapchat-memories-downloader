import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { PipelineRunRequest, PipelineRunSummary } from '../../shared/types/memory-entry.js';
import type { PipelineProgressEvent } from '../../shared/ipc.js';
import type { PipelineStatsPayload } from '../../shared/types/pipeline-stats.js';

const DEFAULT_OPTIONS: PipelineRunRequest['options'] = {
  concurrency: 4,
  retryLimit: 3,
  throttleDelayMs: 0,
  attemptTimeoutMs: 15000,
  cleanupDownloads: false,
  keepZipPayloads: false,
  dedupeStrategy: 'move',
  dryRun: false,
  verifyOnly: false
};

const STEPS = [
  {
    title: 'Welcome',
    description: 'Confirm you have the right export, understand the guarantees, and review the safety warnings.'
  },
  {
    title: 'Select Export',
    description: 'Point the app at the Snapchat My Data ZIP that still contains the untouched memories HTML/JSON.'
  },
  {
    title: 'Choose Output',
    description: 'Pick an empty destination folder where the finalized archive and reports will be written.'
  },
  {
    title: 'Options',
    description: 'Tune concurrency, retries, dedupe behavior, and advanced toggles before running.'
  },
  {
    title: 'Run',
    description: 'Monitor downloads, pause/resume safely, and capture diagnostics while processing.'
  },
  {
    title: 'Finish',
    description: 'Review the summary, open reports, and export diagnostics for support if needed.'
  }
];

const cascadeSummaryCounts = (data: PipelineRunSummary) => {
  const deduped = data.deduped ?? 0;
  const metadataWritten = Math.max(data.metadataWritten ?? 0, deduped);
  const processed = Math.max(data.processed ?? 0, metadataWritten);
  const downloaded = Math.max(data.downloaded ?? 0, processed);
  return { ...data, downloaded, processed, metadataWritten };
};

type LogEntry = {
  timestamp: string;
  message: string;
};

const App = () => {
  const [step, setStep] = useState(0);
  const [exportZip, setExportZip] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [options, setOptions] = useState<PipelineRunRequest['options']>(DEFAULT_OPTIONS);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<PipelineRunSummary | null>(null);
  const [phase, setPhase] = useState<string>('idle');
  const [lastMessage, setLastMessage] = useState<string>('');
  const [stats, setStats] = useState<PipelineStatsPayload | null>(null);
  const [diagnosticsPath, setDiagnosticsPath] = useState<string | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [reportCopyMessage, setReportCopyMessage] = useState<string>('');
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushLog = useCallback((message: string) => {
    setLogs((current) => [{ timestamp: new Date().toLocaleTimeString(), message }, ...current].slice(0, 200));
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI.onProgress((event: PipelineProgressEvent) => {
      if (event.type === 'stats' && event.stats) {
        setStats(event.stats);
        return;
      }
      if (event.type === 'phase') {
        setPhase(event.phase ?? 'working');
        setLastMessage('');
        if (event.phase === 'complete') {
          setPaused(false);
        }
      }
      if (event.type === 'entry-status' && event.message) {
        pushLog(`#${event.entryIndex ?? '-'} ${event.message}`);
        setLastMessage(event.message);
      }
      if (event.type === 'log' && event.message) {
        pushLog(event.message);
      }
      if (event.type === 'error') {
        pushLog(`Error: ${event.message ?? 'Unknown error'}`);
      }
      if (event.type === 'summary' && event.summary) {
        setSummary(event.summary);
        setStep(5);
        setRunning(false);
        setPaused(false);
      }
    });
    return () => dispose();
  }, [pushLog]);

  useEffect(() => () => {
    if (copyResetRef.current) {
      clearTimeout(copyResetRef.current);
    }
  }, []);

  const canRun = useMemo(() => exportZip && outputDir && !running, [exportZip, outputDir, running]);

  const handleChooseZip = async () => {
    const result = await window.electronAPI.selectFile([{ name: 'ZIP Files', extensions: ['zip'] }]);
    if (!result.canceled && result.filePaths.length) {
      setExportZip(result.filePaths[0]);
      if (step === 0) {
        setStep(1);
      }
    }
  };

  const handleChooseOutput = async () => {
    const result = await window.electronAPI.selectDirectory();
    if (!result.canceled && result.filePaths.length) {
      setOutputDir(result.filePaths[0]);
      if (step < 2) {
        setStep(2);
      }
    }
  };

  const handleToggle = (key: 'keepZipPayloads' | 'dryRun' | 'verifyOnly' | 'cleanupDownloads') => (event: ChangeEvent<HTMLInputElement>) => {
    setOptions((prev) => ({ ...prev, [key]: event.target.checked }));
  };

  const handleSelect = (key: 'dedupeStrategy') => (event: ChangeEvent<HTMLSelectElement>) => {
    setOptions((prev) => ({ ...prev, [key]: event.target.value as typeof prev.dedupeStrategy }));
  };

  const handleNumberChange = (
    key: 'concurrency' | 'retryLimit' | 'throttleDelayMs' | 'attemptTimeoutMs',
    multiplier = 1
  ) => (event: ChangeEvent<HTMLInputElement>) => {
    const raw = Number(event.target.value);
    if (Number.isNaN(raw)) return;
    const value = Math.max(0, raw * multiplier);
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const runPipeline = async () => {
    if (!canRun) return;
    setRunning(true);
    setPaused(false);
    setLogs([]);
    setSummary(null);
    setStats(null);
    setDiagnosticsPath(null);
    setPhase('initializing');
    setStep(4);
    const payload: PipelineRunRequest = {
      exportZipPath: exportZip,
      outputDir,
      options
    };
    try {
      const result = await window.electronAPI.runPipeline(payload);
      setSummary(result);
      setStep(5);
    } catch (error) {
      pushLog(`Run failed: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const handlePause = async () => {
    if (!running || paused) return;
    const result = await window.electronAPI.pausePipeline();
    setPaused(result.paused);
  };

  const handleResume = async () => {
    if (!running || !paused) return;
    const result = await window.electronAPI.resumePipeline();
    setPaused(result.paused);
  };

  const handleDiagnostics = async () => {
    try {
      setDiagnosticsBusy(true);
      const result = await window.electronAPI.exportDiagnostics();
      setDiagnosticsPath(result.path);
      pushLog(`Diagnostics bundle created: ${result.path}`);
    } catch (error) {
      pushLog(`Diagnostics export failed: ${(error as Error).message}`);
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const handleCopyReportPath = async () => {
    if (!summary?.reportPath) return;
    try {
      await navigator.clipboard.writeText(summary.reportPath);
      setReportCopyMessage('Copied report path to clipboard');
    } catch (error) {
      setReportCopyMessage('Copy failed. See logs for detail.');
      pushLog(`Copy failed: ${(error as Error).message}`);
    } finally {
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = setTimeout(() => setReportCopyMessage(''), 2500);
    }
  };

  const handleRetryFailures = () => {
    setRunning(false);
    setPaused(false);
    setPhase('idle');
    setLastMessage('Ready to retry failed memories.');
    pushLog('Returned to Run step to retry failures. Start the run again to resume.');
    setStep(4);
  };

  const handleRestartWizard = () => {
    setExportZip('');
    setOutputDir('');
    setOptions({ ...DEFAULT_OPTIONS });
    setLogs([]);
    setSummary(null);
    setStats(null);
    setDiagnosticsPath(null);
    setRunning(false);
    setPaused(false);
    setPhase('idle');
    setLastMessage('Wizard reset. Select your export to begin.');
    pushLog('Wizard reset to step 0.');
    setStep(0);
  };

  const handleExitApp = () => {
    window.close();
  };

  const handleOpenOutputFolder = async () => {
    try {
      const result = await window.electronAPI.openOutputFolder();
      pushLog(`Opened output folder: ${result.path}`);
    } catch (error) {
      pushLog(`Unable to open output folder: ${(error as Error).message}`);
    }
  };

  const canAdvanceFrom = (current: number): boolean => {
    if (current === 0) return true;
    if (current === 1) return Boolean(exportZip);
    if (current === 2) return Boolean(outputDir);
    if (current === 3) return true;
    return false;
  };

  const goNext = () => {
    if (!canAdvanceFrom(step)) return;
    setStep((prev) => Math.min(prev + 1, 4));
  };

  const goBack = () => {
    setStep((prev) => Math.max(prev - 1, 0));
  };

  const renderStats = () => {
    const entries = [
      { label: 'Total Memories', value: stats?.total ?? '--' },
      { label: 'Images', value: stats?.images ?? '--' },
      { label: 'Videos', value: stats?.videos ?? '--' },
      { label: 'With GPS', value: stats?.withGps ?? '--' },
      { label: 'Downloads', value: stats?.downloaded ?? 0 },
      { label: 'Processed', value: stats?.processed ?? 0 },
      { label: 'Metadata', value: stats?.metadataWritten ?? 0 },
      { label: 'Deduped', value: stats?.deduped ?? 0 },
      { label: 'Failures', value: stats?.failures ?? 0 },
      { label: 'Reattempts', value: stats?.reattempts ?? 0 }
    ];

    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <div key={entry.label} className="stat-card">
            <p className="text-xs uppercase tracking-wide text-slate-400">{entry.label}</p>
            <p className="text-2xl font-semibold text-white">{entry.value}</p>
          </div>
        ))}
      </div>
    );
  };

  const renderStepper = () => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {STEPS.map((info, index) => {
        const isActive = index === step;
        const isComplete = index < step;
        const stateClasses = isActive
          ? 'border-brand-400 bg-brand-500/10 text-white'
          : isComplete
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
            : 'border-white/10 bg-white/5 text-slate-300';
        return (
          <div key={info.title} className={`rounded-2xl border p-4 transition ${stateClasses}`}>
            <div className="flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-full border font-semibold ${isActive || isComplete ? 'border-white/50 bg-white/90 text-slate-900' : 'border-white/20 bg-slate-900/40 text-white/80'}`}>
                {index + 1}
              </div>
              <p className="text-sm font-semibold">{info.title}</p>
            </div>
            <p className="mt-2 text-xs text-slate-300">{info.description}</p>
          </div>
        );
      })}
    </div>
  );

  const renderWelcome = () => (
    <section className="glass-card space-y-6">
      <div className="space-y-3">
        <h2 className="text-2xl font-semibold">Welcome — Know What to Expect</h2>
        <p className="text-sm text-slate-300">
          Everything runs locally. The wizard guides you through selecting the export ZIP, choosing an output folder, configuring safeguards, and running the auditable pipeline.
          Complete each bullet before advancing.
        </p>
      </div>
      <ul className="notice-list list-decimal space-y-3 pl-5 text-sm">
        <li>Request a Snapchat export with the <strong>JSON Memories listing enabled</strong>. HTML-only exports work but lack resilience.</li>
        <li>Download the ZIP and keep it untouched; the app copies it into a sandboxed working directory for deterministic processing.</li>
        <li>Run this workflow within 72 hours of receiving the export email—signed download links expire quickly.</li>
        <li>Have enough disk space for both the working set and the finalized archive (roughly 2× your export size).</li>
      </ul>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[ 'Local-only processing', 'Deterministic pipeline', 'Full diagnostics bundle', 'Pause/resume safety' ].map((item) => (
          <div key={item} className="rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-200">
            {item}
          </div>
        ))}
      </div>
    </section>
  );

  const renderSelectExport = () => (
    <section className="glass-card space-y-5">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">1. Select the Snapchat Export ZIP</h2>
        <p className="text-sm text-slate-300">The wizard reads <code className="font-mono">memories_history.json</code> (preferred) or the fallback HTML. Keep the file untouched so parsing stays deterministic.</p>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/30 px-4 py-3 font-mono text-xs text-slate-200">
          <span className="truncate">{exportZip || 'No file selected yet'}</span>
        </div>
        <button
          data-tooltip="Browse to the downloaded Snapchat My Data ZIP."
          className="rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition hover:bg-brand-400 disabled:opacity-50"
          onClick={handleChooseZip}
          disabled={running}
        >
          Choose ZIP
        </button>
      </div>
      <ul className="list-disc space-y-2 pl-5 text-sm text-slate-300">
        <li>Confirm the ZIP still contains <code className="font-mono">memories_history.json</code> or <code className="font-mono">memories_history.html</code>.</li>
        <li>Prefer the version that includes JSON so we can extract metadata without brittle scraping.</li>
        <li>If you have multiple exports, run them sequentially to avoid link expiration.</li>
      </ul>
    </section>
  );

  const renderSelectOutput = () => (
    <section className="glass-card space-y-5">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">2. Choose an Output Folder</h2>
        <p className="text-sm text-slate-300">Pick an empty directory where the cleaned media, duplicates folder, diagnostics, and run reports will be written.</p>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/30 px-4 py-3 font-mono text-xs text-slate-200">
          <span className="truncate">{outputDir || 'No destination selected yet'}</span>
        </div>
        <button
          data-tooltip="Select a destination folder with ample free space."
          className="rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition hover:bg-brand-400 disabled:opacity-50"
          onClick={handleChooseOutput}
          disabled={running}
        >
          Choose Folder
        </button>
      </div>
      <ul className="list-disc space-y-2 pl-5 text-sm text-slate-300">
        <li>The app will create <code className="font-mono">memories</code>, <code className="font-mono">duplicates</code>, and <code className="font-mono">reports</code> inside this folder.</li>
        <li>Avoid network drives; local SSD/HDD storage minimizes corruption risk.</li>
        <li>Keep this folder dedicated to a single run to simplify verification.</li>
      </ul>
    </section>
  );

  const renderOptions = () => (
    <section className="glass-card space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">3. Fine-tune the Pipeline</h2>
        <p className="text-sm text-slate-300">Adjust performance and safety levers. Hover any field to learn what it controls.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-2 text-sm" data-tooltip="Number of simultaneous downloads. Lower values reduce network load.">
          <span className="text-xs uppercase text-slate-400">Concurrency</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none transition focus:border-brand-400"
            type="number"
            min={1}
            max={10}
            value={options.concurrency}
            onChange={handleNumberChange('concurrency')}
            disabled={running}
          />
        </label>
        <label className="space-y-2 text-sm" data-tooltip="Maximum retries per memory before we mark it failed.">
          <span className="text-xs uppercase text-slate-400">Retry limit</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none transition focus:border-brand-400"
            type="number"
            min={1}
            max={10}
            value={options.retryLimit}
            onChange={handleNumberChange('retryLimit')}
            disabled={running}
          />
        </label>
        <label className="space-y-2 text-sm" data-tooltip="Choose whether duplicates get moved aside, deleted, or kept in place.">
          <span className="text-xs uppercase text-slate-400">Dedupe strategy</span>
          <select
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none transition focus:border-brand-400"
            value={options.dedupeStrategy}
            onChange={handleSelect('dedupeStrategy')}
            disabled={running}
          >
            <option value="move">Move to duplicates folder</option>
            <option value="delete">Delete duplicates permanently</option>
            <option value="none">Leave duplicates untouched</option>
          </select>
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm" data-tooltip="Wait this long before another batch of downloads is released. Helps respect Snapchat rate limits.">
          <span className="text-xs uppercase text-slate-400">Inter-request delay (ms)</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none transition focus:border-brand-400"
            type="number"
            min={0}
            step={50}
            value={options.throttleDelayMs}
            onChange={handleNumberChange('throttleDelayMs')}
            disabled={running}
          />
        </label>
        <label className="space-y-2 text-sm" data-tooltip="Abort an individual download if it takes longer than this number of seconds.">
          <span className="text-xs uppercase text-slate-400">Attempt timeout (seconds)</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none transition focus:border-brand-400"
            type="number"
            min={5}
            step={5}
            value={Math.round(options.attemptTimeoutMs / 1000)}
            onChange={handleNumberChange('attemptTimeoutMs', 1000)}
            disabled={running}
          />
        </label>
      </div>
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
        Snapchat can rate limit aggressively if concurrency is high and no delay is used. Start with a 250-500 ms delay and increase slowly once the export flows reliably; keep the timeout under a minute so individual memories do not stall the queue indefinitely.
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/40 p-3 text-sm" data-tooltip="Keep caption ZIP payloads for manual review instead of deleting them once merged.">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-white/30 bg-black"
            checked={options.keepZipPayloads}
            onChange={handleToggle('keepZipPayloads')}
            disabled={running}
          />
          <span>Keep caption ZIP payloads</span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/40 p-3 text-sm" data-tooltip="Run parsing and validation without downloading media.">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-white/30 bg-black"
            checked={options.dryRun}
            onChange={handleToggle('dryRun')}
            disabled={running}
          />
          <span>Dry run (parse only)</span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/40 p-3 text-sm" data-tooltip="Skip downloads and only verify that prior outputs still exist and match metadata.">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-white/30 bg-black"
            checked={options.verifyOnly}
            onChange={handleToggle('verifyOnly')}
            disabled={running}
          />
          <span>Verify outputs only</span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/40 p-3 text-sm" data-tooltip="After a successful run, delete the intermediate downloads folder automatically (always deleted if empty).">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-white/30 bg-black"
            checked={options.cleanupDownloads}
            onChange={handleToggle('cleanupDownloads')}
            disabled={running}
          />
          <span>Delete downloads after run</span>
        </label>
      </div>
    </section>
  );

  const renderRun = () => (
    <section className="glass-card space-y-5">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">4. Run & Monitor</h2>
        <p className="text-sm text-slate-300">Start the pipeline, then watch live stats, logs, and diagnostics. Hover controls for guidance.</p>
      </div>
      <div className="flex flex-wrap gap-3" role="group" aria-label="Pipeline controls">
        <button
          data-tooltip="Begin the configured pipeline. Disabled until a ZIP and output folder are selected."
          className="rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition hover:bg-brand-400 disabled:opacity-50"
          disabled={!canRun}
          onClick={runPipeline}
        >
          {options.dryRun ? 'Start Dry Run' : 'Start Run'}
        </button>
        <button
          data-tooltip="Pause after the current safe checkpoint."
          className="rounded-xl border border-white/15 bg-black/40 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/40 disabled:opacity-50"
          onClick={handlePause}
          disabled={!running || paused}
        >
          Pause
        </button>
        <button
          data-tooltip="Resume work after a pause."
          className="rounded-xl border border-white/15 bg-black/40 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/40 disabled:opacity-50"
          onClick={handleResume}
          disabled={!running || !paused}
        >
          Resume
        </button>
        <button
          data-tooltip="Bundle logs, config, and the latest report for support."
          className="rounded-xl border border-white/15 bg-black/40 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/40 disabled:opacity-50"
          onClick={handleDiagnostics}
          disabled={!summary || diagnosticsBusy}
        >
          {diagnosticsBusy ? 'Exporting…' : 'Export Diagnostics'}
        </button>
      </div>
      {(diagnosticsBusy || diagnosticsPath) && (
        <p className="text-xs text-slate-400">
          {diagnosticsBusy ? 'Preparing diagnostics bundle…' : `Latest diagnostics bundle: ${diagnosticsPath}`}
        </p>
      )}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-white">Live Stats</h3>
          <span className="text-xs uppercase tracking-wide text-slate-400">{stats?.stage ? `Stage: ${stats.stage}` : 'Stage: --'}</span>
        </div>
        {renderStats()}
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Activity Log</h3>
          <span className="text-xs text-slate-400">Most recent 200 entries</span>
        </div>
        <div className="log-panel" role="log" aria-live="polite">
          {logs.length === 0 && <p className="text-slate-500">No activity yet.</p>}
          {logs.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="log-line">
              <span>{entry.timestamp}</span>
              <span className="flex-1 text-right">{entry.message}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );

  const renderFinish = () => (
    summary && (() => {
      const cascaded = cascadeSummaryCounts(summary);
      const durationSeconds = (summary.durationMs / 1000).toFixed(1);
      return (
        <section className="glass-card space-y-6">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">5. Review & Export</h2>
            <p className="text-sm text-slate-300">Everything completed. Inspect the summary, open the report, and capture diagnostics for your records.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Total', value: cascaded.total },
              { label: 'Downloaded', value: cascaded.downloaded },
              { label: 'Processed', value: cascaded.processed },
              { label: 'Metadata Written', value: cascaded.metadataWritten },
              { label: 'Deduped', value: cascaded.deduped },
              { label: 'Failures', value: cascaded.failures },
              { label: 'Reattempts', value: cascaded.reattempts ?? 0 },
              { label: 'Duration (s)', value: durationSeconds }
            ].map((item) => (
              <div key={item.label} className="stat-card">
                <p className="text-xs uppercase tracking-wide text-slate-400">{item.label}</p>
                <p className="break-words text-xl font-semibold text-white">{item.value}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/40 p-4 text-sm text-slate-200 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Report path</p>
              <p className="font-mono text-xs text-white">{summary.reportPath || 'Report will be written once the diagnostics bundle finishes.'}</p>
            </div>
            <div className="flex items-center gap-3">
              {reportCopyMessage && <span className="text-xs text-emerald-300">{reportCopyMessage}</span>}
              <button
                data-tooltip="Copy the JSON report path so you can share it or open it later."
                className="rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/50 disabled:opacity-40"
                onClick={handleCopyReportPath}
                disabled={!summary.reportPath}
              >
                Copy path
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              data-tooltip="Generate a fresh diagnostics bundle with logs and reports."
              className="rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition hover:bg-brand-400 disabled:opacity-50"
              onClick={handleDiagnostics}
              disabled={!summary || diagnosticsBusy}
            >
              {diagnosticsBusy ? 'Exporting…' : 'Export Diagnostics Bundle'}
            </button>
            <button
              data-tooltip="Open the output folder that contains memories, duplicates, and reports."
              className="rounded-xl border border-white/15 bg-black/40 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/40 disabled:opacity-50"
              onClick={handleOpenOutputFolder}
              disabled={!summary}
            >
              Open output folder
            </button>
          </div>
          {(diagnosticsBusy || diagnosticsPath) && (
            <p className="text-xs text-slate-400">
              {diagnosticsBusy ? 'Preparing diagnostics bundle…' : `Latest diagnostics bundle: ${diagnosticsPath}`}
            </p>
          )}
          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/40 p-4 text-sm text-slate-200 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Next actions</p>
              <p>Retry failed memories, reset the wizard, or close the app.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                data-tooltip="Return to the Run step and reprocess any failures while keeping existing selections."
                className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/40"
                onClick={handleRetryFailures}
              >
                Retry failures
              </button>
              <button
                data-tooltip="Clear selections and start the wizard over from step one."
                className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/40"
                onClick={handleRestartWizard}
              >
                Start over
              </button>
              <button
                data-tooltip="Close the application."
                className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/40"
                onClick={handleExitApp}
              >
                Exit
              </button>
            </div>
          </div>
        </section>
      );
    })()
  );

  const renderCurrentStep = () => {
    switch (step) {
      case 0:
        return renderWelcome();
      case 1:
        return renderSelectExport();
      case 2:
        return renderSelectOutput();
      case 3:
        return renderOptions();
      case 4:
        return renderRun();
      case 5:
        return renderFinish();
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-black">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <p className="text-sm uppercase tracking-[0.3em] text-brand-300">Snapchat Memories Downloader</p>
            <h1 className="text-3xl font-semibold text-white">Guided ingest & verification wizard</h1>
            <p className="text-sm text-slate-300">Ingest your Snapchat export, repair every memory, embed metadata, dedupe safely, and produce a verifiable archive.</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/40 p-4 text-right text-sm text-slate-200">
            <p className="text-xs uppercase tracking-wide text-slate-400">Pipeline state</p>
            <p className="text-xl font-semibold text-white">{paused ? 'Paused' : running ? 'Running' : 'Idle'}</p>
            <p>Phase: {phase}</p>
            <p className="text-slate-400">{lastMessage || 'Waiting for next event...'}</p>
          </div>
        </header>

        {renderStepper()}
        {renderCurrentStep()}
        {step < 4 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-black/30 px-4 py-3 text-sm text-slate-200">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Wizard controls</p>
              <p>{step === 0 ? 'Review the guidance before continuing.' : step === 1 ? 'Select a ZIP to move forward.' : step === 2 ? 'Choose an output folder next.' : 'Review options, then proceed to the run stage.'}</p>
            </div>
            <div className="flex gap-3">
              <button
                data-tooltip="Return to the previous step."
                className="rounded-xl border border-white/20 px-5 py-2 font-semibold text-white transition hover:border-white/50 disabled:opacity-40"
                onClick={goBack}
                disabled={step === 0}
              >
                Back
              </button>
              <button
                data-tooltip="Continue to the next step in the wizard."
                className="rounded-xl bg-brand-500 px-5 py-2 font-semibold text-white shadow-brand-500/30 transition hover:bg-brand-400 disabled:opacity-40"
                onClick={goNext}
                disabled={!canAdvanceFrom(step)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
