import React from 'react';
import { Tag } from 'antd';
import { t } from '../../i18n';

// Format a millisecond duration into a human-readable string
export function fmtMs(ms) {
  if (!ms || ms <= 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Status code → antd Tag color
export function statusColor(status) {
  if (status === 0) return 'default';
  if (status < 400) return 'green';
  if (status < 500) return 'orange';
  return 'red';
}

// Availability percentage → semantic CSS color (theme-aware via CSS vars)
// Aligned with llm-retry-proxy's availColor thresholds (>=95 green / >=80 amber / else red).
export function availColor(pct) {
  if (pct >= 95) return 'var(--ok, #52c41a)';
  if (pct >= 80) return 'var(--warn, #faad14)';
  return 'var(--danger, #cf1322)';
}

// Render a "dominant fail code × count" Tag for a byModel/byPath/byProfile bucket.
// Returns null when the bucket had no retry codes (dominantFailStatus === null).
export function dominantFailCell(bucket) {
  if (!bucket || bucket.dominantFailStatus == null) return null;
  return (
    <Tag color={statusColor(bucket.dominantFailStatus)}>
      {bucket.dominantFailStatus} × {bucket.dominantFailCount}
    </Tag>
  );
}

// Resolve the i18n label for a retry-burden bucket key
export function burdenBucketLabel(key) {
  return t(`ui.proxyStats.retryBurdenBuckets.${key}`);
}
