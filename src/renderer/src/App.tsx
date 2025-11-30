import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PipelineRunRequest, PipelineRunSummary } from '../../shared/types/memory-entry.js';
import type { PipelineProgressEvent } from '../../shared/ipc.js';

const DEFAULT_OPTIONS: PipelineRunRequest['options'] = {
  concurrency: 4,
  retryLimit: 3,
  keepZipPayloads: false,
  dedupeStrategy: 'move' as const,
  dryRun: false,
  verifyOnly: false
};

type LogEntry = {
  timestamp: string;
  message: string;
};

const App = () => {
  const [exportZip, setExportZip] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [options, setOptions] = useState<PipelineRunRequest['options']>(DEFAULT_OPTIONS);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<PipelineRunSummary | null>(null);
  const [phase, setPhase] = useState<string>('idle');
  const [lastMessage, setLastMessage] = useState<string>('');

  const pushLog = useCallback((message: string) => {
    setLogs((current) => [{ timestamp: new Date().toLocaleTimeString(), message }, ...current].slice(0, 200));
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI.onProgress((event: PipelineProgressEvent) => {
      if (event.type === 'phase') {
        setPhase(event.phase ?? 'working');
        setLastMessage('');
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
      }
    });
    return () => dispose();
  }, [pushLog]);

  const canRun = useMemo(() => exportZip && outputDir && !running, [exportZip, outputDir, running]);

  const handleChooseZip = async () => {
    const result = await window.electronAPI.selectFile([{ name: 'ZIP Files', extensions: ['zip'] }]);
    if (!result.canceled && result.filePaths.length) {
      setExportZip(result.filePaths[0]);
    }
  };

  const handleChooseOutput = async () => {
    const result = await window.electronAPI.selectDirectory();
    if (!result.canceled && result.filePaths.length) {
      setOutputDir(result.filePaths[0]);
    }
  };

  const handleToggle = (key: 'keepZipPayloads' | 'dryRun' | 'verifyOnly') => (event: React.ChangeEvent<HTMLInputElement>) => {
    setOptions((prev: PipelineRunRequest['options']) => ({ ...prev, [key]: event.target.checked }));
  };

  const handleSelect = (key: 'dedupeStrategy') => (event: React.ChangeEvent<HTMLSelectElement>) => {
    setOptions((prev: PipelineRunRequest['options']) => ({ ...prev, [key]: event.target.value as typeof prev.dedupeStrategy }));
  };

  const handleNumberChange = (key: 'concurrency' | 'retryLimit') => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    setOptions((prev: PipelineRunRequest['options']) => ({ ...prev, [key]: Number.isNaN(value) ? prev[key] : value }));
  };

  const runPipeline = async () => {
    if (!canRun) return;
    setRunning(true);
    setLogs([]);
    setSummary(null);
    setPhase('initializing');
    const payload: PipelineRunRequest = {
      exportZipPath: exportZip,
      outputDir,
      options
    };
    try {
      const result = await window.electronAPI.runPipeline(payload);
      setSummary(result);
    } catch (error) {
      pushLog(`Run failed: ${(error as Error).message}`);
    } finally {
      setRunning(false);
      setPhase('idle');
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
          <span className="badge">{running ? 'Running' : 'Idle'}</span>
          <small>Phase: {phase}</small>
          <small>{lastMessage}</small>
        </div>
      </header>

      <section className="card">
        <h2>1. Select Export Zip</h2>
        <div className="field-row">
          <button onClick={handleChooseZip} disabled={running}>
            Choose ZIP
          </button>
          <span className="path">{exportZip || 'No file selected'}</span>
        </div>
        <h2>2. Choose Output Folder</h2>
        <div className="field-row">
          <button onClick={handleChooseOutput} disabled={running}>
            Choose Folder
          </button>
          <span className="path">{outputDir || 'No folder selected'}</span>
        </div>
      </section>

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
        <button className="primary" disabled={!canRun} onClick={runPipeline}>
          {options.dryRun ? 'Start Dry Run' : 'Start Run'}
        </button>
      </section>

      <section className="card">
        <h2>Progress & Logs</h2>
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

      {summary && (
        <section className="card">
          <h2>Summary</h2>
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
        </section>
      )}
    </div>
  );
};

export default App;
