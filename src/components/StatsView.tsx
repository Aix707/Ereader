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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings, DiagnosticsSummary, StatsSummary } from "../types";
import { globalBackgroundStyle } from "../lib/appearance";
import { importStatusLabel, usesGeneratedTextCover } from "../lib/book";
import { formatPercent, formatRelativeDate, labelForContentType, labelForFormat } from "../lib/format";
import { heightPercentStyle, widthPercentStyle } from "../lib/style";
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
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [advanced, setAdvanced] = useState<DiagnosticsSummary | null>(null);
  const requestVersion = useRef(0);
  const shellStyle = useMemo(() => globalBackgroundStyle(appSettings.appearance), [appSettings.appearance]);
  const handleTitlebarDoubleClick = useTitlebarDoubleClick("button, .window-controls");

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setError(null);
    try {
      const [nextSummary, nextAdvanced] = await Promise.all([
        window.ereader.getStats(),
        maintenanceOpen ? window.ereader.getDiagnostics() : Promise.resolve(null)
      ]);
      if (version !== requestVersion.current) return;
      setSummary(nextSummary);
      setAdvanced(nextAdvanced);
    } catch (reason) {
      if (version === requestVersion.current) setError(String(reason));
    }
  }, [maintenanceOpen]);

  useEffect(() => {
    refresh();
    let timer: number | undefined;
    const scheduleRefresh = () => {
      if (timer !== undefined || document.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        refresh();
      }, 1000);
    };
    const unsubscribe = window.ereader.onImportStateChanged(scheduleRefresh);
    window.addEventListener("focus", scheduleRefresh);
    return () => {
      requestVersion.current += 1;
      window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, [refresh]);

  const maxDailyEvents = useMemo(
    () => Math.max(1, ...(summary?.activityByDay.map((item) => item.events) || [0])),
    [summary]
  );
  const hasActivity = summary?.activityByDay.some((day) => day.events > 0);

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
          <h1>阅读概览</h1>
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
                        style={widthPercentStyle(band.ratio, band.count ? 3 : 0)}
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
              <PanelTitle icon={<BookOpen size={16} />} title="最近阅读" />
              {summary.recentBooks.length === 0 ? (
                <p className="stats-empty-text">打开一本书后，这里会显示最近阅读记录。</p>
              ) : (
                <div className="recent-reading-list">
                  {summary.recentBooks.map((book) => (
                    <article className="recent-reading-item" key={book.id}>
                      <RecentBookCover book={book} />
                      <div>
                        <div className="recent-reading-caption">
                          <strong title={book.title}>{book.title}</strong>
                          <span>{labelForContentType(book.contentType)}·{labelForFormat(book.format)}</span>
                        </div>
                        <div className="mini-meter">
                          <i style={widthPercentStyle(book.progressPercent)} />
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
              {hasActivity ? <div className="activity-chart" aria-label="近 14 天阅读活动">
                {summary.activityByDay.map((day, index) => (
                  <div className="activity-day" key={day.day} title={`${day.day} · ${day.events} 次活动`}>
                    <span>
                      <i style={heightPercentStyle(day.events / maxDailyEvents)} />
                    </span>
                    <small>{[0, 6, summary.activityByDay.length - 1].includes(index) ? formatDayLabel(day.day) : ""}</small>
                  </div>
                ))}
              </div> : <p className="stats-empty-text">近14天暂无阅读活动</p>}
            </section>

            <section className="stats-panel preference-panel">
              <PanelTitle icon={<ChartNoAxesCombined size={16} />} title="阅读偏好" />
              <div className="distribution-grid">
                <DistributionList title="内容类型" items={summary.contentTypes} labelForKey={labelForContentType} />
                <DistributionList title="文件格式" items={summary.formats} labelForKey={labelForFormat} />
              </div>
            </section>
          </div>

          <AdvancedMaintenance advanced={advanced} onOpenChange={setMaintenanceOpen} onRebuild={onRebuild} onRefresh={refresh} />
        </section>
      )}
    </main>
  );
}

function OverviewCard({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return (
    <article className="stats-overview-card">
      <div className="stats-card-icon">{icon}</div>
      <span className="stats-card-label">{label}</span>
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
    <div className={`recent-book-cover generated ${usesGeneratedTextCover(book.format) ? "txt" : ""}`}>
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
              <b style={widthPercentStyle(item.ratio, item.count ? 4 : 0)} />
            </i>
          </div>
        ))
      )}
    </div>
  );
}

function AdvancedMaintenance({
  advanced,
  onOpenChange,
  onRebuild,
  onRefresh
}: {
  advanced: DiagnosticsSummary | null;
  onOpenChange: (open: boolean) => void;
  onRebuild: (bookId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const attentionBooks = advanced?.books.filter((book) => book.importStatus !== "ready" || !book.sourceExists).slice(0, 8) || [];

  return (
    <details className="stats-advanced" onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary>
        <span>
          <Database size={17} />
          高级维护
        </span>
        <ChevronDown size={16} />
      </summary>
      {!advanced ? <div className="advanced-content">正在读取维护信息...</div> : <div className="advanced-content">
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
                  <strong>{{ error: "错误", warning: "警告", info: "信息" }[item.level] || item.level} · {item.title || "系统"}</strong>
                  <span>{formatRelativeDate(item.createdAt)}</span>
                  <p>{item.message}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>}
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
  return <span className={`status-pill ${status}`}>{importStatusLabel(status, { error: "失败" })}</span>;
}

function formatFavorite(summary: StatsSummary) {
  if (!summary.habits.favoriteContentType && !summary.habits.favoriteFormat) return "暂无阅读偏好";
  const type = summary.habits.favoriteContentType ? labelForContentType(summary.habits.favoriteContentType) : "暂无偏好";
  const format = summary.habits.favoriteFormat ? labelForFormat(summary.habits.favoriteFormat) : "暂无格式";
  return `${type} · ${format}`;
}

function formatDayLabel(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}
