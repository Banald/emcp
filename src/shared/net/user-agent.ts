/**
 * Single source of truth for the HTTP User-Agent header.
 *
 * Every tool and worker that makes outbound HTTP requests must import
 * `USER_AGENT` from this module. Do not hand-roll per-tool strings; upstreams
 * (notably Wikimedia) require a descriptive UA and a contact URL, and mixing
 * versions/formats across components breaks upstream rate-limit attribution.
 */
export const USER_AGENT = 'eMCP/0.10 (+https://github.com/Banald/emcp)';
