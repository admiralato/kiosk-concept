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

export interface AuthenticatedUser {
  name: string;
  email: string;
  initials: string;
  tenantId: string;
  objectId: string;
}

const SAVED_KIOSK_QUERY_KEY = 'spaceboard_pending_kiosk_search';
const SIGNED_OUT_FLAG_KEY = 'spaceboard_explicit_signout';
const SIGNED_OUT_BROADCAST_KEY = 'spaceboard_signout_broadcast';

/**
 * Azure AD (Microsoft Entra ID) OAuth 2.0 (Authorization Code + PKCE) & OpenID Connect service.
 *
 * Designed for a static Angular SPA paired with a future Backend API:
 * - Uses Public Client PKCE flow in the browser (never embeds `ClientSecret` in frontend code).
 * - Requires users to sign in once via Microsoft Redirect flow (`loginRedirect`).
 * - Silently revalidates tokens on boot, on tab focus/visibility return, and on a periodic timer
 *   using `acquireTokenSilent({ forceRefresh: true })` so if the user logged out or had their
 *   session revoked on another device/browser, SpaceBoard PC detects it and prompts re-login.
 * - Exposes `getApiAccessToken()` and `authFetch()` to attach `Authorization: Bearer <token>`
 *   to future backend API calls.
 */
@Injectable({ providedIn: 'root' })
export class AzureAuthService {
  private msal: PublicClientApplication | null = null;
  private config: AzureAuthConfig | null = null;
  private revalidateTimer?: ReturnType<typeof setInterval>;
  private revalidating = false;
  private focusListenerBound = false;

  readonly status = signal<AuthStatus>('initializing');
  readonly account = signal<AccountInfo | null>(null);
  readonly error = signal<string | null>(null);
  readonly statusMessage = signal<string>('Checking Microsoft Entra ID session...');
  readonly lastValidatedAt = signal<Date | null>(null);

  readonly isAuthenticated = computed(
    () => this.status() === 'authenticated' || this.status() === 'disabled',
  );

