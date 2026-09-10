/** Authentication module — public surface. */

export { AuthProvider, useAuth } from "./hooks/AuthProvider";
export type { AuthContextValue } from "./hooks/AuthProvider";
export { LoginRoute, RequireAuth, resolveNextTarget } from "./components/RequireAuth";
export { LoginPage } from "./components/LoginPage";

export {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_REMEMBER_IDLE_MS,
  createSession,
  hasActiveSession,
  idleTtlFor,
  isSessionExpired,
  restoreSession,
  signIn,
  signOut,
  touchSession,
  validateSession,
} from "./services/authService";
export {
  ANONYMOUS_USER,
  SESSION_STORAGE_KEY,
  clearStoredSession,
  getCurrentAuthUser,
  primeCacheFromStorage,
  readStoredSession,
  resetSessionCache,
  writeStoredSession,
} from "./services/sessionStore";
export { fallbackDigest, hashStrategy, sha256Digest, verifyPassword } from "./services/password";
export type { PasswordVerifier } from "./services/password";

export { getAuthMode, getUserRepository } from "./data";
export { DemoUserRepository, SupabaseUserRepository } from "./data";
export type { UserRepository, AuthenticateResult, AuthUserSummary } from "./data";
export { DEMO_CREDENTIAL_HINT, DEMO_PASSWORD, DEMO_USERS } from "./demoUsers";
export type { AuthUserRecord } from "./demoUsers";

export { AuthError } from "./types";
export type {
  AuthErrorCode,
  AuthSession,
  AuthUser,
  Credentials,
  SessionEndReason,
  SessionPersistence,
  SignInResult,
  StoredSession,
} from "./types";
