import {
  Activity,
  ArrowLeft,
  BookCheck,
  BookOpen,
  ChartColumnIncreasing,
  ChartNoAxesCombined,
  ChartPie,
  ChevronDown,
  Database,
  RefreshCw,
  TriangleAlert
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, StatsSummary } from "../types";
import { formatPercent, formatRelativeDate, labelForContentType, labelForFormat } from "../lib/format";
import { globalBackgroundStyle } from "../lib/appearance";
import { useTitlebarDoubleClick } from "../lib/ui";
import { WindowControls } from "./WindowControls";

interface StatsViewProps {
  onBack: () => void;
  onRebuild: (bookId: string) => Promise<void>;
  appSettings: AppSettings;
}

export function StatsView({ onBack, onRebuild, appSettings }: StatsViewProps) {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shellStyle = useMemo(() => globalBackgroundStyle(appSettings.appearance), [appSettings.appearance]);
  const handleTitlebarDoubleClick = useTitlebarDoubleClick("button, .window-controls");

  async function refresh() {
    setError(null);
    try {
      setSummary(await window.ereader.getStats());
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const maxDailyEvents = useMemo(
    () => Math.max(1, ...(summary?.activityByDay.map((item) => item.events) || [0])),
    [summary]
  );

  return (
    <main className="stats-shell" style={shellStyle}>
      <header className="app-titlebar stats-titlebar" onDoubleClick={handleTitlebarDoubleClick}>
        <div className="topbar-title-island stats-title-island">
          <button className="topbar-island-button" onClick={onBack} title="返回书架" aria-label="返回书架">
            <ArrowLeft size={17} />
          </button>
          <ChartNoAxesCombined size={15} />
          <span>阅读统计</span>
        </div>
        <WindowControls />
      </header>

      <header className="stats-header">
        <div>
          <p className="eyebrow">Statistics</p>
          <h1>你的阅读概览</h1>
          <p>基于本地书库、阅读进度和最近活动生成。</p>
        </div>
        <button className="secondary-action compact" onClick={refresh}>
          <RefreshCw size={16} />
          刷新
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {!summary ? (
        <div className="empty-state">正在生成阅读统计...</div>
      ) : (
        <section className="stats-content">
          <div className="stats-overview-grid">
            <OverviewCard icon={<BookOpen />} label="书库总量" value={`${summary.overview.totalBooks} 本`} hint={`${summary.overview.readBooks} 本已开始`} />
            <OverviewCard icon={<ChartPie />} label="平均进度" value={formatPercent(summary.overview.averageProgress)} hint={`${summary.overview.completedBooks} 本已完成`} />
            <OverviewCard icon={<Activity />} label="近 30 天活跃" value={`${summary.overview.activeDays30} 天`} hint={`连续 ${summary.overview.currentStreakDays} 天`} />
            <OverviewCard icon={<BookCheck />} label="近 7 天打开" value={`${summary.habits.recentOpenCount} 次`} hint={formatFavorite(summary)} />
          </div>

          <div className="stats-grid">
            <section className="stats-panel progress-panel">
              <PanelTitle icon={<ChartPie size={17} />} title="阅读进度" aside={`${summary.overview.completedBooks}/${summary.overview.totalBooks || 0} 完成`} />
              {summary.overview.totalBooks === 0 ? (
                <p className="stats-empty-text">导入书籍后会在这里看到整体阅读进度。</p>
              ) : (
                <>
                  <div className="progress-band-stack" aria-label="阅读进度分布">
                    {summary.progressBands.map((band) => (
                      <i
                        key={band.key}
                        className={`band-${band.key}`}
                        style={{ width: `${Math.max(band.count ? 3 : 0, band.ratio * 100)}%` }}
                        title={`${band.label} ${band.count} 本`}
                      />
                    ))}
                  </div>
                  <div className="progress-band-list">
                    {summary.progressBands.map((band) => (
                      <div className="progress-band-row" key={band.key}>
                        <span>
                          <i className={`band-dot band-${band.key}`} />
                          {band.label}
                        </span>
                        <strong>{band.count} 本</strong>
                        <em>{formatPercent(band.ratio)}</em>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="stats-panel recent-panel">
              <PanelTitle icon={<BookOpen size={17} />} title="最近阅读" aside="按最近打开排序" />
              {summary.recentBooks.length === 0 ? (
                <p className="stats-empty-text">打开一本书后，这里会显示最近阅读记录。</p>
              ) : (
                <div className="recent-reading-list">
                  {summary.recentBooks.map((book) => (
                    <article className="recent-reading-item" key={book.id}>
                      <RecentBookCover book={book} />
                      <div>
                        <strong>{book.title}</strong>
                        <span>{labelForContentType(book.contentType)} · {labelForFormat(book.format)}</span>
                        <div className="mini-meter">
                          <i style={{ width: `${Math.round(book.progressPercent * 100)}%` }} />
                        </div>
                      </div>
                      <em>{book.lastOpenedAt ? formatRelativeDate(book.lastOpenedAt) : "未打开"}</em>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="stats-panel activity-panel">
              <PanelTitle icon={<ChartColumnIncreasing size={17} />} title="近 14 天活动" aside={`${summary.habits.activeDays30}/30 活跃天`} />
              <div className="activity-chart" aria-label="近 14 天阅读活动">
                {summary.activityByDay.map((day) => (
                  <div className="activity-day" key={day.day} title={`${day.day} · ${day.events} 次活动`}>
                    <span>
                      <i style={{ height: `${Math.max(day.events ? 12 : 3, (day.events / maxDailyEvents) * 100)}%` }} />
                    </span>
                    <small>{formatDayLabel(day.day)}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="stats-panel preference-panel">
              <PanelTitle icon={<ChartNoAxesCombined size={17} />} title="阅读偏好" aside="按书库占比" />
              <DistributionList title="内容类型" items={summary.contentTypes} labelForKey={labelForContentType} />
              <DistributionList title="文件格式" items={summary.formats} labelForKey={labelForFormat} />
            </section>
          </div>

          <AdvancedMaintenance summary={summary} onRebuild={onRebuild} onRefresh={refresh} />
        </section>
      )}
    </main>
  );
}

function OverviewCard({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return (
    <article className="stats-overview-card">
      <div className="stats-card-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{hint}</em>
    </article>
  );
}

function PanelTitle({ icon, title, aside }: { icon: ReactNode; title: string; aside?: string }) {
  return (
    <header className="stats-panel-title">
      <h2>
        {icon}
        {title}
      </h2>
      {aside && <span>{aside}</span>}
    </header>
  );
}

function RecentBookCover({ book }: { book: StatsSummary["recentBooks"][number] }) {
  if (book.coverAssetId) {
    return (
      <div className="recent-book-cover">
        <img src={window.ereader.getAssetUrl(book.coverAssetId)} alt="" />
      </div>
    );
  }
  return (
    <div className={`recent-book-cover generated ${book.format === "txt" || book.format === "mobi" ? "txt" : ""}`}>
      <strong>{Array.from(book.title).slice(0, 2).join("")}</strong>
    </div>
  );
}

function DistributionList<T extends string>({
  title,
  items,
  labelForKey
}: {
  title: string;
  items: Array<{ key: T; count: number; ratio: number }>;
  labelForKey: (key: T) => string;
}) {
  return (
    <div className="distribution-block">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="stats-empty-text">暂无数据</p>
      ) : (
        items.map((item) => (
          <div className="distribution-row" key={item.key}>
            <div>
              <span>{labelForKey(item.key)}</span>
              <strong>{item.count} 本</strong>
            </div>
            <i>
              <b style={{ width: `${Math.max(item.count ? 4 : 0, item.ratio * 100)}%` }} />
            </i>
          </div>
        ))
      )}
    </div>
  );
}

function AdvancedMaintenance({
  summary,
  onRebuild,
  onRefresh
}: {
  summary: StatsSummary;
  onRebuild: (bookId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const advanced = summary.advanced;
  const attentionBooks = advanced.books.filter((book) => book.importStatus !== "ready" || !book.sourceExists).slice(0, 8);

  return (
    <details className="stats-advanced">
      <summary>
        <span>
          <Database size={17} />
          高级维护
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="advanced-content">
        <section className="diagnostic-panel">
          <h2>
            <Database size={17} />
            本地数据库
          </h2>
          <p>{advanced.dbPath}</p>
          <div className="maintenance-stat-grid">
            <MaintenanceStat label="阅读单元" value={advanced.stats.units} />
            <MaintenanceStat label="资产" value={advanced.stats.assets} />
            <MaintenanceStat label="资产体积" value={`${(advanced.stats.assetBytes / 1024 / 1024).toFixed(1)} MB`} />
            <MaintenanceStat label="最大资产" value={`${(advanced.stats.largestAssetBytes / 1024 / 1024).toFixed(1)} MB`} />
            <MaintenanceStat label="孤儿资产" value={advanced.stats.orphanAssets} />
            <MaintenanceStat label="缺失引用" value={advanced.stats.missingAssets} />
            <MaintenanceStat label="空内容" value={advanced.stats.readyWithoutUnits} />
          </div>
        </section>

        <section className="diagnostic-panel">
          <h2>
            <TriangleAlert size={17} />
            需关注书籍
          </h2>
          <div className="diagnostic-table">
            {attentionBooks.length === 0 ? (
              <p>当前没有需要处理的书籍。</p>
            ) : (
              attentionBooks.map((book) => (
                <div className="maintenance-row" key={book.id}>
                  <div>
                    <strong>{book.title}</strong>
                    <span>{book.path}</span>
                  </div>
                  <StatusPill status={book.importStatus} />
                  <span>{book.sourceExists ? "源文件存在" : "源文件缺失"}</span>
                  <button className="icon-text-button" onClick={() => onRebuild(book.id).then(onRefresh)}>
                    <RefreshCw size={15} />
                    重建
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="diagnostic-panel">
          <h2>最近维护日志</h2>
          <div className="log-list">
            {advanced.recentDiagnostics.length === 0 ? (
              <p>暂无维护日志。</p>
            ) : (
              advanced.recentDiagnostics.slice(0, 8).map((item) => (
                <article key={item.id} className={`log-item ${item.level}`}>
                  <strong>{item.level.toUpperCase()} · {item.title || "System"}</strong>
                  <span>{formatRelativeDate(item.createdAt)}</span>
                  <p>{item.message}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </details>
  );
}

function MaintenanceStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="maintenance-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{statusLabel(status)}</span>;
}

function formatFavorite(summary: StatsSummary) {
  const type = summary.habits.favoriteContentType ? labelForContentType(summary.habits.favoriteContentType) : "暂无偏好";
  const format = summary.habits.favoriteFormat ? labelForFormat(summary.habits.favoriteFormat) : "暂无格式";
  return `${type} · ${format}`;
}

function formatDayLabel(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function statusLabel(status: string) {
  if (status === "queued") return "排队";
  if (status === "processing") return "处理中";
  if (status === "ready") return "就绪";
  if (status === "error") return "失败";
  if (status === "stale") return "需重建";
  if (status === "cancelled") return "已取消";
  return status;
}
