import React, { useCallback, useEffect, useState } from 'react';
import { Tooltip } from 'antd';
import { apiUrl } from '../../utils/apiUrl';
import { imTr as _tr } from '../../utils/imTr';
import { deriveImConnState } from '../../utils/imConnState';
import styles from './ImStatusChip.module.css';

/**
 * Compact, generic IM status chip for the header (one per descriptor). Renders nothing unless the
 * platform's bridge is enabled; otherwise the connection state is conveyed by the brand icon's
 * COLOR — the platform's brand color when connected, grey otherwise (incl. error; the tooltip
 * still spells out the error). Clicking it opens the messaging panel on this platform's tab.
 * Self-contained: polls the platform's status endpoint every 5s.
 */
export default function ImStatusChip({ descriptor, onClick, onStatus }) {
  const [enabled, setEnabled] = useState(false);
  const [connection, setConnection] = useState(null);
  const Icon = descriptor.icon;

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(apiUrl(descriptor.endpoints.status));
      // 失败时复位为断连态，绝不保留上一次的「已连接」——状态须以真实为准（否则断连后徽标发霉）。
      if (!r.ok) { setConnection({ running: false, connected: false }); return; }
      const d = await r.json();
      setEnabled(!!d.enabled);
      setConnection(d.connection || null);
    } catch { setConnection({ running: false, connected: false }); }
  }, [descriptor]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Process-aware status via deriveImConnState. Each IM runs in a detached worker; the main ccv
  // reports {running, connected, connectionState, lastError} through the manager.
  //   error        — worker reported lastError (grey + red dot)
  //   connected    — process up + adapter connected (brand color)
  //   reconnecting — link dropped, SDK retrying (brand color + reduced opacity + amber dot)
  //   running      — process up but adapter not connected yet (brand color + reduced opacity)
  //   stopped      — process down (grey)
  const state = deriveImConnState(connection);

  // Report status upward (for the Electron tab bar's migrated IM icons; web passes no onStatus).
  useEffect(() => {
    if (!onStatus) return;
    onStatus(descriptor.id, {
      enabled,
      running: !!connection?.running,
      connected: state === 'connected',
      state,
    });
  }, [enabled, connection, state, onStatus, descriptor.id]);

  if (!enabled) return null;

  const statusLabel = state === 'connected'
    ? _tr('ui.im.statusConnected', null, 'Connected')
    : state === 'reconnecting'
      ? `${_tr('ui.im.statusReconnecting', null, 'Reconnecting…')}${connection?.lastError ? `: ${connection.lastError}` : ''}`
      : state === 'running'
        ? _tr('ui.im.statusRunning', null, 'Running, connecting…')
        : state === 'error'
          ? `${_tr('ui.im.statusError', null, 'Error')}: ${connection.lastError}`
          : _tr('ui.im.statusStopped', null, 'Stopped');
  const label = _tr(descriptor.labelKey, null, descriptor.fallback);
  // Brand color when running/connected/reconnecting, grey when stopped/error — driven by the descriptor.
  const color = (state === 'connected' || state === 'running' || state === 'reconnecting') ? descriptor.color : 'var(--text-tertiary, #999)';
  const iconClass = (state === 'running' || state === 'reconnecting') ? `${styles.logo} ${styles.connecting}` : styles.logo;

  return (
    <Tooltip title={`${label} · ${statusLabel}`}>
      <span className={styles.chip} onClick={onClick} role="button" tabIndex={0}
        aria-label={`${label} · ${statusLabel}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(); }}>
        <Icon size={16} className={iconClass} style={{ color }} />
        {state === 'error' ? <span className={styles.dotError} aria-hidden="true" /> : null}
        {state === 'reconnecting' ? <span className={styles.dotReconnecting} aria-hidden="true" /> : null}
      </span>
    </Tooltip>
  );
}
