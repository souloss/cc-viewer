import React from 'react';

// Feishu/Lark brand glyph — a single-path "send" swoosh (fill=currentColor so it adapts to theme
// / the surrounding text color). Pass a `color` via style for the Feishu brand teal where wanted.
// Single-color by design: the status chip conveys connection state via this glyph's color.
export default function FeishuIcon({ size = 16, className, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}
