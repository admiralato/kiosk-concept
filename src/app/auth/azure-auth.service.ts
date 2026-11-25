import { Injectable, computed, signal } from '@angular/core';
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from '@azure/msal-browser';
import type { AzureAuthConfig } from '../wayfinding/kiosk-config';

export type AuthStatus =
  | 'initializing'
  | 'authenticated'
  | 'login-required'
  | 'reauth-required'
  | 'disabled'
  | 'error';

export type AuthProvider = 'azure-ad' | 'local' | 'demo';

export interface AuthenticatedUser {
  name: string;
  email: string;
  initials: string;
  tenantId: string;
  objectId: string;
  provider: AuthProvider;
}

interface StoredLocalSession {
  provider: 'local' | 'demo';
  accessToken: string;
  user: AuthenticatedUser;
  signedInAt: number;
}

const SAVED_KIOSK_QUERY_KEY = 'spaceboard_pending_kiosk_search';
const SIGNED_OUT_FLAG_KEY = 'spaceboard_explicit_signout';
const SIGNED_OUT_BROADCAST_KEY = 'spaceboard_signout_broadcast';
const LOCAL_SESSION_STORAGE_KEY = 'spaceboard_local_auth_session';

/** Built-in hardcoded demo credential (controlled by `auth.local.demoLoginEnabled` in `kiosk-config.json`). */
export const DEMO_LOGIN_USERNAME = 'demo';
export const DEMO_LOGIN_PASSWORD = 'demo123';

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return (name.trim().slice(0, 2) || 'SB').toUpperCase();
}

/**
 * Unified Authentication Service for SpaceBoard PC.
 *
 * Supports two login options configured at runtime in `data/kiosk-config.json`:
 * 1. **Azure AD (Microsoft Entra ID)** — OAuth 2.0 (Authorization Code + PKCE) + OpenID Connect
 *    via `@azure/msal-browser` Redirect flow, with silent token revalidation and Microsoft Graph access.
 * 2. **Local User Database (Username & Password)** — Configurable Backend API endpoints
 *    (`auth.local.loginUrl`, `validateUrl`, `logoutUrl`) plus an optional built-in `demo` / `demo123`
 *    credential (`auth.local.demoLoginEnabled: true`) for testing before the API is deployed.
 */
@Injectable({ providedIn: 'root' })
export class AzureAuthService {
  private msal: PublicClientApplication | null = null;
  private config: AzureAuthConfig | null = null;
  private revalidateTimer?: ReturnType<typeof setInterval>;
  private revalidating = false;
  private focusListenerBound = false;

  readonly status = signal<AuthStatus>('initializing');
  readonly provider = signal<AuthProvider | null>(null);
  readonly account = signal<AccountInfo | null>(null);
  readonly localSession = signal<StoredLocalSession | null>(null);
  readonly error = signal<string | null>(null);
  readonly statusMessage = signal<string>('Checking session...');
  readonly lastValidatedAt = signal<Date | null>(null);
  readonly submittingLocalLogin = signal(false);

  readonly isAuthenticated = computed(
    () => this.status() === 'authenticated' || this.status() === 'disabled',
  );

  /** True when the user is signed in with Microsoft Entra ID (enables delegated Microsoft Graph calls). */
  readonly isAzureAdAuthenticated = computed(
    () => this.status() === 'authenticated' && this.provider() === 'azure-ad',
  );

  readonly azureAdEnabled = computed(
    () => !!(this.config?.enabled && this.config?.clientId?.trim() && this.config?.tenantId?.trim()),
  );

  readonly localAuthEnabled = computed(() => !!(this.config?.enabled && this.config?.local?.enabled));

  readonly demoLoginEnabled = computed(
    () => !!(this.config?.enabled && this.config?.local?.enabled && this.config?.local?.demoLoginEnabled),
  );

  readonly user = computed<AuthenticatedUser | null>(() => {
    const local = this.localSession();
    if (local) return local.user;

    const acc = this.account();
    if (!acc) return null;
    const name = acc.name?.trim() || acc.username || 'Signed-in User';
    const email = acc.username || '';
    return {
      name,
      email,
      initials: computeInitials(name),
      tenantId: acc.tenantId || '',
      objectId: acc.localAccountId || '',
      provider: 'azure-ad',
    };
  });

