import React, { useState, useEffect } from 'react';
import { message } from 'antd';
import SkillsManagerModal from './SkillsManagerModal';
import { apiUrl } from '../../utils/apiUrl';
import { imTr as _tr } from '../../utils/imTr';

// 「${IM} SKILL 管理」的管理弹窗：加载该 IM 的 skills（GET /api/im/:platform/skills），复用 SkillsManagerModal
// 渲染启停开关；toggle → POST /api/im/:platform/skills/toggle（乐观更新 + 失败回滚，参照 AppHeader.handleToggleSkill）。
// SkillsManagerModal 自带 zIndex 1100，会叠在配置弹窗之上、不关闭下层。reloadKey 变化（外部新增 skill 后）→ 重新拉取。
export default function ImSkillsModal({ open, platform, reloadKey, onClose }) {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toggling, setToggling] = useState(() => new Set());

  useEffect(() => {
    if (!open || !platform) return undefined;
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(apiUrl(`/api/im/${encodeURIComponent(platform)}/skills`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http:${r.status}`))))
      .then((d) => { if (!cancelled) setSkills(Array.isArray(d.skills) ? d.skills : []); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || 'load_failed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, platform, reloadKey]);

  const onToggle = async (skill) => {
    const enable = !skill.enabled;
    const key = `${skill.source}-${skill.name}`; // KEEP dash — SkillsManagerModal checks `${source}-${name}`
    const same = (s) => s.name === skill.name && s.source === skill.source;
    setToggling((prev) => new Set(prev).add(key));
    setSkills((prev) => prev.map((s) => (same(s) ? { ...s, enabled: enable } : s))); // 乐观
    try {
      const r = await fetch(apiUrl(`/api/im/${encodeURIComponent(platform)}/skills/toggle`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: skill.name, enable }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || `http:${r.status}`), { code: j.code }); }
      message.success(_tr('ui.im.skillsRestartHint', null, 'Updated — takes effect after you restart this IM'));
    } catch (e) {
      setSkills((prev) => prev.map((s) => (same(s) ? { ...s, enabled: !enable } : s))); // 回滚
      message.error(e?.code === 'DEST_CONFLICT'
        ? _tr('ui.skillToggleConflict', { name: skill.name }, 'A duplicate already exists; clean up and retry')
        : _tr('ui.skillToggleFailed', { reason: e?.message || '' }, 'Toggle failed'));
    } finally {
      setToggling((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  return (
    <SkillsManagerModal open={open} onClose={onClose} loading={loading} error={error} skills={skills} toggling={toggling} onToggle={onToggle} />
  );
}
