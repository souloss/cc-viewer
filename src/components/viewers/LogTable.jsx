import React, { useMemo } from 'react';
import { Table, Checkbox, Button, Tag, Popover } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { t } from '../../i18n';
import { formatSize, formatTimestamp } from '../../utils/formatters';
import styles from '../../App.module.css';

const EMPTY_SET = new Set();

function LogTable({ logs, mobile, selectedLogs = EMPTY_SET, onToggleSelect, onOpenLog, onDownloadLog }) {
  const columns = useMemo(() => [
    {
      title: '',
      dataIndex: 'file',
      key: 'check',
      width: 40,
      fixed: mobile ? 'left' : false,
      // v2 session rows are not selectable: selection feeds delete, which does
      // not apply to v2 dirs before S6a (soft-delete work).
      render: (file, log) => log.kind === 'v2' ? null : (
        <Checkbox
          checked={selectedLogs.has(file) || false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(file, e.target.checked); }}
        />
      ),
    },
    {
      title: t('ui.logTime'),
      dataIndex: 'timestamp',
      key: 'time',
      width: mobile ? 150 : 180,
      render: (ts) => <span className={styles.tableTimestampCell}>{formatTimestamp(ts, mobile)}</span>,
    },
    // 实例归属(pid)列：仅桌面端（移动端列宽紧张，沿用 turns 列同款 !mobile 守卫）。
    // 无 pid 的无标签日志该列留空。
    ...(!mobile ? [{
      title: t('ui.logInstanceId'),
      dataIndex: 'instanceId',
      key: 'instanceId',
      width: 90,
      render: (id) => id ? <Tag className={styles.tableTag}>{id}</Tag> : null,
    }] : []),
    {
      title: t('ui.logPreview'),
      dataIndex: 'preview',
      key: 'preview',
      width: mobile ? 150 : undefined,
      ellipsis: true,
      render: (arr, log) => {
        // v2 会话行在 preview 列前缀 "v2" tag：preview 为空时单独显示，有内容时与
        // 文本并排（列表切换开关下两种源可能被来回对照，行内需自明）。
        const v2Tag = log.kind === 'v2'
          ? <Tag className={styles.tableTag} style={{ marginRight: 6 }}>v2</Tag>
          : null;
        if (!Array.isArray(arr) || arr.length === 0) {
          return v2Tag || '—';
        }
        const first = arr[0];
        // 防 server 偶发返回 [null] / [undefined] / [number] — 强制 string 才用作 displayText
        if (typeof first !== 'string') return v2Tag || '—';
        const displayText = (first.length <= 30 && arr.length > 1) ? `${first} | ${arr[1]}` : first;
        if (arr.length <= 1) return <span className={styles.tablePreviewText}>{v2Tag}{displayText}</span>;
        return (
          <Popover
            trigger={mobile ? 'click' : 'hover'}
            placement={mobile ? 'bottomLeft' : 'leftTop'}
            autoAdjustOverflow={{ adjustX: false, adjustY: true }}
            overlayInnerStyle={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-hover)',
              borderRadius: 8,
              padding: 0,
              maxHeight: 400,
              overflowY: 'auto',
            }}
            content={
              <div className={styles.previewPopover}>
                {arr.map((text, i) => (
                  <div key={i} className={styles.previewItem}>
                    <pre className={styles.previewText}>{text}</pre>
                  </div>
                ))}
              </div>
            }
          >
            <span className={styles.tablePreviewTextClickable} style={{ textDecoration: mobile ? 'underline dotted #666' : 'none' }}>{v2Tag}{displayText}</span>
          </Popover>
        );
      },
    },
    {
      title: t('ui.logSize'),
      dataIndex: 'size',
      key: 'size',
      width: 90,
      render: (v) => <Tag className={styles.tableTag}>{formatSize(v)}</Tag>,
    },
    {
      title: t('ui.logActions'),
      key: 'actions',
      width: mobile ? 120 : 130,
      render: (_, log) => (
        <span className={styles.tableActionsCell}>
          <Button size="small" type="primary" onClick={(e) => { e.stopPropagation(); onOpenLog(log.file); }}>
            {t('ui.openLog')}
          </Button>
          <Button size="small" icon={<DownloadOutlined />} title={t('ui.downloadLog')} onClick={(e) => { e.stopPropagation(); onDownloadLog(log.file); }} />
        </span>
      ),
    },
  ], [mobile, selectedLogs, onToggleSelect, onOpenLog, onDownloadLog]);

  return (
    <Table
      size="small"
      dataSource={logs}
      columns={columns}
      rowKey="file"
      pagination={false}
      scroll={mobile ? { x: 'max-content', y: 'calc(100vh - 160px)' } : { y: 400 }}
      onRow={(log) => ({
        onClick: () => {
          if (log.kind === 'v2') return; // v2 rows carry no selection (see check column)
          const checked = !selectedLogs.has(log.file);
          onToggleSelect(log.file, checked);
        },
        style: { cursor: log.kind === 'v2' ? 'default' : 'pointer' },
      })}
    />
  );
}

export default LogTable;