  readonly user = computed<AuthenticatedUser | null>(() => {
    const acc = this.account();
    if (!acc) return null;
    const name = acc.name?.trim() || acc.username || 'Signed-in User';
    const email = acc.username || '';
    const parts = name.split(/\s+/).filter(Boolean);
    const initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
        : name.slice(0, 2).toUpperCase();
    return {
      name,
      email,
      initials,
      tenantId: acc.tenantId || '',
      objectId: acc.localAccountId || '',
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
    // If MSAL cache keys were cleared in another tab, verify whether any account remains
    if (this.msal && (!event.key || event.key.startsWith('msal.'))) {
      const remaining = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
      if (!remaining) {
        this.requireSignIn('You have been signed out. Please sign in again to continue.');
      }
    }
  };

  /**
   * Initializes MSAL from runtime `kiosk-config.json`, processes any pending OAuth redirect,
   * and verifies or silently revalidates the user's Entra ID session.
   *
   * Returns `true` if the user is authenticated (or auth is disabled) and the app may proceed.
   */
  async initialize(authConfig: AzureAuthConfig): Promise<boolean> {
    this.config = authConfig;
    this.error.set(null);

    if (!authConfig.enabled || !authConfig.clientId?.trim() || !authConfig.tenantId?.trim()) {
      this.status.set('disabled');
      return true;
    }

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

    try {
      this.status.set('initializing');
      this.statusMessage.set('Connecting to Microsoft Entra ID...');

      this.msal = new PublicClientApplication(msalConfig);
      await this.msal.initialize();

      // 1. Handle return from Azure AD loginRedirect
      const redirectResult = await this.msal.handleRedirectPromise();
      this.restoreKioskQueryAfterRedirect();

      if (redirectResult?.account) {
        this.clearExplicitSignOutFlag();
        this.activateAccount(redirectResult.account);
        return true;
      }

      // If the user explicitly clicked Sign Out, show the Sign-In modal immediately
      // without attempting silent SSO re-login.
      if (this.consumeExplicitSignOutFlag()) {
        this.status.set('login-required');
        this.statusMessage.set('You have been signed out. Sign in with your Microsoft account to continue.');
        return false;
      }

      // 2. Existing cached account -> silently revalidate with Entra ID (forceRefresh: true)
      //    so revocations or logouts on other devices/browsers are detected immediately.
      const existing = this.msal.getActiveAccount() ?? this.msal.getAllAccounts()[0] ?? null;
      if (existing) {
        this.statusMessage.set('Validating your Microsoft session...');
        this.msal.setActiveAccount(existing);
        const stillValid = await this.revalidateSession(true, existing);
        if (stillValid) {
          this.activateAccount(existing);
          return true;
        }
        return false;
      }

      // 3. No local account cached yet -> attempt silent SSO (if browser already has an Entra session)
      try {
        this.statusMessage.set('Checking existing Microsoft single sign-on...');
        const ssoResult = await this.msal.ssoSilent({
          scopes: authConfig.scopes,
        });
        if (ssoResult?.account) {
          this.activateAccount(ssoResult.account);
          return true;
        }
      } catch {
        // Expected when user has not signed in yet; prompt login once.
      }

      this.status.set('login-required');
      this.statusMessage.set('Sign in with your Microsoft account to access SpaceBoard PC.');
      return false;
    } catch (err) {
      console.error('Azure AD initialization error:', err);
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

  /** Signs the user out of this browser and Microsoft Entra ID via redirect. */
  async logout(): Promise<void> {
    this.stopRevalidationLoop();
    const acc = this.account() ?? this.msal?.getActiveAccount() ?? undefined;
    this.account.set(null);
    this.statusMessage.set('You have been signed out. Sign in with your Microsoft account to continue.');
    this.status.set('login-required');
    this.markExplicitSignOut();

    if (!this.msal) return;
    this.saveKioskQueryBeforeRedirect();
    await this.msal.logoutRedirect({
      account: acc,
    });
  }

  /**
   * Silently revalidates the user's OAuth 2.0 token against Entra ID.
   *
   * When `forceRefresh` is true, MSAL exchanges the refresh token with Entra ID rather than
   * returning a locally cached token — allowing detection of sessions revoked or signed out
   * on another device/browser. If Entra ID requires interaction, transitions to `reauth-required`.
   */
  async revalidateSession(forceRefresh = true, targetAccount?: AccountInfo): Promise<boolean> {
    if (!this.msal || !this.config || !this.config.enabled) return true;
    if (this.revalidating) return this.status() === 'authenticated';

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
      // Transient network error while offline: keep current authenticated UI usable until online
      console.warn('Silent token revalidation skipped (transient error):', err);
      return this.status() === 'authenticated';
    } finally {
      this.revalidating = false;
    }
  }

  /**
   * Acquires a Bearer access token for your Backend API.
   * Uses `customScopes` if provided, else `auth.apiScopes` from `kiosk-config.json`, else `auth.scopes`.
   * Automatically triggers re-authentication if the session was revoked.
   */
  async getApiAccessToken(customScopes?: string[]): Promise<string | null> {
    if (!this.msal || !this.config || !this.config.enabled) return null;
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
   * Authenticated `fetch()` helper for future Backend API calls.
   * Attaches `Authorization: Bearer <access_token>` and retries once with `forceRefresh: true`
   * if the API returns HTTP `401 Unauthorized`.
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

  private activateAccount(acc: AccountInfo): void {
    this.msal?.setActiveAccount(acc);
    this.account.set(acc);
    this.status.set('authenticated');
    this.error.set(null);
    this.lastValidatedAt.set(new Date());
    this.startRevalidationLoop();
  }

  private requireSignIn(reason: string): void {
    this.stopRevalidationLoop();
    this.account.set(null);
    this.msal?.setActiveAccount(null);
    this.statusMessage.set(reason);
    this.status.set('login-required');
  }

  private requireReauthentication(reason: string): void {
    this.stopRevalidationLoop();
    this.account.set(null);
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