  private readonly handleVisibilityOrFocus = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.status() === 'authenticated') {
      void this.revalidateSession(true);
    }
  };

  /** Immediately shows the Sign-In modal if the user signs out in another tab of the same browser. */
  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (this.status() !== 'authenticated') return;
    if (event.key === SIGNED_OUT_BROADCAST_KEY && event.newValue) {
      this.requireSignIn('You have been signed out. Please sign in again to continue.');
      return;
    }
    if (event.key === LOCAL_SESSION_STORAGE_KEY && !event.newValue && this.localSession()) {
      this.requireSignIn('You have been signed out. Please sign in again to continue.');
      return;
    }
    if (this.msal && this.provider() === 'azure-ad' && (!event.key || event.key.startsWith('msal.'))) {
      const remaining = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
      if (!remaining) {
        this.requireSignIn('You have been signed out. Please sign in again to continue.');
      }
    }
  };

  /**
   * Initializes authentication from runtime `kiosk-config.json`, restores any existing
   * Local/Demo or Azure AD session, and validates it silently.
   */
  async initialize(authConfig: AzureAuthConfig): Promise<boolean> {
    this.config = authConfig;
    this.error.set(null);

    const hasAzure = !!(authConfig.clientId?.trim() && authConfig.tenantId?.trim());
    const hasLocal = !!authConfig.local?.enabled;

    if (!authConfig.enabled || (!hasAzure && !hasLocal)) {
      this.status.set('disabled');
      return true;
    }

    try {
      this.status.set('initializing');
      this.statusMessage.set('Checking active session...');

      // Initialize MSAL if Azure AD is configured
      if (hasAzure) {
        const baseRedirectUri =
          authConfig.redirectUri?.trim() ||
          `${window.location.origin}${window.location.pathname}`;
        const postLogoutRedirectUri = authConfig.postLogoutRedirectUri?.trim() || baseRedirectUri;

        const msalConfig: Configuration = {
          auth: {
            clientId: authConfig.clientId.trim(),
            authority: `https://login.microsoftonline.com/${authConfig.tenantId.trim()}`,
            redirectUri: baseRedirectUri,
            postLogoutRedirectUri,
          },
          cache: {
            cacheLocation: 'localStorage',
          },
        };

        this.msal = new PublicClientApplication(msalConfig);
        await this.msal.initialize();

        // 1. Handle return from Azure AD loginRedirect
        const redirectResult = await this.msal.handleRedirectPromise();
        this.restoreKioskQueryAfterRedirect();

        if (redirectResult?.account) {
          this.clearExplicitSignOutFlag();
          this.clearStoredLocalSession();
          this.activateAzureAccount(redirectResult.account);
          return true;
        }
      }

      // If the user explicitly clicked Sign Out, show the Sign-In modal immediately
      if (this.consumeExplicitSignOutFlag()) {
        this.status.set('login-required');
        this.statusMessage.set('You have been signed out. Sign in to continue.');
        return false;
      }

      // 2. Check existing local / demo session in localStorage
      const savedLocal = this.readStoredLocalSession();
      if (savedLocal) {
        if (savedLocal.provider === 'demo' && !authConfig.local?.demoLoginEnabled) {
          this.clearStoredLocalSession();
        } else {
          this.statusMessage.set('Validating your session...');
          const stillValid = await this.validateLocalSession(savedLocal);
          if (stillValid) {
            this.activateLocalSession(savedLocal);
            return true;
          }
          this.clearStoredLocalSession();
          this.requireReauthentication('Your session expired or was signed out. Please sign in again.');
          return false;
        }
      }

      // 3. Existing cached Azure AD account -> silently revalidate with Entra ID (forceRefresh: true)
      if (this.msal) {
        const existing = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
        if (existing) {
          this.statusMessage.set('Validating your Microsoft session...');
          this.msal.setActiveAccount(existing);
          const stillValid = await this.revalidateSession(true, existing);
          if (stillValid) {
            this.activateAzureAccount(existing);
            return true;
          }
          return false;
        }

        // 4. Attempt silent SSO if browser already has an Entra ID session
        try {
          this.statusMessage.set('Checking existing Microsoft single sign-on...');
          const ssoResult = await this.msal.ssoSilent({
            scopes: authConfig.scopes,
          });
          if (ssoResult?.account) {
            this.activateAzureAccount(ssoResult.account);
            return true;
          }
        } catch {
          // Expected when user has not signed in yet; show Sign-In modal.
        }
      }

      this.status.set('login-required');
      this.statusMessage.set('Sign in to access SpaceBoard PC.');
      return false;
    } catch (err) {
      console.error('Authentication initialization error:', err);
      const message = err instanceof Error ? err.message : String(err);
      this.error.set(message);
      this.status.set('error');
      return false;
    }
  }

  /** Starts the interactive Azure AD OAuth 2.0 + OIDC Redirect login flow. */
  async login(): Promise<void> {
    if (!this.msal || !this.config) return;
    this.error.set(null);
    this.clearExplicitSignOutFlag();
    this.saveKioskQueryBeforeRedirect();

    const isReauth = this.status() === 'reauth-required';
    await this.msal.loginRedirect({
      scopes: this.config.scopes,
      prompt: isReauth ? 'login' : 'select_account',
    });
  }

  /**
   * Signs in with Username & Password using either:
   * - The built-in hardcoded Demo credential (`demo` / `demo123`) when `auth.local.demoLoginEnabled` is true
   * - Your configured Backend API (`auth.local.loginUrl`) when set in `data/kiosk-config.json`
   */
  async loginWithCredentials(username: string, password: string): Promise<boolean> {
    if (!this.config?.local?.enabled) {
      this.error.set('Username & password login is disabled in kiosk-config.json.');
      return false;
    }

    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      this.error.set('Please enter both username and password.');
      return false;
    }

    this.error.set(null);
    this.submittingLocalLogin.set(true);

    try {
      // 1. Built-in hardcoded demo login (for demo / offline testing)
      if (
        this.config.local.demoLoginEnabled &&
        cleanUser.toLowerCase() === DEMO_LOGIN_USERNAME &&
        password === DEMO_LOGIN_PASSWORD
      ) {
        const demoSession: StoredLocalSession = {
          provider: 'demo',
          accessToken: 'demo-local-token',
          signedInAt: Date.now(),
          user: {
            name: 'Demo User',
            email: 'demo@spaceboard.local',
            initials: 'DU',
            tenantId: 'local-demo',
            objectId: 'demo-user',
            provider: 'demo',
          },
        };
        this.clearExplicitSignOutFlag();
        this.activateLocalSession(demoSession);
        return true;
      }

      // 2. Configurable Backend API local user database login
      const loginUrl = this.config.local.loginUrl?.trim();
      if (!loginUrl) {
        this.error.set(
          this.config.local.demoLoginEnabled
            ? `Invalid credentials. Local Auth API is not configured yet — use "${DEMO_LOGIN_USERNAME}" / "${DEMO_LOGIN_PASSWORD}" for demo login.`
            : 'Local authentication API endpoint (auth.local.loginUrl) is not configured in data/kiosk-config.json.',
        );
        return false;
      }

      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUser, password }),
      });

      if (!res.ok) {
        let msg = `Sign-in failed (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { message?: string; error?: string };
          if (body.message || body.error) msg = body.message || body.error!;
        } catch {
          // Ignore non-JSON error body
        }
        this.error.set(msg);
        return false;
      }

      const data = (await res.json()) as {
        accessToken?: string;
        token?: string;
        user?: { id?: string; name?: string; displayName?: string; email?: string; username?: string };
      };

      const token = data.accessToken || data.token || '';
      const displayName =
        data.user?.name?.trim() ||
        data.user?.displayName?.trim() ||
        data.user?.username?.trim() ||
        cleanUser;
      const email = data.user?.email?.trim() || (cleanUser.includes('@') ? cleanUser : '');

      const session: StoredLocalSession = {
        provider: 'local',
        accessToken: token,
        signedInAt: Date.now(),
        user: {
          name: displayName,
          email,
          initials: computeInitials(displayName),
          tenantId: 'local-db',
          objectId: data.user?.id || cleanUser,
          provider: 'local',
        },
      };

      this.clearExplicitSignOutFlag();
      this.activateLocalSession(session);
      return true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Unable to reach authentication server.');
      return false;
    } finally {
      this.submittingLocalLogin.set(false);
    }
  }

  /** Signs the user out (handles Azure AD redirect logout and Local/Demo logout cleanly). */
  async logout(): Promise<void> {
    const activeProvider = this.provider();
    const currentLocal = this.localSession();

    this.stopRevalidationLoop();
    this.account.set(null);
    this.localSession.set(null);
    this.provider.set(null);
    this.clearStoredLocalSession();
    this.error.set(null);
    this.statusMessage.set('You have been signed out. Sign in to continue.');
    this.status.set('login-required');
    this.markExplicitSignOut();

    // Local API logout (best-effort)
    if (activeProvider === 'local') {
      const logoutUrl = this.config?.local?.logoutUrl?.trim();
      if (logoutUrl) {
        try {
          await fetch(logoutUrl, {
            method: 'POST',
            headers: currentLocal?.accessToken
              ? { Authorization: `Bearer ${currentLocal.accessToken}` }
              : undefined,
          });
        } catch {
          // Ignore network errors on logout
        }
      }
      return;
    }

    // Demo login stays right on the Sign-In modal without any redirect
    if (activeProvider === 'demo') {
      return;
    }

    // Azure AD logout redirect
    if (this.msal && activeProvider === 'azure-ad') {
      const acc = this.msal.getActiveAccount() ?? undefined;
      this.saveKioskQueryBeforeRedirect();
      await this.msal.logoutRedirect({ account: acc });
    }
  }

  /**
   * Silently revalidates the active session (Azure AD via `acquireTokenSilent({ forceRefresh: true })`
   * or Local DB via `auth.local.validateUrl`). If revoked/expired, transitions to `reauth-required`.
   */
  async revalidateSession(forceRefresh = true, targetAccount?: AccountInfo): Promise<boolean> {
    if (!this.config || !this.config.enabled) return true;
    if (this.revalidating) return this.status() === 'authenticated';

    const local = this.localSession();
    if (local) {
      this.revalidating = true;
      try {
        const ok = await this.validateLocalSession(local);
        if (!ok) {
          this.clearStoredLocalSession();
          this.requireReauthentication('Your session expired or was signed out. Please sign in again.');
          return false;
        }
        this.lastValidatedAt.set(new Date());
        return true;
      } finally {
        this.revalidating = false;
      }
    }

    if (!this.msal) return true;
    const acc = targetAccount ?? this.account() ?? this.msal.getActiveAccount();
    if (!acc) {
      this.status.set('login-required');
      return false;
    }

    this.revalidating = true;
    try {
      const result: AuthenticationResult = await this.msal.acquireTokenSilent({
        scopes: this.config.scopes,
        account: acc,
        forceRefresh,
      });
      if (result.account) {
        this.account.set(result.account);
        this.msal.setActiveAccount(result.account);
      }
      this.lastValidatedAt.set(new Date());
      return true;
    } catch (err) {
      if (this.isInteractionRequired(err)) {
        this.requireReauthentication(
          'Your Microsoft session expired or was signed out on another device. Please sign in again.',
        );
        return false;
      }
      console.warn('Silent token revalidation skipped (transient error):', err);
      return this.status() === 'authenticated';
    } finally {
      this.revalidating = false;
    }
  }

  /**
   * Acquires a Bearer access token for your Backend API or Microsoft Graph.
   */
  async getApiAccessToken(customScopes?: string[]): Promise<string | null> {
    if (!this.config || !this.config.enabled) return null;

    const local = this.localSession();
    if (local) {
      return local.accessToken || null;
    }

    if (!this.msal) return null;
    const acc = this.account() ?? this.msal.getActiveAccount();
    if (!acc) {
      this.status.set('login-required');
      return null;
    }

    const scopes =
      customScopes?.length
        ? customScopes
        : this.config.apiScopes.length
          ? this.config.apiScopes
          : this.config.scopes;

    try {
      const result = await this.msal.acquireTokenSilent({
        scopes,
        account: acc,
      });
      return result.accessToken;
    } catch (err) {
      if (this.isInteractionRequired(err)) {
        this.requireReauthentication(
          'Your session needs to be renewed to access the SpaceBoard API. Please sign in again.',
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * Authenticated `fetch()` helper for Backend API & Microsoft Graph calls.
   * Attaches `Authorization: Bearer <access_token>` and retries once on HTTP `401`.
   */
  async authFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    customScopes?: string[],
  ): Promise<Response> {
    const token = await this.getApiAccessToken(customScopes);
    const headers = new Headers(init.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(input, { ...init, headers });
    if (res.status === 401 && this.config?.enabled) {
      const stillValid = await this.revalidateSession(true);
      if (stillValid) {
        const refreshedToken = await this.getApiAccessToken(customScopes);
        if (refreshedToken) {
          headers.set('Authorization', `Bearer ${refreshedToken}`);
          return fetch(input, { ...init, headers });
        }
      }
    }
    return res;
  }

  dispose(): void {
    this.stopRevalidationLoop();
  }

  private activateAzureAccount(acc: AccountInfo): void {
    this.localSession.set(null);
    this.msal?.setActiveAccount(acc);
    this.account.set(acc);
    this.provider.set('azure-ad');
    this.status.set('authenticated');
    this.error.set(null);
    this.lastValidatedAt.set(new Date());
    this.startRevalidationLoop();
  }

  private activateLocalSession(session: StoredLocalSession): void {
    this.account.set(null);
    this.msal?.setActiveAccount(null);
    this.localSession.set(session);
    this.provider.set(session.provider);
    this.saveStoredLocalSession(session);
    this.status.set('authenticated');
    this.error.set(null);
    this.lastValidatedAt.set(new Date());
    this.startRevalidationLoop();
  }

  private async validateLocalSession(session: StoredLocalSession): Promise<boolean> {
    if (session.provider === 'demo') return true;
    const validateUrl = this.config?.local?.validateUrl?.trim();
    if (!validateUrl) return true;
    try {
      const res = await fetch(validateUrl, {
        method: 'GET',
        cache: 'no-cache',
        headers: session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : undefined,
      });
      return res.ok;
    } catch {
      // Transient offline error: keep current session until online
      return true;
    }
  }

  private requireSignIn(reason: string): void {
    this.stopRevalidationLoop();
    this.account.set(null);
    this.localSession.set(null);
    this.provider.set(null);
    this.clearStoredLocalSession();
    this.msal?.setActiveAccount(null);
    this.statusMessage.set(reason);
    this.status.set('login-required');
  }

  private requireReauthentication(reason: string): void {
    this.stopRevalidationLoop();
    this.account.set(null);
    this.localSession.set(null);
    this.provider.set(null);
    this.clearStoredLocalSession();
    this.msal?.setActiveAccount(null);
    this.statusMessage.set(reason);
    this.status.set('reauth-required');
  }

  private isInteractionRequired(err: unknown): boolean {
    if (err instanceof InteractionRequiredAuthError) return true;
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return /interaction_required|login_required|consent_required|invalid_grant|AADSTS50173|AADSTS70008|AADSTS50076|AADSTS50079|AADSTS53003/i.test(
      text,
    );
  }

  private startRevalidationLoop(): void {
    this.stopRevalidationLoop();
    const intervalSec = Math.max(60, this.config?.revalidateIntervalSeconds ?? 300);
    this.revalidateTimer = setInterval(() => {
      if (this.status() === 'authenticated') {
        void this.revalidateSession(true);
      }
    }, intervalSec * 1000);

    if (!this.focusListenerBound && typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleVisibilityOrFocus);
      window.addEventListener('storage', this.handleStorageEvent);
      document.addEventListener('visibilitychange', this.handleVisibilityOrFocus);
      this.focusListenerBound = true;
    }
  }

  private stopRevalidationLoop(): void {
    if (this.revalidateTimer) {
      clearInterval(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }
    if (this.focusListenerBound && typeof window !== 'undefined') {
      window.removeEventListener('focus', this.handleVisibilityOrFocus);
      window.removeEventListener('storage', this.handleStorageEvent);
      document.removeEventListener('visibilitychange', this.handleVisibilityOrFocus);
      this.focusListenerBound = false;
    }
  }

  private saveStoredLocalSession(session: StoredLocalSession): void {
    try {
      localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Ignore storage restrictions
    }
  }

  private readStoredLocalSession(): StoredLocalSession | null {
    try {
      const raw = localStorage.getItem(LOCAL_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredLocalSession;
      return parsed?.user?.name ? parsed : null;
    } catch {
      return null;
    }
  }

  private clearStoredLocalSession(): void {
    try {
      localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions
    }
  }

  private markExplicitSignOut(): void {
    try {
      sessionStorage.setItem(SIGNED_OUT_FLAG_KEY, '1');
      localStorage.setItem(SIGNED_OUT_BROADCAST_KEY, String(Date.now()));
    } catch {
      // Ignore storage restrictions
    }
  }

  private consumeExplicitSignOutFlag(): boolean {
    try {
      const flagged = sessionStorage.getItem(SIGNED_OUT_FLAG_KEY) === '1';
      if (flagged) sessionStorage.removeItem(SIGNED_OUT_FLAG_KEY);
      return flagged;
    } catch {
      return false;
    }
  }

  private clearExplicitSignOutFlag(): void {
    try {
      sessionStorage.removeItem(SIGNED_OUT_FLAG_KEY);
    } catch {
      // Ignore storage restrictions
    }
  }

  /** Preserves `?kioskId=...` across Azure AD redirect login/logout round-trips. */
  private saveKioskQueryBeforeRedirect(): void {
    try {
      if (typeof window !== 'undefined' && window.location.search) {
        sessionStorage.setItem(SAVED_KIOSK_QUERY_KEY, window.location.search);
      }
    } catch {
      // Ignore storage restrictions
    }
  }

  private restoreKioskQueryAfterRedirect(): void {
    try {
      if (typeof window === 'undefined') return;
      const saved = sessionStorage.getItem(SAVED_KIOSK_QUERY_KEY);
      if (!saved) return;
      sessionStorage.removeItem(SAVED_KIOSK_QUERY_KEY);
      if (!window.location.search && window.history?.replaceState) {
        const cleanUrl = `${window.location.origin}${window.location.pathname}${saved}`;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch {
      // Ignore storage restrictions
    }
  }
}
