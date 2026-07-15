/* ── OS / browser notifications ───────────────────────────────────────── */
/* Opt-in notifications when long jobs complete.                          */

const PREF_KEY = 'august-os-notify-enabled';

export class OsNotifyService {
  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  static isEnabled(): boolean {
    try {
      return localStorage.getItem(PREF_KEY) === 'true';
    } catch {
      return false;
    }
  }

  static setEnabled(on: boolean): void {
    try {
      localStorage.setItem(PREF_KEY, on ? 'true' : 'false');
    } catch {
      /* ignore */
    }
  }

  static permission(): NotificationPermission | 'unsupported' {
    if (!this.isSupported()) return 'unsupported';
    return Notification.permission;
  }

  static async ensurePermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  /** Fire an OS notification if the user opted in and granted permission. */
  static async notify(title: string, options?: NotificationOptions): Promise<void> {
    if (!this.isEnabled() || !this.isSupported()) return;
    const ok = await this.ensurePermission();
    if (!ok) return;
    try {
      const n = new Notification(title, {
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        ...options,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* ignore Notification construction errors */
    }
  }

  static async notifyJobComplete(label: string, detail?: string): Promise<void> {
    await this.notify(`August · ${label}`, {
      body: detail || 'Background job finished',
      tag: `august-job-${label}`,
    });
  }
}
