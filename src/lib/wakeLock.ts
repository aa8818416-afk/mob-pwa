/**
 * Screen WakeLock Manager to prevent mobile devices from sleeping during tactile sessions
 */

class WakeLockManager {
  private wakeLock: any = null;
  private isSupported: boolean = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.isSupported = 'wakeLock' in navigator;
    }
  }

  public async requestWakeLock(): Promise<boolean> {
    if (typeof window === 'undefined' || !('wakeLock' in navigator)) {
      return false;
    }

    try {
      this.wakeLock = await (navigator as any).wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
      return true;
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
      return false;
    }
  }

  public releaseWakeLock(): void {
    if (this.wakeLock !== null) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }
}

export const wakeLockManager = new WakeLockManager();
