import React, { useState, useEffect } from 'react';
import { Modal, Input, Switch, Spin, message } from 'antd';
import { t } from '../../i18n';
import { apiUrl } from '../../utils/apiUrl';
import styles from './SystemTextModal.module.css';

// 「系统文本修改」模态（偏好设置 → 专家设置）。self-contained：打开时自取、保存时自存。
// 写当前工作区的 CC_SYSTEM.md(覆盖) / CC_APPEND_SYSTEM.md(追加)，由 ccv 在下次启动 claude 时
// 注入为 --system-prompt-file / --append-system-prompt-file。两模式互斥：保存某模式即清掉另一份；
// 空文本保存 = 关闭（删两份）。
export default function SystemTextModal({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState('');
  const [override, setOverride] = useState(false); // false=追加(默认)，true=覆盖
  const [dir, setDir] = useState(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false; // 关闭/卸载后丢弃在途响应，避免对已卸载组件 setState
    setLoading(true);
    fetch(apiUrl('/api/expert/system-text'))
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setText(d.text || '');
        setOverride(d.mode === 'override');
        setDir(d.dir || null);
        setActive(!!d.active);
      })
      .catch(() => { if (!cancelled) message.error(t('ui.expert.systemText.loadError')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const handleSave = () => {
    setSaving(true);
    fetch(apiUrl('/api/expert/system-text'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: override ? 'override' : 'append', text }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.error) { message.error(t('ui.expert.systemText.saveError')); return; }
        message.success(d && d.cleared ? t('ui.expert.systemText.cleared') : t('ui.expert.systemText.saved'));
        onClose && onClose();
      })
      .catch(() => message.error(t('ui.expert.systemText.saveError')))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={t('ui.expert.systemText')}
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText={t('ui.save')}
      cancelText={t('ui.cancel')}
      okButtonProps={{ loading: saving, disabled: !active }}
      width={620}
      zIndex={1100}
    >
      <Spin spinning={loading}>
        <div className={styles.modeRow}>
          <Switch
            checked={override}
            onChange={setOverride}
            checkedChildren={t('ui.expert.systemText.override')}
            unCheckedChildren={t('ui.expert.systemText.append')}
            disabled={!active}
          />
        </div>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('ui.expert.systemText.placeholder')}
          autoSize={{ minRows: 8, maxRows: 20 }}
          disabled={!active}
        />
        {active ? (
          <div className={styles.hint}>
            <div className={styles.dirLine}>{t('ui.expert.systemText.dirHint').replace('{dir}', dir || '')}</div>
            <div>{t('ui.expert.systemText.note')}</div>
          </div>
        ) : (
          <div className={styles.warn}>{t('ui.expert.systemText.noWorkspace')}</div>
        )}
      </Spin>
    </Modal>
  );
}
