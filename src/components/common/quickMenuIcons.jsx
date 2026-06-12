// 四芒星快捷设置菜单共用图标 —— TerminalPanel 终端工具栏与 ChatInputBar 对话输入框
// 两处「同款菜单」共享，单一事实源防止迭代漂移。全部为零依赖纯 SVG 组件；
// 菜单行内尺寸由共享样式 .quickMenuRowIcon svg { 14px } 统一约束。

// 快捷设置按钮图标：纤细四芒星（凹弧四角，实心）。
// 菜单打开时整体旋转 45° 变为斜向星，作为开合状态反馈。
export function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
      <path d="M12 0.5 C12.4 9 15 11.6 23.5 12 C15 12.4 12.4 15 12 23.5 C11.6 15 9 12.4 0.5 12 C9 11.6 11.6 9 12 0.5 Z" />
    </svg>
  );
}

// 菜单行图标：权限自动审批（盾牌+对勾）
export function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

// 菜单行图标：Plan 自动审批（剪贴板）
export function PlanClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}

export function AgentTeamIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function UltraplanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2.5"/>
      <ellipse cx="12" cy="12" rx="10" ry="4"/>
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>
    </svg>
  );
}

export function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
