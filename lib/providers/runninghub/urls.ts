/**
 * RunningHub speaks from **two different URL prefixes**, and mixing them up fails in a
 * way that reads like something else entirely.
 *
 *   - the workflow API lives under `/openapi/v2`
 *     (`/openapi/v2/run/workflow/<id>`, `/openapi/v2/query`, `/openapi/v2/media/upload/binary`);
 *   - the "old" site-root API lives at the site root
 *     (`/task/openapi/cancel`, `/task/openapi/outputs`, `/api/webapp/apiCallDemo`).
 *
 * Measured 2026-10-04 while adding real task cancellation: POSTing to
 * `/openapi/v2/task/openapi/cancel` answers HTTP 200 with
 *
 *     {"errorCode":"1001","errorMessage":"Invalid URL, please check your link …"}
 *
 * — a reply that looks like a broken endpoint rather than a wrong prefix. `webapp.ts`
 * already carried this lesson in its header comment; this module is that rule in one
 * place so a third caller cannot invent a third regex.
 *
 * Dependency-free on purpose: it is compiled to CJS and unit-tested on its own
 * (`C:/FRAME/_test-cancel-plan.py`).
 */

/** The workflow API prefix. Stripped when a site-root endpoint is wanted. */
export const RUNNINGHUB_WORKFLOW_PREFIX = '/openapi/v2';

/**
 * The site root for a given base url.
 *
 * `baseUrl` (per-user site, see `connection.ts`) wins; `fallback` is the site default.
 * Trailing slashes and the `/openapi/v2` suffix are both removed — feeding a
 * `/openapi/v2`-style base into a site-root endpoint is the trap described above.
 */
export function runningHubSiteHost(baseUrl?: string, fallback?: string): string {
  const raw = String(baseUrl ?? '').trim() || String(fallback ?? '').trim();
  return raw.replace(/\/+$/, '').replace(/\/openapi\/v2\/?$/, '');
}
