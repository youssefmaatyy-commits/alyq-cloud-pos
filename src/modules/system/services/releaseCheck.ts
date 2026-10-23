export const RELEASES_API_URL = "https://api.github.com/repos/youssefmaatyy-commits/alyq-cloud-pos/releases/latest";
export const OFFICIAL_RELEASES_URL = "https://github.com/youssefmaatyy-commits/alyq-cloud-pos/releases/latest";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type ParsedVersion = { major: number; minor: number; patch: number; pre: string[] | null };

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version.trim().replace(/^v/i, ""));
  if (!match) return null;
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : null,
  };
}

/** SemVer precedence; invalid tags never become an update. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export interface LatestRelease {
  version: string;
  url: string;
}

/** Read only the pinned public GitHub release endpoint; never executes or installs assets. */
export async function fetchLatestRelease(fetcher: typeof fetch = fetch): Promise<LatestRelease> {
  const response = await fetcher(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("GitHub returned an invalid release response");
  const tag = (payload as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string") throw new Error("GitHub release has no version tag");
  const version = tag.trim().replace(/^v/i, "");
  if (!parseVersion(version)) throw new Error("GitHub release version is not valid SemVer");
  return { version, url: OFFICIAL_RELEASES_URL };
}
