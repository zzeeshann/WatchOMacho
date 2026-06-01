/**
 * Lab HTML validator — sandbox-safety gate for the LAB piece.
 *
 * Ported verbatim from Daylila's interactive-validator.ts (the lab moved into
 * WatchOMacho 2026-06-01). The lab runs inside `<iframe sandbox="allow-scripts">`
 * (no allow-same-origin) on the Daylila reader. This is the ONLY code-side gate
 * between the model's HTML output and the reader. It checks sandbox-safety + a
 * size cap; it does NOT judge teaching quality (that's the contract's job).
 *
 * Pure functions, no I/O.
 */

export interface Violation {
  rule: string;
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  violations: Violation[];
}

/** Inline byte cap on the HTML (excludes cdnjs libs loaded via <script src>). */
const MAX_INLINE_BYTES = 50_000;

/** cdnjs libraries the validator allows via <script src>. */
const ALLOWED_SCRIPT_HOSTS = ["cdnjs.cloudflare.com"];

const ALLOWED_LIBS = [
  "d3", "three", "pixi", "p5", "tone", "gsap", "plotly", "howler", "anime",
];

/**
 * Validate a single-file HTML lab for sandbox safety + size.
 * Returns { passed, violations[] }.
 */
export function validateLab(html: string): ValidationResult {
  const violations: Violation[] = [];

  // 1. Size cap (inline bytes).
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_INLINE_BYTES) {
    violations.push({
      rule: "size-cap",
      message: `HTML is ${bytes} bytes, over the ${MAX_INLINE_BYTES}-byte inline cap.`,
    });
  }

  // 2. Storage APIs (sandbox throws on access).
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(html)) {
    violations.push({
      rule: "storage-api",
      message: "Uses localStorage / sessionStorage / indexedDB — throws under sandbox.",
    });
  }

  // 3. Dynamic code execution.
  if (/\beval\s*\(/.test(html) || /new\s+Function\s*\(/.test(html)) {
    violations.push({
      rule: "dynamic-code",
      message: "Uses eval() or new Function() — blocked + bad practice.",
    });
  }
  // string-form setTimeout/setInterval
  if (/set(?:Timeout|Interval)\s*\(\s*['"`]/.test(html)) {
    violations.push({
      rule: "dynamic-code",
      message: "Uses string-form setTimeout/setInterval — implicit eval.",
    });
  }

  // 4. Network calls (everything must ship in the file).
  if (
    /\bfetch\s*\(/.test(html) ||
    /XMLHttpRequest/.test(html) ||
    /\bWebSocket\s*\(/.test(html) ||
    /\bEventSource\s*\(/.test(html) ||
    /navigator\s*\.\s*sendBeacon/.test(html)
  ) {
    violations.push({
      rule: "network-call",
      message: "Makes a network call (fetch/XHR/WebSocket/EventSource/sendBeacon).",
    });
  }

  // 5. Nested iframes.
  if (/<iframe\b/i.test(html)) {
    violations.push({ rule: "nested-iframe", message: "Contains a nested <iframe>." });
  }

  // 6. Form elements (sandbox disallows submission).
  if (/<form\b/i.test(html)) {
    violations.push({
      rule: "form-element",
      message: "Contains a <form> — submission is sandbox-blocked.",
    });
  }

  // 7. Unsafe URL schemes in src/href.
  if (/(?:src|href)\s*=\s*['"]?\s*(?:data|blob):/i.test(html)) {
    violations.push({
      rule: "unsafe-url-scheme",
      message: "Uses data:/blob: URL in src/href.",
    });
  }

  // 8. External scripts — only cdnjs + allowlisted libs.
  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi)];
  for (const m of scriptSrcs) {
    const src = m[1];
    let url: URL | null = null;
    try {
      url = new URL(src);
    } catch {
      violations.push({
        rule: "external-script-allowlist",
        message: `Script src "${src}" is not an absolute https cdnjs URL.`,
      });
      continue;
    }
    if (url.protocol !== "https:" || !ALLOWED_SCRIPT_HOSTS.includes(url.hostname)) {
      violations.push({
        rule: "external-script-allowlist",
        message: `Script src host "${url.hostname}" not allowed (cdnjs only).`,
      });
      continue;
    }
    const path = url.pathname.toLowerCase();
    const ok = ALLOWED_LIBS.some((lib) => path.includes(`/${lib}`) || path.includes(`${lib}.`));
    if (!ok) {
      violations.push({
        rule: "external-script-allowlist",
        message: `Script "${src}" is not an allowlisted library.`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
