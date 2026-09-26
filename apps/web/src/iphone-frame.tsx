/**
 * An iPhone 17 Pro, drawn by the window around a phone screen (#101).
 *
 * The screen is the child: a sandboxed frame of the one section the designer
 * marked as a phone surface, at the phone's own width. The device — body,
 * buttons, status bar, Dynamic Island, home indicator — is the window's, so
 * every phone design is reviewed in the same phone, and the designer draws
 * none of it. Content taller than the screen scrolls inside it, the way the
 * real one does.
 */
import type { ReactNode } from "react";

/** The logical screen, in CSS pixels. */
export const IPHONE_17_PRO = { name: "iPhone 17 Pro", width: 402, height: 874 } as const;

export function IPhoneFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="iphone" aria-label={`${title}, on an ${IPHONE_17_PRO.name}`}>
      <div className="iphone-body">
        <span className="iphone-button iphone-button-action" aria-hidden="true" />
        <span className="iphone-button iphone-button-up" aria-hidden="true" />
        <span className="iphone-button iphone-button-down" aria-hidden="true" />
        <span className="iphone-button iphone-button-side" aria-hidden="true" />
        <div className="iphone-screen">
          <div className="iphone-status" aria-hidden="true">
            <span className="iphone-time">9:41</span>
            <span className="iphone-island" />
            <svg className="iphone-indicators" viewBox="0 0 78 14" width="78" height="14">
              <rect x="0" y="9" width="3" height="5" rx="1" />
              <rect x="5" y="7" width="3" height="7" rx="1" />
              <rect x="10" y="4" width="3" height="10" rx="1" />
              <rect x="15" y="1" width="3" height="13" rx="1" />
              <path d="M24 5.5a11 11 0 0 1 15 0l-1.6 1.7a8.7 8.7 0 0 0-11.8 0zM26.9 8.6a7 7 0 0 1 9.2 0l-1.6 1.7a4.7 4.7 0 0 0-6 0zM29.8 11.6a3 3 0 0 1 3.4 0L31.5 14z" />
              <rect x="47" y="1" width="26" height="12" rx="3.5" fill="none" strokeWidth="1.2" />
              <rect x="49" y="3" width="22" height="8" rx="2" />
              <rect x="74.5" y="4.5" width="2" height="5" rx="1" />
            </svg>
          </div>
          <div className="iphone-content">{children}</div>
          <span className="iphone-home" aria-hidden="true" />
        </div>
      </div>
      <figcaption className="iphone-caption">{title}</figcaption>
    </figure>
  );
}
