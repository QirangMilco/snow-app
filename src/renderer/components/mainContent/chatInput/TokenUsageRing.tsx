import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import type { TokenUsage } from "../../../../preload";

type TokenUsageRingProps = {
  tokenUsage: TokenUsage | null;
  maxContextTokens?: number | null;
  isLoading?: boolean;
};

// 与发送按钮 (.send-btn) 保持相同的 28x28 尺寸
const RING_SIZE = 28;
const STROKE_WIDTH = 2.5;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const TokenUsageRing = ({
  tokenUsage,
  maxContextTokens,
  isLoading = false,
}: TokenUsageRingProps): React.JSX.Element | null => {
  const { locale, t } = useI18n();
  const [showTooltip, setShowTooltip] = useState(false);

  const segments = useMemo(() => {
    if (!tokenUsage) {
      return null;
    }

    const input = tokenUsage.inputTokens;
    const output = tokenUsage.outputTokens;
    const cacheCreation = tokenUsage.cacheCreationInputTokens;
    const cacheRead = Math.min(tokenUsage.cacheReadInputTokens, input);

    // Rust normalizes all providers so input includes cache reads. Cache reads
    // are therefore a subset of input rather than an additional total.
    const total = input + output;

    if (total === 0) {
      return null;
    }

    const max =
      maxContextTokens && maxContextTokens > 0 ? maxContextTokens : total;
    const ratio = Math.min(total / max, 1);
    const filled = ratio * CIRCUMFERENCE;
    const remaining = CIRCUMFERENCE - filled;
    const nonCachedInput = input - cacheRead;

    const inputLength = filled * (nonCachedInput / total);
    const outputLength = filled * (output / total);
    const cacheLength = filled * (cacheRead / total);

    return {
      input,
      output,
      cacheCreation,
      cacheRead,
      nonCachedInput,
      total,
      max,
      ratio,
      filled,
      remaining,
      inputLength,
      outputLength,
      cacheLength,
    };
  }, [tokenUsage, maxContextTokens]);

  // 组件在 isLoading / !segments 分支会提前 return，导致绑定
  // onMouseEnter/Leave 的交互 wrapper 被卸载，mouseleave 事件丢失，
  // showTooltip 被卡在 true。当数据恢复后组件重新挂载交互分支时，
  // tooltip 会在鼠标未悬停的情况下莫名弹出。这里在进入非交互分支前
  // 重置状态，避免悬挂的 true 值。
  useEffect(() => {
    if (isLoading || !segments) {
      setShowTooltip(false);
    }
  }, [isLoading, segments]);

  // API 配置加载期间 maxContextTokens 尚未就绪，此时用 total 作为分母
  // 会算出 ratio=1 的虚假满状态。渲染空环占位保持布局稳定，等配置
  // 加载完成后再计算并显示真实比例。
  if (isLoading) {
    return (
      <div className="token-usage-ring-wrapper">
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          className="token-usage-ring"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            className="token-usage-ring-bg"
          />
        </svg>
        <span className="token-usage-ring-text">--</span>
      </div>
    );
  }

  if (!segments) {
    return null;
  }

  // tooltip 中的 token 数值用 K / M / B 紧凑单位显示，便于快速阅读
  const formatTokens = (value: number): string => {
    if (value < 1000) {
      return value.toLocaleString(locale);
    }
    const units: Array<[number, string]> = [
      [1_000_000_000, "B"],
      [1_000_000, "M"],
      [1_000, "K"],
    ];
    for (const [threshold, suffix] of units) {
      if (value >= threshold) {
        const scaled = value / threshold;
        const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
        return `${scaled.toFixed(decimals)}${suffix}`;
      }
    }
    return value.toLocaleString(locale);
  };
  const percent = Math.round(segments.ratio * 100);
  const tooltipContent = (
    <div className="token-usage-tooltip">
      <div className="token-usage-tooltip-row">
        <span className="token-usage-dot token-usage-dot-input" />
        <span className="token-usage-label">
          {t("chatInput.tokenUsage.input")}
        </span>
        <span className="token-usage-value">
          {formatTokens(segments.nonCachedInput)}
        </span>
      </div>
      <div className="token-usage-tooltip-row">
        <span className="token-usage-dot token-usage-dot-output" />
        <span className="token-usage-label">
          {t("chatInput.tokenUsage.output")}
        </span>
        <span className="token-usage-value">
          {formatTokens(segments.output)}
        </span>
      </div>
      {segments.cacheCreation > 0 && (
        <div className="token-usage-tooltip-row">
          <span className="token-usage-dot token-usage-dot-cache" />
          <span className="token-usage-label">
            {t("chatInput.tokenUsage.cacheWrite")}
          </span>
          <span className="token-usage-value">
            {formatTokens(segments.cacheCreation)}
          </span>
        </div>
      )}
      {segments.cacheRead > 0 && (
        <div className="token-usage-tooltip-row">
          <span className="token-usage-dot token-usage-dot-cache-read" />
          <span className="token-usage-label">
            {t("chatInput.tokenUsage.cacheHit")}
          </span>
          <span className="token-usage-value">
            {formatTokens(segments.cacheRead)}
          </span>
        </div>
      )}
      <div className="token-usage-tooltip-divider" />
      <div className="token-usage-tooltip-row">
        <span className="token-usage-label">
          {t("chatInput.tokenUsage.total")}
        </span>
        <span className="token-usage-value">
          {formatTokens(segments.total)}
        </span>
      </div>
      {maxContextTokens && maxContextTokens > 0 && (
        <div className="token-usage-tooltip-row">
          <span className="token-usage-label">
            {t("chatInput.tokenUsage.context")}
          </span>
          <span className="token-usage-value">
            {formatTokens(segments.max)}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="token-usage-ring-wrapper"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="token-usage-ring"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="token-usage-ring-bg"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="butt"
          className="token-usage-ring-input"
          strokeDasharray={`${segments.inputLength} ${
            CIRCUMFERENCE - segments.inputLength
          }`}
          strokeDashoffset={0}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="butt"
          className="token-usage-ring-output"
          strokeDasharray={`${segments.outputLength} ${
            CIRCUMFERENCE - segments.outputLength
          }`}
          strokeDashoffset={-segments.inputLength}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="butt"
          className="token-usage-ring-cache"
          strokeDasharray={`${segments.cacheLength} ${
            CIRCUMFERENCE - segments.cacheLength
          }`}
          strokeDashoffset={-(segments.inputLength + segments.outputLength)}
        />
      </svg>
      <span
        className={`token-usage-ring-text${
          percent === 100 ? " is-compact" : ""
        }`}
      >
        {percent}%
      </span>
      {showTooltip && tooltipContent}
    </div>
  );
};
