/** Authentication module — public surface. */

export { AuthProvider, useAuth } from "./hooks/AuthProvider";
export type { AuthContextValue } from "./hooks/AuthProvider";
export { LoginRoute, RequireAuth, resolveNextTarget } from "./components/RequireAuth";
export { LoginPage } from "./components/LoginPage";

export {
  LIVE_REFRESH_AHEAD_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_REMEMBER_IDLE_MS,
  adoptProviderSession,
  createSession,
  forgetSession,
  hasActiveSession,
  idleTtlFor,
  isBeyondAbsoluteCap,
  isSessionExpired,
  passwordResetRedirectUrl,
  revalidateSession,
  requestPasswordReset,
  restoreSession,
  sessionFromProvider,
  signIn,
  signOut,
  signOutEverywhere,
  touchSession,
  updatePassword,
  validateSession,
} from "./services/authService";
export {
  AUTH_CHANNEL_NAME,
  AUTH_SIGNAL_KEY,
  broadcastAuth,
  subscribeAuthEvents,
} from "./services/authEvents";
export type { AuthBroadcast } from "./services/authEvents";
export { buildAuthUser, capabilitiesForIdentity, roleOf, usernameToEmail } from "./services/identity";
export type { IdentityInput } from "./services/identity";
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
export {
  createVerifier,
  fallbackDigest,
  hashStrategy,
  randomSalt,
  sha256Digest,
  verifyPassword,
} from "./services/password";
export type { PasswordVerifier } from "./services/password";

export { getAuthMode, getUserRepository, resetAuthRepositories } from "./data";
export { DemoUserRepository, SupabaseUserRepository } from "./data";
export type {
  UserRepository,
  AuthenticateResult,
  AuthUserSummary,
  AuthChangeEvent,
  LiveSessionInfo,
  PasswordUpdateResult,
} from "./data";
export {
  STAFF_STORAGE_KEY,
  findStaffById,
  findStaffByUsername,
  readStaffDirectory,
  removeStaffEntry,
  resetStaffDirectory,
  touchStaffLogin,
  upsertStaffEntry,
  writeStaffDirectory,
} from "./data/staffDirectory";
export type { StaffDirectoryEntry } from "./data/staffDirectory";
export { DEMO_CREDENTIAL_HINT, DEMO_PASSWORD, DEMO_USERS } from "./demoUsers";
export type { AuthUserRecord } from "./demoUsers";

export { AuthError } from "./types";
export type {
  AuthErrorCode,
  AuthSession,
  AuthUser,
  Credentials,
  PasswordResetErrorCode,
  PasswordResetOutcome,
  SessionEndReason,
  SessionPersistence,
  SignInResult,
  StoredSession,
} from "./types";
