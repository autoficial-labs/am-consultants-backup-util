export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_ENV: string;
  SESSION_DAYS: string;
  /** Secret used once to create the super-admin, and to reset its password if it is lost. */
  SETUP_KEY?: string;
  /** Set by the desktop app's built-in server setup: which packed Worker build is running. */
  SERVER_BUILD?: string;
};

export type Role = 'superadmin' | 'user';
export type Access = 'read' | 'write';
export type ScopeMode = 'all' | 'include' | 'exclude' | 'none';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  access: Access;
  scopeMode: ScopeMode;
  paths: string[];
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; tokenHash: string };
};

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  access: Access;
  scope_mode: ScopeMode;
  disabled: number;
  failed_logins: number;
  locked_until: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}
