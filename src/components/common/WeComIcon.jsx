import React from 'react';

// 企业微信 (WeCom) brand glyph — a single-path chat-bubble mark (fill=currentColor so it adapts to
// theme / the surrounding text color). Pass a `color` via style for the WeCom brand blue where
// wanted. Single-color by design: the status chip conveys connection state via this glyph's color.
export default function WeComIcon({ size = 16, className, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9.5 3C5.36 3 2 5.91 2 9.5c0 2.08 1.13 3.93 2.9 5.13L4 17.5l2.74-1.4c.86.26 1.79.4 2.76.4.27 0 .53-.01.79-.03A5.6 5.6 0 0 1 10 14.5C10 11.46 12.91 9 16.5 9c.35 0 .69.02 1.03.07C16.9 5.6 13.55 3 9.5 3zm-2.6 4.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm5.2 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM16.5 10.5c-3.04 0-5.5 2.02-5.5 4.5s2.46 4.5 5.5 4.5c.7 0 1.37-.1 1.99-.29L20.5 20.5l-.62-1.78A4.9 4.9 0 0 0 22 15c0-2.48-2.46-4.5-5.5-4.5zm-1.85 3a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zm3.7 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7z" />
    </svg>
  );
}
