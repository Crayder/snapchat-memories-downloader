import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { PipelineRunRequest, PipelineRunSummary } from '../../shared/types/memory-entry.js';
import type { PipelineProgressEvent } from '../../shared/ipc.js';
import type { PipelineStatsPayload } from '../../shared/types/pipeline-stats.js';

const DEFAULT_OPTIONS: PipelineRunRequest['options'] = {
  concurrency: 4,
  retryLimit: 3,
  keepZipPayloads: false,
  dedupeStrategy: 'move',
  dryRun: false,
  verifyOnly: false
};

const STEPS = ['Welcome', 'Select Export', 'Choose Output', 'Options', 'Run', 'Finish'];

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

  const handleToggle = (key: 'keepZipPayloads' | 'dryRun' | 'verifyOnly') => (event: ChangeEvent<HTMLInputElement>) => {
    setOptions((prev) => ({ ...prev, [key]: event.target.checked }));
  };

  const handleSelect = (key: 'dedupeStrategy') => (event: ChangeEvent<HTMLSelectElement>) => {
    setOptions((prev) => ({ ...prev, [key]: event.target.value as typeof prev.dedupeStrategy }));
  };

  const handleNumberChange = (key: 'concurrency' | 'retryLimit') => (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    setOptions((prev) => ({ ...prev, [key]: Number.isNaN(value) ? prev[key] : value }));
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
      const result = await window.electronAPI.exportDiagnostics();
      setDiagnosticsPath(result.path);
      pushLog(`Diagnostics bundle created: ${result.path}`);
    } catch (error) {
      pushLog(`Diagnostics export failed: ${(error as Error).message}`);
    }
  };

  const canAdvance = (current: number): boolean => {
    if (current === 0) return true;
    if (current === 1) return Boolean(exportZip);
    if (current === 2) return Boolean(outputDir);
    if (current === 3) return true;
    return false;
  };

  const goNext = () => {
    setStep((prev) => Math.min(prev + 1, 4));
  };

  const goBack = () => {
    setStep((prev) => Math.max(prev - 1, 0));
  };

  const renderStats = () => (
    <div className="stats-grid">
      <div>
        <strong>Total Memories</strong>
        <span>{stats?.total ?? '--'}</span>
      </div>
      <div>
        <strong>Images</strong>
        <span>{stats?.images ?? '--'}</span>
      </div>
      <div>
        <strong>Videos</strong>
        <span>{stats?.videos ?? '--'}</span>
      </div>
      <div>
        <strong>With GPS</strong>
        <span>{stats?.withGps ?? '--'}</span>
      </div>
      <div>
        <strong>Downloads</strong>
        <span>{stats?.downloaded ?? 0}</span>
      </div>
      <div>
        <strong>Processed</strong>
        <span>{stats?.processed ?? 0}</span>
      </div>
      <div>
        <strong>Metadata</strong>
        <span>{stats?.metadataWritten ?? 0}</span>
      </div>
      <div>
        <strong>Deduped</strong>
        <span>{stats?.deduped ?? 0}</span>
      </div>
      <div>
        <strong>Failures</strong>
        <span>{stats?.failures ?? 0}</span>
      </div>
    </div>
  );

  const renderStepper = () => (
    <div className="stepper">
      {STEPS.map((label, index) => {
        const state = index === step ? 'active' : index < step ? 'complete' : 'upcoming';
        return (
          <div key={label} className={`step ${state}`}>
            <span className="step-index">{index + 1}</span>
            <span className="step-label">{label}</span>
          </div>
        );
      })}
    </div>
  );

  const renderWelcome = () => (
    <section className="card">
      <h2>Welcome</h2>
      <p>
        Everything happens locally on your machine. Before you begin, make sure you requested a Snapchat export that includes JSON data and that you run this tool within a few days of the download link being issued (links expire quickly).
      </p>
      <ul className="notice-list">
        <li>When requesting your export, toggle on <strong>JSON</strong> so memories_history.json is included.</li>
        <li>Download and run this workflow as soon as you receive the email—Snapchat links generally expire in 72 hours.</li>
        <li>Keep the ZIP untouched until ingest; the app extracts to a sandboxed work folder.</li>
      </ul>
    </section>
  );

  const renderSelectExport = () => (
    <section className="card">
      <h2>1. Select Export Zip</h2>
      <div className="field-row">
        <button onClick={handleChooseZip} disabled={running}>Choose ZIP</button>
        <span className="path">{exportZip || 'No file selected'}</span>
      </div>
    </section>
  );

  const renderSelectOutput = () => (
    <section className="card">
      <h2>2. Choose Output Folder</h2>
      <div className="field-row">
        <button onClick={handleChooseOutput} disabled={running}>Choose Folder</button>
        <span className="path">{outputDir || 'No folder selected'}</span>
      </div>
    </section>
  );

  const renderOptions = () => (
    <section className="card">
      <h2>3. Options</h2>
      <div className="options-grid">
        <label>
          Concurrency
          <input type="number" min={1} max={10} value={options.concurrency} onChange={handleNumberChange('concurrency')} disabled={running} />
        </label>
        <label>
          Retry Limit
          <input type="number" min={1} max={10} value={options.retryLimit} onChange={handleNumberChange('retryLimit')} disabled={running} />
        </label>
        <label>
          Dedupe Strategy
          <select value={options.dedupeStrategy} onChange={handleSelect('dedupeStrategy')} disabled={running}>
            <option value="move">Move to duplicates</option>
            <option value="delete">Delete duplicates</option>
            <option value="none">Leave duplicates</option>
          </select>
        </label>
      </div>
      <div className="toggle-row">
        <label>
          <input type="checkbox" checked={options.keepZipPayloads} onChange={handleToggle('keepZipPayloads')} disabled={running} /> Keep caption ZIP payloads
        </label>
        <label>
          <input type="checkbox" checked={options.dryRun} onChange={handleToggle('dryRun')} disabled={running} /> Dry run (parse only)
        </label>
        <label>
          <input type="checkbox" checked={options.verifyOnly} onChange={handleToggle('verifyOnly')} disabled={running} /> Verify outputs only
        </label>
      </div>
    </section>
  );

  const renderRun = () => (
    <section className="card">
      <h2>4. Run Pipeline</h2>
      <div className="run-controls">
        <button className="primary" disabled={!canRun} onClick={runPipeline}>
          {options.dryRun ? 'Start Dry Run' : 'Start Run'}
        </button>
        <button onClick={handlePause} disabled={!running || paused}>Pause</button>
        <button onClick={handleResume} disabled={!running || !paused}>Resume</button>
        <button onClick={handleDiagnostics} disabled={!summary}>Export Diagnostics</button>
      </div>
      {diagnosticsPath && <p className="diagnostics-note">Latest diagnostics bundle: {diagnosticsPath}</p>}
      <h3>Stats {stats?.stage ? `(stage: ${stats.stage})` : ''}</h3>
      {renderStats()}
      <div className="log-panel">
        {logs.length === 0 && <p className="muted">No activity yet.</p>}
        {logs.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} className="log-line">
            <span>{entry.timestamp}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  );

  const renderFinish = () => (
    summary && (
      <section className="card">
        <h2>5. Finish</h2>
        <p>Archive ready! Share the diagnostics bundle with support if you need help.</p>
        <div className="summary-grid">
          <div>
            <strong>Total</strong>
            <span>{summary.total}</span>
          </div>
          <div>
            <strong>Downloaded</strong>
            <span>{summary.downloaded}</span>
          </div>
          <div>
            <strong>Processed</strong>
            <span>{summary.processed}</span>
          </div>
          <div>
            <strong>Metadata</strong>
            <span>{summary.metadataWritten}</span>
          </div>
          <div>
            <strong>Deduped</strong>
            <span>{summary.deduped}</span>
          </div>
          <div>
            <strong>Failures</strong>
            <span>{summary.failures}</span>
          </div>
          <div>
            <strong>Duration</strong>
            <span>{(summary.durationMs / 1000).toFixed(1)}s</span>
          </div>
          <div>
            <strong>Report</strong>
            <span>{summary.reportPath || 'Pending'}</span>
          </div>
        </div>
        <button className="primary" onClick={handleDiagnostics} disabled={!summary}>Export Diagnostics Bundle</button>
      </section>
    )
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
    <div className="app">
      <header>
        <div>
          <h1>Snap Memories Backup</h1>
          <p>Ingest your Snapchat export, repair media, and produce a verified archive.</p>
        </div>
        <div className="status">
          <span className="badge">{paused ? 'Paused' : running ? 'Running' : 'Idle'}</span>
          <small>Phase: {phase}</small>
          <small>{lastMessage}</small>
        </div>
      </header>

      {renderStepper()}
      {renderCurrentStep()}

      {step >= 0 && step <= 3 && (
        <div className="wizard-nav">
          <button onClick={goBack} disabled={step === 0 || running}>Back</button>
          <button onClick={goNext} disabled={!canAdvance(step) || running}>Next</button>
        </div>
      )}

      {step === 5 && (
        <div className="wizard-nav">
          <button onClick={() => setStep(3)} disabled={running}>Configure Another Run</button>
        </div>
      )}
    </div>
  );
};

export default App;
