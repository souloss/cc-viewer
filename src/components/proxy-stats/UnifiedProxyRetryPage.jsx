import React from 'react';
import { RetryConfigForm } from '../settings/RetryConfigModal';
import ProxyStatsPage from './ProxyStatsPage';
import { t } from '../../i18n';
import styles from './UnifiedProxyRetryPage.module.css';

export default function UnifiedProxyRetryPage({ retryConfig, retryDefaults, onRetryConfigChange }) {
  return (
    <div className={styles.container}>
      {/* Left panel: retry config form */}
      <div className={styles.leftPanel}>
        <div className={styles.leftHeader}>
          <h3 className={styles.panelTitle}>{t('ui.retryConfig.title')}</h3>
        </div>
        <RetryConfigForm
          config={retryConfig}
          defaults={retryDefaults}
          onSave={onRetryConfigChange}
          embedded
        />
      </div>

      {/* Right panel: proxy stats dashboard */}
      <div className={styles.rightPanel}>
        <ProxyStatsPage embedded />
      </div>
    </div>
  );
}
