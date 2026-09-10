/**
 * Demo accounts — data only.
 *
 * Five accounts, one per role in the canonical model. They live here (not in a
 * component) so the Authentication phase can later replace this file with a
 * Supabase `profiles` table without touching any UI: the login screen only ever
 * talks to the user repository.
 *
 * Passwords are never stored in clear text — each account carries a salt and
 * the two digests `services/password.ts` can compute (see that file for why).
 *
 * Demo password for every account: `alyq1234`
 */
import type { PasswordVerifier } from "./services/password";
import type { AuthUser } from "./types";

export interface AuthUserRecord extends AuthUser {
  verifier: PasswordVerifier;
  /** Shown on the login screen while running without Supabase. */
  demo: true;
}

/** The shared demo password, surfaced on the login card in demo mode. */
export const DEMO_PASSWORD = "alyq1234";

export const DEMO_USERS: AuthUserRecord[] = [
  {
    id: "user-admin",
    username: "admin",
    name: "ALYQ Admin",
    role: "admin",
    demo: true,
    verifier: {
      salt: "s1",
      sha256: "365ebc968fb72525c981f7287fd5c869f7523ccaf2d9cd99993f7293458ee358",
      fallback: "9daf2a4e3de99818",
    },
  },
  {
    id: "user-manager",
    username: "manager",
    name: "Branch Manager",
    role: "manager",
    demo: true,
    verifier: {
      salt: "s2",
      sha256: "cf8eb23543b6097221e685c70baf20beb3e8564681bb074f81fe75854c4b93ec",
      fallback: "64a0bed573054a31",
    },
  },
  {
    id: "user-cashier",
    username: "cashier",
    name: "Cashier One",
    role: "cashier",
    demo: true,
    verifier: {
      salt: "s3",
      sha256: "c776c1eaded87172ccfc6181a88b7e952bb5d82f93d48680e16197837b7b2f57",
      fallback: "98a86fa8a820fc4a",
    },
  },
  {
    id: "user-clerk",
    username: "clerk",
    name: "Inventory Clerk",
    role: "inventory_clerk",
    demo: true,
    verifier: {
      salt: "s4",
      sha256: "fd19b68d96b390b9d1cd65b1e4794b7050373605195fabf3167b5c207bf59349",
      fallback: "82c5764fdd3cae63",
    },
  },
  {
    id: "user-viewer",
    username: "viewer",
    name: "Read-only Viewer",
    role: "viewer",
    demo: true,
    verifier: {
      salt: "s5",
      sha256: "79470d8d98f7e08a4b90dce302520f7e8143ed0777e02ce36f15c372a5a9efbd",
      fallback: "9d6da7921258607c",
    },
  },
];

/** Credentials for the login screen's demo hint (never the digests). */
export const DEMO_CREDENTIAL_HINT: { username: string; role: string }[] = DEMO_USERS.map(
  (user) => ({ username: user.username, role: user.role }),
);
