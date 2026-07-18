import React, { useState, useEffect, useRef } from 'react';
import { Modal, Segmented, Select, InputNumber, Tooltip, Button, message, Spin } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { isMobile } from '../../env';
import { BLUR_MASK_STYLE } from '../../utils/modalMask';
import ConceptHelp from '../common/ConceptHelp';
import styles from './RetryConfigModal.module.css';
import appStyles from '../../App.module.css';
import MobileDrawerCloseButton from '../mobile/MobileDrawerCloseButton';

const MODE_OPTIONS = [
  { label: 'off', value: 'off' },
  { label: 'serial', value: 'serial' },
  { label: 'race', value: 'race' },
  { label: 'stagger', value: 'stagger' },
];

const STATUS_CODE_OPTIONS = [429, 500, 502, 503, 504, 508, 529, 408];

const NUMERIC_FIELDS = [
  { key: 'retryIntervalMs', unit: 'ms', min: 0, max: 600000 },
  { key: 'retryInterval429Ms', unit: 'ms', min: 0, max: 600000 },
  { key: 'maxRetries', unit: '', min: 0, max: 1000 },
  { key: 'maxConcurrent', unit: '', min: 1, max: 100 },
  { key: 'connectTimeoutMs', unit: 'ms', min: 0, max: 600000 },
];

// ─── RetryConfigForm (named export) ──────────────────────────────────────────
// Reusable form component with its own state management. Used inline in
// UnifiedProxyRetryPage (embedded mode) and inside RetryConfigModal (default export).
//
// Props:
//   config     - current retry config object
//   defaults   - default values for reset buttons
//   onSave     - async (formData) => Promise — returns a promise; caller handles success/failure feedback
//   onCancel   - optional close callback (provided by Modal/drawer wrappers; absent in embedded mode)
//   embedded   - when true, hides Cancel button (no modal to close)
export function RetryConfigForm({ config, defaults, onSave, onCancel, embedded }) {
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (config) {
      if (!initializedRef.current) {
        setForm({ ...config });
        initializedRef.current = true;
      } else if (!dirty) {
        // External config change (SSE push) — sync only if user hasn't edited
        setForm({ ...config });
      }
    }
  }, [config, dirty]);

  const def = defaults || {};

  const patch = (key, value) => {
    setDirty(true);
    setForm(prev => (prev ? { ...prev, [key]: value } : prev));
  };

  const resetField = (key) => {
    setDirty(true);
    setForm(prev => (prev ? { ...prev, [key]: def[key] } : prev));
  };

  const resetAll = () => {
    setDirty(true);
    setForm({ ...def });
  };

  const handleSave = async () => {
    if (!form) return;
    if (!['off', 'serial', 'race', 'stagger'].includes(form.mode)) {
      message.warning(t('ui.retryConfig.invalidMode'));
      return;
    }
    try {
      await onSave(form);
      message.success(t('ui.retryConfig.saved'));
      setDirty(false); // allow future SSE syncs
    } catch { /* AppBase shows error toast; keep form open for retry */ }
  };

  const isDirty = (key) => JSON.stringify(form?.[key]) !== JSON.stringify(def[key]);

  const renderResetBtn = (key) => (
    isDirty(key) ? (
      <Tooltip title={t('ui.retryConfig.resetDefault')}>
        <Button type="text" size="small" icon={<UndoOutlined />} onClick={() => resetField(key)} />
      </Tooltip>
    ) : null
  );

  if (!form) {
    return (
      <div className={styles.form} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '40px 0' }}>
        <Spin size="small" />
      </div>
    );
  }

  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <span className={styles.label}>
          {t('ui.retryConfig.mode')}
          {renderResetBtn('mode')}
        </span>
        <Segmented
          size="small"
          value={form.mode || 'off'}
          options={MODE_OPTIONS}
          onChange={v => patch('mode', v)}
        />
        <div className={styles.hint}>{t(`ui.retryConfig.modeHint.${form.mode || 'off'}`)}</div>
      </div>

      <div className={styles.divider} />

      <div className={styles.row}>
        <span className={styles.label}>
          {t('ui.retryConfig.statusCodes')}
          {renderResetBtn('retryStatusCodes')}
        </span>
        <Select
          mode="multiple"
          size="small"
          className={styles.fullWidth}
          value={form.retryStatusCodes || []}
          onChange={v => patch('retryStatusCodes', v.map(Number).filter(n => Number.isFinite(n) && n > 0))}
          options={STATUS_CODE_OPTIONS.map(c => ({ label: String(c), value: c }))}
        />
        <div className={styles.hint}>{t('ui.retryConfig.statusCodesHint')}</div>
      </div>

      <div className={styles.divider} />

      {NUMERIC_FIELDS.map(f => (
        <div className={styles.row} key={f.key}>
          <span className={styles.label}>
            {t(`ui.retryConfig.${f.key}`)}
            {renderResetBtn(f.key)}
          </span>
          <div className={styles.numField}>
            <InputNumber
              size="small"
              value={form[f.key]}
              min={f.min}
              max={f.max}
              onChange={v => patch(f.key, v)}
            />
            {f.unit && <span className={styles.unit}>{f.unit}</span>}
          </div>
        </div>
      ))}

      <div className={styles.row}>
        <span className={styles.label}>
          {t('ui.retryConfig.streamIdleTimeoutMs')}
          <Tooltip title={t('ui.retryConfig.streamIdleReserved')}>
            <span className={styles.reservedTag}>{t('ui.retryConfig.reserved')}</span>
          </Tooltip>
        </span>
        <div className={styles.numField}>
          <InputNumber size="small" value={form.streamIdleTimeoutMs} disabled />
          <span className={styles.unit}>ms</span>
        </div>
      </div>

      <div className={styles.footer}>
        <Button size="small" icon={<UndoOutlined />} onClick={resetAll}>
          {t('ui.retryConfig.resetAll')}
        </Button>
        <div className={styles.footerRight}>
          {!embedded && onCancel && (
            <Button size="small" onClick={onCancel}>{t('ui.retryConfig.cancel')}</Button>
          )}
          <Button size="small" type="primary" onClick={handleSave}>{t('ui.retryConfig.save')}</Button>
        </div>
      </div>

      <div className={styles.note}>{t('ui.retryConfig.note')}</div>
    </div>
  );
}

