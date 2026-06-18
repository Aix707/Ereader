import { ArrowLeft, Database, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { DiagnosticsSummary } from "../types";

interface DiagnosticsViewProps {
  onBack: () => void;
  onRebuild: (bookId: string) => Promise<void>;
}

export function DiagnosticsView({ onBack, onRebuild }: DiagnosticsViewProps) {
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setSummary(await window.ereader.getDiagnostics());
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="diagnostics-shell">
      <header className="diagnostics-header">
        <button className="toolbar-button" onClick={onBack} title="返回书架">
          <ArrowLeft size={18} />
        </button>
        <div>
          <p className="eyebrow">Diagnostics</p>
          <h1>数据库诊断</h1>
        </div>
        <button className="secondary-action compact" onClick={refresh}>
          <RefreshCw size={16} />
          刷新
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {!summary ? (
        <div className="empty-state">正在读取诊断信息...</div>
      ) : (
        <section className="diagnostics-content">
          <div className="diagnostic-stat-row">
            <Stat label="书籍" value={summary.stats.books} />
            <Stat label="阅读单元" value={summary.stats.units} />
            <Stat label="资产" value={summary.stats.assets} />
            <Stat label="资产体积" value={`${(summary.stats.assetBytes / 1024 / 1024).toFixed(1)} MB`} />
          </div>

          <section className="diagnostic-panel">
            <h2>
              <Database size={17} />
              SQLite
            </h2>
            <p>{summary.dbPath}</p>
          </section>

          <section className="diagnostic-panel">
            <h2>书籍处理状态</h2>
            <div className="diagnostic-table">
              {summary.books.map((book) => (
                <div className="diagnostic-row" key={book.id}>
                  <div>
                    <strong>{book.title}</strong>
                    <span>{book.path}</span>
                  </div>
                  <StatusPill status={book.importStatus} />
                  <span>{book.unitCount} units</span>
                  <span>{book.assetCount} assets</span>
                  <span>{book.sourceExists ? "源文件存在" : "源文件缺失"}</span>
                  <button
                    className="icon-text-button"
                    onClick={() => onRebuild(book.id).then(refresh)}
                  >
                    <RefreshCw size={15} />
                    重建
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="diagnostic-panel">
            <h2>
              <TriangleAlert size={17} />
              最近日志
            </h2>
            <div className="log-list">
              {summary.recentDiagnostics.length === 0 ? (
                <p>暂无诊断日志</p>
              ) : (
                summary.recentDiagnostics.map((item) => (
                  <article key={item.id} className={`log-item ${item.level}`}>
                    <strong>{item.level.toUpperCase()} · {item.title || "System"}</strong>
                    <span>{item.createdAt}</span>
                    <p>{item.message}</p>
                  </article>
                ))
              )}
            </div>
          </section>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="diagnostic-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}
