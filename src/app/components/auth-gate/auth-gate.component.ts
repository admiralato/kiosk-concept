import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AzureAuthService,
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_USERNAME,
} from '../../auth/azure-auth.service';

/**
 * Full-screen authentication gate supporting:
 * - Local User Database login (configurable Backend API via `kiosk-config.json`)
 * - Built-in Demo login (`demo` / `demo123` when enabled)
 * - Microsoft Entra ID (Azure AD) OAuth 2.0 + OIDC Redirect login
 */
@Component({
  selector: 'app-auth-gate',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth-gate.component.html',
  styleUrl: './auth-gate.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthGateComponent {
  readonly auth = inject(AzureAuthService);

  /** Emits when an in-page login (Local DB or Demo) succeeds so the shell can boot 3D scenes. */
  readonly authenticated = output<void>();

  readonly loginUsername = signal('');
  readonly loginPassword = signal('');
  readonly demoUsername = DEMO_LOGIN_USERNAME;
  readonly demoPassword = DEMO_LOGIN_PASSWORD;

  signInWithMicrosoft(): void {
    void this.auth.login();
  }

  async signInWithCredentials(event?: Event): Promise<void> {
    event?.preventDefault();
    const ok = await this.auth.loginWithCredentials(this.loginUsername(), this.loginPassword());
    if (ok) {
      this.loginPassword.set('');
      this.authenticated.emit();
    }
  }

  async signInAsDemo(): Promise<void> {
    this.loginUsername.set(DEMO_LOGIN_USERNAME);
    this.loginPassword.set(DEMO_LOGIN_PASSWORD);
    const ok = await this.auth.loginWithCredentials(DEMO_LOGIN_USERNAME, DEMO_LOGIN_PASSWORD);
    if (ok) {
      this.loginPassword.set('');
      this.authenticated.emit();
    }
  }
}