// ─── RetryConfigModal (default export) ────────────────────────────────────────
// Thin Modal/drawer wrapper around RetryConfigForm. Kept for backward compat:
//   - PC: standalone Modal opened from hamburger menu
//   - Mobile: drawer overlay (cannot be replaced by unified page layout)
export default function RetryConfigModal({
  open,
  onClose,
  config,
  defaults,
  onConfigChange,
}) {
  const titleNode = (
    <span>
      {t('ui.retryConfig.title')}{' '}
      <ConceptHelp doc="RetryConfig" zIndex={1100} />
    </span>
  );

  // Wrap onConfigChange: on success, close the modal/drawer after save
  const handleFormSave = async (formData) => {
    await onConfigChange(formData);
    onClose();
  };

  const bodyNode = (
    <RetryConfigForm
      config={config}
      defaults={defaults}
      onSave={handleFormSave}
      onCancel={onClose}
    />
  );

  if (isMobile) {
    return (
      <div className={`${appStyles.mobileDrawerOverlay} ${open ? appStyles.mobileDrawerOverlayVisible : ''}`}>
        <div className={appStyles.mobileLogMgmtHeader}>
          <span className={appStyles.mobileLogMgmtTitle}>{titleNode}</span>
          <MobileDrawerCloseButton onClose={onClose} />
        </div>
        <div className={appStyles.mobileDrawerInner}>
          <div className={styles.scroll}>
            {bodyNode}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Modal
      title={titleNode}
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      styles={{ body: isMobile ? { zoom: 0.6 } : {}, mask: BLUR_MASK_STYLE }}
    >
      {bodyNode}
    </Modal>
  );
}
